import React, { useState, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { blobToBase64, splitAudio } from '../utils/audioUtils';

// Giới hạn kích thước tệp an toàn cho inline data (15MB)
const MAX_FILE_SIZE = 15 * 1024 * 1024; 

// Thời gian chờ giữa các lần gửi đoạn file (Chunks) để tránh lỗi Rate Limit
const CHUNK_DELAY_MS = 5000; 
// Thời gian chờ cơ bản khi gặp lỗi Server quá tải (503) để thử lại
const RETRY_DELAY_MS = 5000;

const AudioTranscriber: React.FC = () => {
  // Processing States
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSplitting, setIsSplitting] = useState(false); 
  const [processingStatus, setProcessingStatus] = useState<string>('');
  
  const [transcription, setTranscription] = useState<string>('');
  
  // Analysis State
  const [systemPrompt, setSystemPrompt] = useState("Tóm tắt các điểm chính từ bản phiên âm âm thanh này thành một danh sách ngắn gọn.");
  const [analysis, setAnalysis] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [autoAnalyze, setAutoAnalyze] = useState(true);

  // File Upload State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileParts, setFileParts] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelection = async (file: File) => {
    setTranscription('');
    setAnalysis('');
    setSelectedFile(file);
    setFileParts([]); // Reset parts

    // Nếu file > 15MB, thực hiện chia nhỏ
    if (file.size > MAX_FILE_SIZE) {
        try {
            setIsSplitting(true);
            setProcessingStatus("Đang chuẩn hóa và chia nhỏ tệp lớn...");
            
            // Gọi hàm splitAudio từ utils
            const chunks = await splitAudio(file);
            
            setFileParts(chunks);
            setProcessingStatus(`Đã chia thành ${chunks.length} phần. Sẵn sàng phiên âm.`);
            setIsSplitting(false);
        } catch (error) {
            console.error("Lỗi xử lý file:", error);
            alert("Đã xảy ra lỗi khi cố gắng xử lý tệp âm thanh.");
            setIsSplitting(false);
            setProcessingStatus("");
            setSelectedFile(null);
        }
    } else {
        // File nhỏ, dùng trực tiếp
        setFileParts([file]);
        setProcessingStatus("");
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelection(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileSelection(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
  };

  const processFile = async () => {
    if (selectedFile && fileParts.length > 0) {
        await handleTranscriptionFlow(fileParts);
    }
  };

  const runAnalysis = async (textToAnalyze: string) => {
    if (!textToAnalyze) return;
    
    setIsAnalyzing(true);
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            config: {
                systemInstruction: systemPrompt,
            },
            contents: [{ text: textToAnalyze }]
        });
        setAnalysis(response.text || "Không có phân tích nào được tạo.");
    } catch (error: any) {
        console.error("Lỗi phân tích:", error);
        setAnalysis(`Lỗi trong quá trình phân tích: ${error.message}`);
    } finally {
        setIsAnalyzing(false);
    }
  };

  // Hàm Wrapper để xử lý luồng phiên âm
  const handleTranscriptionFlow = async (parts: File[]) => {
    setIsProcessing(true);
    setAnalysis('');
    
    let fullTranscript = "";
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    try {
        for (let i = 0; i < parts.length; i++) {
            const currentFile = parts[i];
            const partNum = i + 1;
            const total = parts.length;
            
            setProcessingStatus(total > 1 ? `Đang phiên âm phần ${partNum}/${total}...` : "Đang phiên âm...");

            // Delay giữa các request để tránh Rate Limit của Free Tier
            if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
            }

            // Gọi API phiên âm cho từng phần
            const partText = await transcribeSingleFile(ai, currentFile);
            
            if (partText) {
                fullTranscript += (fullTranscript ? "\n\n" : "") + partText;
                // Cập nhật UI real-time để người dùng thấy tiến độ
                setTranscription(fullTranscript); 
            }
        }

        if (!fullTranscript) {
            setTranscription("Không tạo được bản phiên âm.");
        } else {
            // Sau khi xong hết thì chạy analysis
            if (autoAnalyze) {
                setProcessingStatus("Đang phân tích nội dung...");
                await runAnalysis(fullTranscript);
            }
        }

    } catch (error: any) {
        console.error("Lỗi quy trình phiên âm:", error);
        setTranscription(prev => prev + `\n\n[Lỗi dừng đột ngột]: ${error.message}`);
    } finally {
        setIsProcessing(false);
        setProcessingStatus("");
    }
  };

  // Hàm gọi API phiên âm cho 1 file duy nhất (đã được đảm bảo < 15MB)
  const transcribeSingleFile = async (ai: GoogleGenAI, file: File): Promise<string> => {
      try {
        const base64Data = await blobToBase64(file);
        
        let mimeType = file.type;
        if (!mimeType || mimeType === '') mimeType = 'audio/wav'; // Mặc định wav vì code split trả về wav

        const maxRetries = 3;
        let attempt = 0;

        while (attempt < maxRetries) {
            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: {
                    parts: [
                        {
                        inlineData: {
                            mimeType: mimeType,
                            data: base64Data
                        }
                        },
                        { text: "Phiên âm âm thanh này một cách chính xác. Chỉ trả về văn bản đã phiên âm, không thêm lời dẫn." }
                    ]
                    }
                });
                return response.text || "";
            } catch (error: any) {
                const errorMsg = error.message || "";
                // Kiểm tra nếu lỗi là 503 Service Unavailable hoặc Overloaded hoặc 429 Too Many Requests
                const isOverloaded = errorMsg.includes("503") || errorMsg.includes("overloaded") || errorMsg.includes("UNAVAILABLE") || errorMsg.includes("429");
                
                if (isOverloaded && attempt < maxRetries - 1) {
                    attempt++;
                    const waitTime = RETRY_DELAY_MS * attempt; // Tăng thời gian chờ khi retry
                    console.log(`Model đang bận (503/429), đang thử lại lần ${attempt} sau ${waitTime/1000}s...`);
                    setProcessingStatus(`Hệ thống bận, đang thử lại (${attempt}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }

                console.error(`Lỗi part ${file.name}:`, error);
                throw error; // Ném lỗi ra ngoài để dừng loop hoặc xử lý
            }
        }
        return "";
      } catch (error: any) {
          console.error(`Lỗi part ${file.name}:`, error);
          throw error; // Ném lỗi ra ngoài để dừng loop hoặc xử lý
      }
  };

  return (
    <div className="flex flex-col h-full w-full max-w-6xl mx-auto p-4 animate-fade-in">
       <div className="mb-4 text-center">
        <h2 className="text-2xl font-bold text-white mb-1">Phiên âm & Phân tích Âm thanh</h2>
        <p className="text-slate-400 text-sm">Hỗ trợ file lớn (tự động chia nhỏ và xử lý tuần tự).</p>
      </div>

      <div className="flex flex-col md:flex-row gap-6 h-full min-h-0">
        
        {/* Left Column: Input & Settings */}
        <div className="flex flex-col md:w-1/3 gap-4">
            
            {/* Input Section */}
            <div className="bg-slate-800/50 rounded-2xl border border-slate-700 overflow-hidden flex-shrink-0">
                <div className="p-4 bg-slate-700/30 border-b border-slate-700">
                    <h3 className="text-sm font-semibold text-white">Tải tệp âm thanh</h3>
                </div>

                <div className="flex flex-col items-center justify-center p-6 min-h-[250px]">
                    <div 
                        className="w-full h-full flex flex-col items-center justify-center"
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                    >
                        <input 
                            type="file" 
                            ref={fileInputRef} 
                            onChange={handleFileChange} 
                            accept="audio/*,video/mp4,video/mpeg,video/webm" 
                            className="hidden" 
                        />
                        
                        {isSplitting ? (
                            <div className="flex flex-col items-center justify-center text-slate-300">
                                <svg className="animate-spin h-10 w-10 text-blue-500 mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                <p className="font-medium text-center">{processingStatus}</p>
                                <p className="text-xs text-slate-500 mt-1">Quá trình này có thể mất vài phút với tệp lớn</p>
                            </div>
                        ) : !selectedFile ? (
                            <div 
                                onClick={() => fileInputRef.current?.click()}
                                className="w-full h-56 border-2 border-dashed border-slate-600 rounded-xl flex flex-col items-center justify-center cursor-pointer hover:border-blue-500 hover:bg-slate-800/50 transition-all group"
                            >
                                <div className="p-3 bg-slate-700 rounded-full mb-3 group-hover:scale-110 transition-transform">
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                    </svg>
                                </div>
                                <p className="text-slate-300 text-sm font-medium">Nhấp hoặc kéo thả tệp</p>
                                <p className="text-[10px] text-slate-500 mt-1 text-center px-4">Hỗ trợ mọi file âm thanh/video<br/>Tự động chia nhỏ file lớn</p>
                            </div>
                        ) : (
                            <div className="w-full flex flex-col items-center">
                                <div className="w-full bg-slate-700/50 p-3 rounded-xl border border-slate-600 mb-4 flex items-center gap-3">
                                    <div className="p-2 bg-blue-500/20 rounded-lg">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 3-2 3-2zm0 0v-8" />
                                        </svg>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-slate-200 truncate">{selectedFile.name}</p>
                                        <p className="text-xs text-slate-500">
                                            {(selectedFile.size / 1024 / 1024).toFixed(2)} MB 
                                            {fileParts.length > 1 && ` • Chia thành ${fileParts.length} phần`}
                                        </p>
                                    </div>
                                    <button onClick={() => { setSelectedFile(null); setFileParts([]); setTranscription(''); setAnalysis(''); }} className="text-slate-500 hover:text-red-400">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                                        </svg>
                                    </button>
                                </div>
                                
                                <button
                                    onClick={processFile}
                                    disabled={isProcessing}
                                    className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-semibold shadow-lg shadow-blue-600/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isProcessing ? (
                                            <>
                                            <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                            </svg>
                                            <span>{processingStatus || "Đang xử lý..."}</span>
                                            </>
                                    ) : (
                                        <>
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                            <span>Bắt đầu phiên âm</span>
                                        </>
                                    )}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Analysis Settings */}
            <div className="bg-slate-800/50 rounded-2xl border border-slate-700 p-4 flex-1 flex flex-col">
                <div className="flex items-center justify-between mb-3">
                     <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-purple-400" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" />
                        </svg>
                        Lời nhắc Hệ thống Phân tích
                     </h3>
                     <div className="flex items-center gap-2">
                         <label className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Tự động chạy</label>
                         <button 
                            onClick={() => setAutoAnalyze(!autoAnalyze)}
                            className={`w-9 h-5 rounded-full transition-colors relative ${autoAnalyze ? 'bg-green-500' : 'bg-slate-600'}`}
                         >
                             <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-transform ${autoAnalyze ? 'left-5' : 'left-1'}`} />
                         </button>
                     </div>
                </div>
                <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    className="w-full flex-1 bg-slate-900/50 text-slate-300 text-sm p-3 rounded-xl border border-slate-600 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none resize-none"
                    placeholder="Nhập hướng dẫn để phân tích bản phiên âm (ví dụ: Tóm tắt, Trích xuất ngày tháng, Dịch)"
                />
                 {!autoAnalyze && transcription && !isAnalyzing && !isProcessing && (
                    <button 
                        onClick={() => runAnalysis(transcription)}
                        className="mt-3 w-full py-2 bg-purple-600/20 border border-purple-500/30 hover:bg-purple-600/30 text-purple-300 rounded-lg text-sm font-medium transition-all"
                    >
                        Chạy Phân tích
                    </button>
                 )}
            </div>
        </div>

        {/* Right Column: Results */}
        <div className="flex-1 flex flex-col gap-4 min-h-0 overflow-hidden">
            
            {/* Transcription Result */}
            <div className={`bg-slate-800/50 rounded-2xl border border-slate-700 p-5 flex flex-col transition-all duration-500 ${analysis ? 'h-1/2' : 'h-full'}`}>
                <div className="flex items-center justify-between mb-3 flex-shrink-0">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Bản phiên âm
                    </h3>
                    {transcription && (
                        <button 
                            onClick={() => navigator.clipboard.writeText(transcription)}
                            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
                            title="Sao chép văn bản"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                        </button>
                    )}
                </div>
                
                <div className="flex-1 bg-slate-900/50 rounded-xl border border-slate-700/50 overflow-y-auto custom-scrollbar p-4">
                    {transcription ? (
                        <p className="text-slate-200 leading-relaxed whitespace-pre-wrap text-sm md:text-base">{transcription}</p>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-slate-600">
                            <p className="text-sm">Chưa có bản phiên âm nào</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Analysis Result */}
            {(analysis || isAnalyzing) && (
                <div className="flex-1 bg-gradient-to-br from-slate-800/50 to-purple-900/10 rounded-2xl border border-slate-700 p-5 flex flex-col animate-fade-in h-1/2">
                     <div className="flex items-center justify-between mb-3 flex-shrink-0">
                        <h3 className="text-xs font-bold text-purple-400 uppercase tracking-wider flex items-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M5 2a1 1 0 011 1v1h1a1 1 0 010 2H6v1a1 1 0 01-2 0V6H3a1 1 0 010-2h1V3a1 1 0 011-1zm0 5a1 1 0 011 1v1h1a1 1 0 110 2H6v1a1 1 0 11-2 0v-1H3a1 1 0 110-2h1V8a1 1 0 011-1zm5-5a1 1 0 11-2 0 1 1 0 012 0zm5 0a1 1 0 11-2 0 1 1 0 012 0z" clipRule="evenodd" />
                            </svg>
                            Phân tích AI
                        </h3>
                        {analysis && (
                            <button 
                                onClick={() => navigator.clipboard.writeText(analysis)}
                                className="p-1.5 text-slate-400 hover:text-purple-300 hover:bg-purple-900/30 rounded-lg transition-colors"
                                title="Sao chép phân tích"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                            </button>
                        )}
                    </div>
                    
                    <div className="flex-1 bg-slate-900/80 rounded-xl border border-slate-700/50 overflow-y-auto custom-scrollbar p-4 shadow-inner">
                        {isAnalyzing && !analysis ? (
                            <div className="flex items-center justify-center h-full gap-3">
                                <svg className="animate-spin h-5 w-5 text-purple-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                <span className="text-sm text-purple-300 animate-pulse">Đang phân tích với Lời nhắc Hệ thống...</span>
                            </div>
                        ) : (
                            <div className="markdown-body text-slate-200 text-sm md:text-base leading-relaxed">
                                {analysis.split('\n').map((line, i) => (
                                    <p key={i} className="mb-2">{line}</p>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

        </div>
      </div>
    </div>
  );
};

export default AudioTranscriber;