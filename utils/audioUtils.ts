import { Blob } from '@google/genai';

export function encodeAudio(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decodeAudio(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export function createPcmBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encodeAudio(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

export async function blobToBase64(blob: globalThis.Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      } else {
        reject(new Error('Failed to convert blob to base64'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// === CÁC HÀM XỬ LÝ FILE ÂM THANH ===

const TARGET_SAMPLE_RATE = 16000;
const TARGET_CHANNELS = 1; // Mono

/**
 * Helper: Lấy AudioBuffer từ File
 */
async function getAudioBufferFromFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return await audioCtx.decodeAudioData(arrayBuffer);
}

/**
 * Helper: Chuyển đổi một phần dữ liệu Audio (Float32Array) thành WAV File
 */
function audioDataToWavFile(channelData: Float32Array, sampleRate: number, fileName: string): File {
  const buffer = new AudioBuffer({
    length: channelData.length,
    numberOfChannels: 1,
    sampleRate: sampleRate
  });
  buffer.copyToChannel(channelData, 0);
  const blob = audioBufferToWav(buffer);
  return new File([blob], fileName, { type: 'audio/wav' });
}

/**
 * Nén file âm thanh: Downsample về 16kHz Mono.
 */
export async function compressAudio(file: File): Promise<File> {
  const audioBuffer = await getAudioBufferFromFile(file);
  
  // Render lại ở 16kHz Mono bằng OfflineAudioContext
  const offlineCtx = new OfflineAudioContext(
    TARGET_CHANNELS,
    audioBuffer.duration * TARGET_SAMPLE_RATE, 
    TARGET_SAMPLE_RATE
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start();

  const renderedBuffer = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWav(renderedBuffer);
  
  return new File([wavBlob], `compressed_${file.name.replace(/\.[^/.]+$/, "")}.wav`, { 
    type: 'audio/wav' 
  });
}

/**
 * Chia nhỏ file âm thanh thành các đoạn khoảng 5 phút (đảm bảo < 10MB cho mỗi đoạn WAV 16kHz mono)
 */
export async function splitAudio(file: File): Promise<File[]> {
  const audioBuffer = await getAudioBufferFromFile(file);
  
  // 16kHz * 16bit (2 bytes) * 1 channel = 32000 bytes/sec
  // 5 phút = 300 giây = 9,600,000 bytes (~9.1 MB) -> An toàn cho giới hạn 15MB
  const CHUNK_DURATION_SEC = 300; 
  
  // Nếu file gốc ngắn hơn chunk duration, chỉ cần nén và trả về
  if (audioBuffer.duration <= CHUNK_DURATION_SEC) {
    return [await compressAudio(file)];
  }

  // Logic cắt file: Chúng ta sẽ lấy dữ liệu PCM, downsample nó (nếu cần - ở đây ta giả định cần chuẩn hóa về 16kHz để kiểm soát dung lượng)
  // Sử dụng OfflineAudioContext để vừa resample vừa lấy dữ liệu sạch
  const totalDuration = audioBuffer.duration;
  const chunks: File[] = [];
  const baseName = file.name.replace(/\.[^/.]+$/, "");
  
  // OfflineContext cho toàn bộ file để lấy dữ liệu 16kHz Mono trước
  const offlineCtx = new OfflineAudioContext(
    TARGET_CHANNELS,
    totalDuration * TARGET_SAMPLE_RATE,
    TARGET_SAMPLE_RATE
  );
  
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start();
  
  const resampledBuffer = await offlineCtx.startRendering();
  const pcmData = resampledBuffer.getChannelData(0); // Lấy dữ liệu Mono
  
  const samplesPerChunk = CHUNK_DURATION_SEC * TARGET_SAMPLE_RATE;
  let startSample = 0;
  let partIndex = 1;

  while (startSample < pcmData.length) {
    const endSample = Math.min(startSample + samplesPerChunk, pcmData.length);
    const chunkData = pcmData.slice(startSample, endSample);
    
    // Tạo File WAV từ chunk data
    const chunkFile = audioDataToWavFile(
      chunkData, 
      TARGET_SAMPLE_RATE, 
      `${baseName}_part${partIndex}.wav`
    );
    
    chunks.push(chunkFile);
    
    startSample = endSample;
    partIndex++;
  }

  return chunks;
}


/**
 * Chuyển đổi AudioBuffer thành WAV Blob (16-bit PCM)
 */
function audioBufferToWav(buffer: AudioBuffer): globalThis.Blob {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferOut = new ArrayBuffer(length);
  const view = new DataView(bufferOut);
  const channels = [];
  let i;
  let sample;
  let offset = 0;
  let pos = 0;

  // write WAVE header
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"

  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this function)

  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // write interleaved data
  for (i = 0; i < buffer.numberOfChannels; i++)
    channels.push(buffer.getChannelData(i));

  while (pos < buffer.length) {
    for (i = 0; i < numOfChan; i++) {
      // clamp
      sample = Math.max(-1, Math.min(1, channels[i][pos])); 
      // scale to 16-bit signed int
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; 
      view.setInt16(44 + offset, sample, true);
      offset += 2;
    }
    pos++;
  }

  return new globalThis.Blob([bufferOut], { type: 'audio/wav' });

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}