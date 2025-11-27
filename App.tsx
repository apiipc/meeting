import React from 'react';
import AudioTranscriber from './components/AudioTranscriber';

const App: React.FC = () => {
  return (
    <div className="flex flex-col h-screen w-full bg-slate-950 overflow-hidden">
      <header className="flex items-center gap-3 px-6 py-4 bg-slate-900/80 border-b border-slate-800 backdrop-blur-md sticky top-0 z-50">
        <div className="h-8 w-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
             <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
        </div>
        <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">Gemini Phiên Âm</h1>
      </header>
      
      <main className="flex-1 relative overflow-hidden">
        {/* Background ambient effects */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl -translate-y-1/2 pointer-events-none"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl translate-y-1/2 pointer-events-none"></div>

        <div className="relative h-full w-full flex flex-col">
          <AudioTranscriber />
        </div>
      </main>
    </div>
  );
};

export default App;