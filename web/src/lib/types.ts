export type Role = 'sender' | 'receiver';
export type Phase = 'creating' | 'waiting' | 'confirming' | 'connecting' | 'awaiting-acceptance' | 'transferring' | 'verifying' | 'received' | 'complete' | 'cancelled' | 'failed';
export interface FileInfo { id: number; name: string; size: number; progress: number; status: string }
export interface ReceivedFile { id: number; name: string; size: number; url?: string; method: 'download' | 'disk'; status: 'verified' | 'download-requested' | 'saved' }
export interface SessionSnapshot {
  role: Role; phase: Phase; message: string; inviteUrl?: string; pairingCode?: string; confirmationPhrase?: string; files: FileInfo[];
  currentFileId?: number; route: 'pending' | 'direct' | 'relay'; signalingConnected: boolean;
  received?: ReceivedFile; error?: string;
  metrics: { startedAt?: number; connectedAt?: number; bytesTransferred: number; bufferedBytes: number; maxBufferedBytes: number };
}
/** Only returned over the authenticated same-origin service; never encoded in a share URL. */
export interface PairingCredentials { id: string; token: string; key: string; attempt: string }
export interface SessionOptions { forceRelay?: boolean; preferMemorySink?: boolean }
export interface TransferSession {
  approvePairing(): Promise<void>;
  accept(): Promise<void>; download(): void; nextFile(): Promise<void>; cancel(): void; dispose(): void;
}
export type OnChange = (snapshot: SessionSnapshot) => void;
