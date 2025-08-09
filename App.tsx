import React, { useState, useRef, useCallback } from 'react';

const MicIcon = ({ className }: { className?: string }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm0 12a5 5 0 0 1-5-5V5a5 5 0 0 1 10 0v6a5 5 0 0 1-5 5Z" />
    <path d="M19 11a1 1 0 1 0-2 0v1a6 6 0 0 1-12 0v-1a1 1 0 1 0-2 0v1a8 8 0 0 0 7 7.93V22a1 1 0 1 0 2 0v-2.07A8 8 0 0 0 19 12v-1Z" />
  </svg>
);

const StopIcon = ({ className }: { className?: string }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
        <path fillRule="evenodd" d="M4.5 7.5a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9Z" clipRule="evenodd" />
    </svg>
);

// --- Audio Worklet Code ---
// This code runs in a separate audio thread to avoid blocking the UI.
// It uses a ring buffer to smooth out audio playback, reducing choppiness.
const audioWorkletCode = `
class RingBuffer {
  constructor(length) {
    this.buffer = new Float32Array(length);
    this.length = length;
    this.writeIndex = 0;
    this.readIndex = 0;
    this.samplesAvailable = 0;
  }

  write(data) {
    // If we're about to overflow, we make space by dropping the oldest samples.
    if (this.samplesAvailable + data.length > this.length) {
      const spaceNeeded = (this.samplesAvailable + data.length) - this.length;
      this.readIndex = (this.readIndex + spaceNeeded) % this.length;
      this.samplesAvailable -= spaceNeeded;
    }
    
    // Write the new data into the buffer.
    for (let i = 0; i < data.length; i++) {
      this.buffer[(this.writeIndex + i) % this.length] = data[i];
    }
    this.writeIndex = (this.writeIndex + data.length) % this.length;
    this.samplesAvailable += data.length;
  }

  read(data) {
    const toRead = Math.min(data.length, this.samplesAvailable);
    for (let i = 0; i < toRead; i++) {
      data[i] = this.buffer[(this.readIndex + i) % this.length];
    }
    this.readIndex = (this.readIndex + toRead) % this.length;
    this.samplesAvailable -= toRead;
    
    // Fill the rest of the output with silence if the buffer runs empty.
    for (let i = toRead; i < data.length; i++) {
      data[i] = 0;
    }
  }
}

class SmootherProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = [];
    this.initialized = false;
    // A buffer of 4096 samples introduces a small delay but significantly improves smoothness.
    // At a 48kHz sample rate, this is about 85ms of latency.
    this.bufferSize = 4096;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!this.initialized && input.length > 0) {
        for (let i = 0; i < input.length; i++) {
            this.buffers.push(new RingBuffer(this.bufferSize)); 
        }
        this.initialized = true;
    }
    
    if(!this.initialized){
        return true; // Not ready, but keep processor alive.
    }

    for (let channel = 0; channel < input.length; channel++) {
      if (input[channel]) {
        this.buffers[channel].write(input[channel]);
      }
    }

    for (let channel = 0; channel < output.length; channel++) {
       if (this.buffers[channel]) {
        this.buffers[channel].read(output[channel]);
      }
    }

    return true; // Keep processor alive.
  }
}

registerProcessor('smoother-processor', SmootherProcessor);
`;

const workletURL = URL.createObjectURL(new Blob([audioWorkletCode], { type: 'application/javascript' }));


export default function App() {
  const [isListening, setIsListening] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for Web Audio API objects to manage their lifecycle
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  const stopStreaming = useCallback(async () => {
    // Stop the microphone track
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    
    // Disconnect the audio graph to stop processing
    if (sourceNodeRef.current) sourceNodeRef.current.disconnect();
    if (workletNodeRef.current) workletNodeRef.current.disconnect();
    
    // Close the audio context to release system resources
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close();
    }

    // Clear all refs
    streamRef.current = null;
    audioContextRef.current = null;
    sourceNodeRef.current = null;
    workletNodeRef.current = null;
    
    setIsListening(false);
  }, []);


  const startStreaming = useCallback(async () => {
    setError(null);
    if (isListening) return;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Media Devices API उपलब्ध नहीं है।');
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          // Disabling these can provide a cleaner audio stream to the worklet
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      streamRef.current = stream;

      const context = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = context;

      // The AudioContext must be running before we can add a module
      if(context.state === 'suspended') {
        await context.resume();
      }

      await context.audioWorklet.addModule(workletURL);

      const source = context.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      
      const smootherNode = new AudioWorkletNode(context, 'smoother-processor');
      workletNodeRef.current = smootherNode;

      // Connect the graph: Mic -> Worklet -> Speakers
      source.connect(smootherNode);
      smootherNode.connect(context.destination);
      
      setIsListening(true);
    } catch (err) {
      console.error("Error starting audio stream:", err);
      let errorMessage = "माइक्रोफ़ोन एक्सेस नहीं हो सका।";
      if (err instanceof Error) {
        if(err.name === 'NotAllowedError') {
          errorMessage = "माइक्रोफ़ोन का एक्सेस नहीं मिला। कृपया अपनी ब्राउज़र सेटिंग्स में माइक्रोफ़ोन एक्सेस की अनुमति दें।";
        } else if (err.name === 'NotFoundError') {
          errorMessage = "कोई माइक्रोफ़ोन नहीं मिला। कृपया माइक्रोफ़ोन कनेक्ट करें और फिर से प्रयास करें।";
        } else {
            errorMessage = err.message;
        }
      }
      setError(errorMessage);
      setIsListening(false);
      await stopStreaming(); // Clean up any partial setup
    }
  }, [isListening, stopStreaming]);

  const handleToggleListening = useCallback(() => {
    if (isListening) {
      stopStreaming();
    } else {
      startStreaming();
    }
  }, [isListening, startStreaming, stopStreaming]);

  // Effect to clean up on component unmount
  React.useEffect(() => {
    return () => {
      stopStreaming();
      URL.revokeObjectURL(workletURL); // Clean up the Blob URL to prevent memory leaks
    };
  }, [stopStreaming]);


  return (
    <main className="bg-gray-900 text-white min-h-screen flex flex-col items-center justify-center font-sans p-4 antialiased">
      <div className="w-full max-w-md mx-auto">
        <div className="bg-gray-800/50 backdrop-blur-sm border border-cyan-500/20 rounded-3xl shadow-2xl shadow-cyan-900/20 p-8 text-center transition-all duration-300">
          
          <div className="flex justify-center items-center mb-4">
              <MicIcon className="w-10 h-10 text-cyan-400" />
          </div>

          <h1 className="text-3xl md:text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-teal-400 mb-2">
            Audio Loopback
          </h1>
          <p className="text-gray-400 mb-8">
            Apni aawaz ko real-time mein suno.
          </p>

          <button
            onClick={handleToggleListening}
            className={`w-full flex items-center justify-center gap-3 text-lg font-bold py-4 px-6 rounded-full transition-all duration-300 ease-in-out focus:outline-none focus:ring-4 focus:ring-opacity-50
            ${
              isListening
                ? 'bg-red-600 hover:bg-red-700 text-white focus:ring-red-500 shadow-lg shadow-red-500/20'
                : 'bg-cyan-500 hover:bg-cyan-600 text-gray-900 focus:ring-cyan-400 shadow-lg shadow-cyan-500/20'
            }`}
          >
            {isListening ? (
                <>
                    <StopIcon className="w-6 h-6" />
                    <span>Suno Band Karo</span>
                </>
            ) : (
                <>
                    <MicIcon className="w-6 h-6" />
                    <span>Sunna Shuru Karo</span>
                </>
            )}
          </button>

          <div className="h-16 mt-6 flex items-center justify-center">
            {error ? (
                <p className="text-red-400 text-sm">{error}</p>
            ) : (
                <div className="flex items-center space-x-3">
                    <div className={`h-3 w-3 rounded-full transition-colors duration-300 ${isListening ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`}></div>
                    <span className="text-gray-400">
                        {isListening ? 'Aapki aawaz live hai...' : 'Abhi band hai'}
                    </span>
                </div>
            )}
          </div>

        </div>
        <footer className="text-center mt-8 text-gray-600 text-sm">
            Powered by React & TailwindCSS
        </footer>
      </div>
      {/* The <audio> element is removed, as playback is now handled by the Web Audio API */}
    </main>
  );
}
