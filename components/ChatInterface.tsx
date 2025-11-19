import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Chat, GenerateContentResponse } from '@google/genai';
import { Message } from '../types';

const ChatInterface: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const chatSessionRef = useRef<Chat | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const initChat = () => {
    if (!chatSessionRef.current) {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        // Using gemini-flash-lite-latest as per guideline for "Flash Lite"
        chatSessionRef.current = ai.chats.create({
            model: 'gemini-flash-lite-latest',
            config: {
                systemInstruction: "You are a fast, helpful assistant. Use short, concise answers."
            }
        });
    }
  };

  useEffect(() => {
    initChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    if (!inputText.trim() || isLoading || !chatSessionRef.current) return;

    const userMsg: Message = {
      role: 'user',
      text: inputText,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMsg]);
    setInputText('');
    setIsLoading(true);

    try {
      const resultStream = await chatSessionRef.current.sendMessageStream({ message: inputText });
      
      let fullResponseText = '';
      
      // Add placeholder for model response
      const modelMsgTimestamp = new Date();
      setMessages(prev => [
          ...prev, 
          { role: 'model', text: '', timestamp: modelMsgTimestamp }
      ]);

      for await (const chunk of resultStream) {
          const c = chunk as GenerateContentResponse;
          const text = c.text || '';
          fullResponseText += text;
          
          setMessages(prev => {
             const newHistory = [...prev];
             const lastMsg = newHistory[newHistory.length - 1];
             if (lastMsg.role === 'model' && lastMsg.timestamp === modelMsgTimestamp) {
                 lastMsg.text = fullResponseText;
             }
             return newHistory;
          });
      }
      
    } catch (error) {
      console.error("Chat error:", error);
      setMessages(prev => [...prev, { role: 'model', text: "Error generating response.", timestamp: new Date() }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-full w-full max-w-3xl mx-auto bg-slate-900 border-x border-slate-800 shadow-2xl animate-fade-in">
      {/* Header */}
      <div className="p-4 border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full bg-green-500 animate-pulse"></div>
            <div>
                <h2 className="font-bold text-slate-100">Fast Chat</h2>
                <p className="text-xs text-slate-500">Powered by <code>gemini-flash-lite</code></p>
            </div>
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide">
        {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-slate-600 opacity-60">
                 <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                <p>Start a low-latency conversation.</p>
            </div>
        )}
        
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
             <div className={`max-w-[80%] rounded-2xl px-5 py-3 text-sm leading-relaxed shadow-sm ${
                 msg.role === 'user' 
                 ? 'bg-blue-600 text-white rounded-br-none' 
                 : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700'
             }`}>
                {msg.text || (isLoading && idx === messages.length - 1 ? <span className="animate-pulse">...</span> : '')}
             </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-4 border-t border-slate-800 bg-slate-900">
        <div className="relative flex items-end gap-2 bg-slate-800 p-2 rounded-xl border border-slate-700 focus-within:border-blue-500 transition-colors">
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="w-full bg-transparent text-slate-200 p-2 resize-none outline-none max-h-32 placeholder-slate-500 text-sm scrollbar-hide"
            rows={1}
            style={{ minHeight: '44px' }}
          />
          <button
            onClick={sendMessage}
            disabled={!inputText.trim() || isLoading}
            className="p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 mb-0.5"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          </button>
        </div>
        <div className="text-center mt-2 text-[10px] text-slate-600">
             Low latency mode active
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;