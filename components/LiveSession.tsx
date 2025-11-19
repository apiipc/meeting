import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createPcmBlob, decodeAudio, decodeAudioData } from '../utils/audioUtils';
import AudioVisualizer from './AudioVisualizer';

// Model definition
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

const LiveSession: React.FC = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | undefined>(undefined);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');

  // Audio Context Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // State for playback synchronization
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Session management
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const activeSessionRef = useRef<any>(null);

  const startSession = async () => {
    try {
      setError(null);
      setStatus('connecting');
      
      // 1. Get Microphone Access
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStream(mediaStream);

      // 2. Initialize Audio Contexts
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContextClass({ sampleRate: 24000 });

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      // 3. Connect to Live API
      sessionPromiseRef.current = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            console.log('Live API Connected');
            setStatus('connected');
            setIsConnected(true);
            setupAudioStreaming(mediaStream);
          },
          onmessage: async (message: LiveServerMessage) => {
            await handleServerMessage(message);
          },
          onclose: () => {
            console.log('Live API Closed');
            stopSession();
          },
          onerror: (e: ErrorEvent) => {
            console.error('Live API Error', e);
            setError("Connection error. Please try again.");
            stopSession();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          systemInstruction: "You are a helpful, witty, and concise AI assistant. Keep responses brief and conversational."
        }
      });

      // Store session for cleanup
      const session = await sessionPromiseRef.current;
      activeSessionRef.current = session;

    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to start live session");
      setStatus('disconnected');
    }
  };

  const setupAudioStreaming = (mediaStream: MediaStream) => {
    if (!inputAudioContextRef.current) return;

    const ctx = inputAudioContextRef.current;
    const source = ctx.createMediaStreamSource(mediaStream);
    // Buffer size 4096, 1 input channel, 1 output channel
    const processor = ctx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcmBlob = createPcmBlob(inputData);
      
      if (sessionPromiseRef.current) {
        sessionPromiseRef.current.then(session => {
          session.sendRealtimeInput({ media: pcmBlob });
        });
      }
    };

    source.connect(processor);
    processor.connect(ctx.destination);

    sourceRef.current = source;
    scriptProcessorRef.current = processor;
  };

  const handleServerMessage = async (message: LiveServerMessage) => {
    const outputCtx = outputAudioContextRef.current;
    if (!outputCtx) return;

    // Handle interruption
    const interrupted = message.serverContent?.interrupted;
    if (interrupted) {
      console.log("Interrupted");
      sourcesRef.current.forEach(src => {
        try { src.stop(); } catch (e) { /* ignore */ }
      });
      sourcesRef.current.clear();
      nextStartTimeRef.current = 0;
    }

    // Handle audio data
    const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      try {
        // Ensure smooth playback timing
        const currentTime = outputCtx.currentTime;
        if (nextStartTimeRef.current < currentTime) {
            nextStartTimeRef.current = currentTime;
        }

        const audioBytes = decodeAudio(base64Audio);
        const audioBuffer = await decodeAudioData(audioBytes, outputCtx, 24000, 1);
        
        const source = outputCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(outputCtx.destination);
        
        source.onended = () => {
          sourcesRef.current.delete(source);
        };

        source.start(nextStartTimeRef.current);
        sourcesRef.current.add(source);
        
        nextStartTimeRef.current += audioBuffer.duration;
      } catch (e) {
        console.error("Error processing audio message", e);
      }
    }
  };

  const stopSession = async () => {
    setStatus('disconnected');
    setIsConnected(false);

    // 1. Stop recording/processing
    if (sourceRef.current) sourceRef.current.disconnect();
    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current.onaudioprocess = null;
    }

    // 2. Close contexts
    if (inputAudioContextRef.current) await inputAudioContextRef.current.close();
    if (outputAudioContextRef.current) await outputAudioContextRef.current.close();
    inputAudioContextRef.current = null;
    outputAudioContextRef.current = null;

    // 3. Stop playback
    sourcesRef.current.forEach(s => s.stop());
    sourcesRef.current.clear();

    // 4. Stop Media Stream
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      setStream(undefined);
    }

    // 5. Close Session
    if (activeSessionRef.current) {
        // There is no explicit close() on the session object in the new SDK, 
        // but disconnects happen when the WebSocket is closed or garbage collected.
        // However, the prompt guide mentions `session.close()` which might be available on the session object if returned by `connect`.
        // Checking types, the SDK example uses `onclose` callback but doesn't explicitly show `session.close()` in the *usage* examples for cleanup, 
        // BUT the rules say "When the conversation is finished, use session.close()".
        // We will attempt it safely.
        try {
             // @ts-ignore
            activeSessionRef.current.close?.();
        } catch (e) {
            console.warn("Could not close session explicitly", e);
        }
        activeSessionRef.current = null;
    }
    sessionPromiseRef.current = null;
    nextStartTimeRef.current = 0;
  };

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      stopSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-6 space-y-8 animate-fade-in">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400">
          Gemini Live
        </h2>
        <p className="text-slate-400 max-w-md mx-auto">
          Experience real-time, low-latency voice conversation with Gemini 2.5 Native Audio.
        </p>
      </div>

      <div className="relative w-full max-w-md h-48 bg-slate-900/50 rounded-2xl border border-slate-700 flex items-center justify-center overflow-hidden shadow-2xl">
         {/* Visualizer or Placeholder */}
         {isConnected ? (
           <AudioVisualizer stream={stream} isActive={isConnected} />
         ) : (
           <div className="flex flex-col items-center text-slate-600">
             <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mb-2 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
             </svg>
             <span className="text-sm font-medium">Ready to Connect</span>
           </div>
         )}

         {/* Status Indicator */}
         <div className={`absolute top-4 right-4 flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-bold ${
           status === 'connected' ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
           status === 'connecting' ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' :
           'bg-slate-700 text-slate-400'
         }`}>
           <div className={`w-2 h-2 rounded-full ${
             status === 'connected' ? 'bg-green-400 animate-pulse' :
             status === 'connecting' ? 'bg-yellow-400 animate-ping' :
             'bg-slate-400'
           }`}></div>
           <span className="uppercase">{status}</span>
         </div>
      </div>

      <div className="flex flex-col items-center space-y-4 w-full max-w-md">
        {error && (
            <div className="w-full p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg text-center">
                {error}
            </div>
        )}

        {!isConnected ? (
          <button
            onClick={startSession}
            disabled={status === 'connecting'}
            className="group relative w-full py-4 px-6 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 rounded-xl font-semibold text-white shadow-lg hover:shadow-blue-500/25 transition-all disabled:opacity-70 disabled:cursor-not-allowed overflow-hidden"
          >
            <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <span className="relative flex items-center justify-center gap-2">
              {status === 'connecting' ? (
                  <>
                    <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Initializing...
                  </>
              ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Start Live Conversation
                  </>
              )}
            </span>
          </button>
        ) : (
          <button
            onClick={stopSession}
            className="w-full py-4 px-6 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 text-red-400 rounded-xl font-semibold transition-all"
          >
            End Session
          </button>
        )}
      </div>
      
      <div className="text-xs text-slate-500 text-center max-w-xs">
        Ensure you are in a quiet environment for the best experience. <br/>
        Uses <code>{MODEL_NAME}</code>
      </div>
    </div>
  );
};

export default LiveSession;