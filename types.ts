export enum AppMode {
  LIVE = 'LIVE',
  TRANSCRIBE = 'TRANSCRIBE',
  CHAT = 'CHAT'
}

export interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export interface AudioVisualizationProps {
  isActive: boolean;
  audioData: Uint8Array;
}
