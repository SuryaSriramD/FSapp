import { sha256 } from '@noble/hashes/sha2.js';
import { BUFFER_HIGH_BYTES, CHUNK_BYTES, decodeFrame, encodeFrame, MAX_FILE_BYTES, MAX_FILES, MAX_FRAME_BYTES, parseControl, safeFilename, SEND_WINDOW_BYTES } from './protocol';
import type { Control, ManifestFile } from './protocol';
import { createSink } from './sinks';
import type { FileSink } from './sinks';
import type { SessionSnapshot } from './types';

export interface DataTransport { readonly bufferedAmount: number; readonly readyState: string; send(data: string | ArrayBuffer): void; close(): void }
interface TransferOptions { preferMemorySink?: boolean; sinkFactory?: (file: ManifestFile) => Promise<FileSink>; stallMs?: number }
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Transfer failed.';

/** The file protocol is independent of signaling and UI. No send() result counts as delivery. */
export class TransferEngine {
  private manifest: ManifestFile[] = [];
  private index = 0;
  private hello = false;
  private manifestReceived = false;
  private stopped = false;
  private accepting = false;
  private sent = 0;
  private acknowledged = 0;
  private written = 0;
  private sentEnd = false;
  private expectedHash = '';
  private digest = sha256.create();
  private sink?: FileSink;
  private queue = Promise.resolve();
  private pendingBytes = 0;
  private pendingCount = 0;
  private wake?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private state: SessionSnapshot, private source: File[], private channel: DataTransport, private emit: () => void, private options: TransferOptions = {}) {}

  open(): void {
    if (this.stopped) return;
    this.state.metrics.connectedAt = Date.now();
    this.setPhase('connecting', 'Checking peer capabilities…');
    this.send({ type: 'hello', version: 1, maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxFrameBytes: MAX_FRAME_BYTES });
    this.armTimeout();
  }
  receive(data: unknown): void {
    if (this.stopped) return;
    const size = typeof data === 'string' ? new TextEncoder().encode(data).length : data instanceof ArrayBuffer ? data.byteLength : -1;
    if (size < 0 || size > MAX_FRAME_BYTES || this.pendingCount >= 64 || this.pendingBytes + size > SEND_WINDOW_BYTES + MAX_FRAME_BYTES * 4) {
      this.fail('Peer exceeded the bounded receive queue.'); return;
    }
    this.pendingBytes += size; this.pendingCount++;
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      if (typeof data === 'string') await this.control(parseControl(data));
      else await this.chunk(data as ArrayBuffer);
    }).catch(error => this.fail(errorMessage(error))).finally(() => { this.pendingBytes -= size; this.pendingCount--; });
  }
  bufferedLow(): void { this.wake?.(); }
  closed(): void {
    if (this.state.phase === 'complete' || (this.state.received && this.index === this.manifest.length - 1)) return;
    this.fail('The peer connection closed. Create a new invitation to restart the interrupted file.');
  }

  async accept(): Promise<void> {
    if (this.state.role !== 'receiver' || this.state.phase !== 'awaiting-acceptance' || this.accepting || this.stopped) return;
    this.accepting = true;
    const file = this.manifest[this.index];
    try {
      // createSink calls the browser picker synchronously, before yielding this user gesture.
      const sink = await (this.options.sinkFactory?.(file) ?? createSink(file, this.options.preferMemorySink));
      if (this.stopped) { await sink.abort(); return; }
      this.sink = sink; this.written = 0; this.digest = sha256.create();
      this.state.files[this.index].status = 'transferring';
      this.setPhase('transferring', `Receiving ${file.name}…`);
      this.send({ type: 'accept', fileId: file.id });
      this.armTimeout();
    } catch (error) {
      if (!this.stopped) this.setPhase('awaiting-acceptance', error instanceof DOMException && error.name === 'AbortError' ? 'Save cancelled. Accept again when ready.' : `Could not open the save destination: ${errorMessage(error)}`);
    } finally { this.accepting = false; }
  }
  download(): void {
    const received = this.state.received;
    if (!received?.url) return;
    const link = document.createElement('a');
    link.href = received.url; link.download = received.name; link.rel = 'noopener';
    document.body.append(link); link.click(); link.remove();
    received.status = 'download-requested';
    this.state.message = 'Download requested. Your browser manages the save; it cannot confirm completion here.';
    this.emit();
  }
  async nextFile(): Promise<void> {
    if (this.state.role !== 'receiver' || !this.state.received || this.stopped) return;
    // A deliberate user action releases the single-file Blob; do not silently discard an undownloaded file.
    if (this.state.received.status === 'verified' && this.state.received.method === 'download') return;
    this.releaseReceived(); this.index++;
    if (this.index === this.manifest.length) { this.setPhase('complete', 'All files received and verified.'); return; }
    this.state.currentFileId = this.manifest[this.index].id;
    this.setPhase('awaiting-acceptance', 'Accept the next file when you are ready.');
  }
  cancel(): void {
    if (this.stopped || this.state.phase === 'complete') return;
    try { this.send({ type: 'cancel', message: 'Transfer cancelled by the other device.' }); } catch { /* Socket may already be gone. */ }
    this.stop(); this.setPhase('cancelled', 'Transfer cancelled. Create a new invitation to start again.');
  }
  dispose(): void { this.stop(); this.releaseReceived(); }
  fail(message: string): void {
    if (this.stopped || this.state.phase === 'complete') return;
    try { this.send({ type: 'error', message: message.slice(0, 240) }); } catch { /* Best effort. */ }
    this.stop(); this.state.error = message; this.setPhase('failed', message);
  }
  private setPhase(phase: SessionSnapshot['phase'], message: string): void { this.state.phase = phase; this.state.message = message; this.emit(); }
  private send(control: Control): void {
    const raw = JSON.stringify(control);
    if (new TextEncoder().encode(raw).length > MAX_FRAME_BYTES || this.channel.readyState !== 'open') throw new Error('Peer connection is unavailable.');
    this.channel.send(raw);
  }
  private armTimeout(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('Transfer stalled. Keep both devices open and create a fresh invitation.'), this.options.stallMs ?? 45_000);
  }
  private clearTimeout(): void { clearTimeout(this.timer); this.timer = undefined; }
  private stop(): void {
    this.stopped = true; this.clearTimeout(); this.wake?.();
    if (this.sink) void this.sink.abort().catch(() => {});
    this.sink = undefined; this.channel.close();
  }
  private releaseReceived(): void {
    if (this.state.received?.url) URL.revokeObjectURL(this.state.received.url);
    this.state.received = undefined;
  }
  private updateBuffer(): void {
    const bytes = this.state.role === 'sender' ? this.sent - this.acknowledged : this.pendingBytes;
    this.state.metrics.bufferedBytes = bytes;
    this.state.metrics.maxBufferedBytes = Math.max(this.state.metrics.maxBufferedBytes, bytes);
  }
  private async control(message: Control): Promise<void> {
    if (message.type === 'cancel' || message.type === 'error') {
      this.stop(); this.state.error = message.type === 'error' ? message.message : undefined;
      this.setPhase(message.type === 'cancel' ? 'cancelled' : 'failed', message.message); return;
    }
    if (message.type === 'hello') {
      if (this.hello) throw new Error('Repeated protocol handshake.');
      this.hello = true;
      if (message.maxFrameBytes < MAX_FRAME_BYTES) throw new Error('Peer frame capability is incompatible.');
      if (this.state.role === 'sender') {
        if (this.source.length > message.maxFiles || this.source.some(f => f.size > message.maxFileBytes)) throw new Error('Selected files exceed receiver limits.');
        this.manifest = this.source.map((f, id) => ({ id, name: safeFilename(f.name), size: f.size, mime: f.type.slice(0, 128) }));
        this.state.files = this.manifest.map(f => ({ ...f, progress: 0, status: 'pending' }));
        this.state.currentFileId = 0;
        this.send({ type: 'manifest', files: this.manifest });
        this.clearTimeout(); this.setPhase('awaiting-acceptance', 'Waiting for the receiver to accept the first file.');
      }
      return;
    }
    if (!this.hello) throw new Error('Peer skipped capability negotiation.');
    if (message.type === 'manifest') {
      if (this.state.role !== 'receiver' || this.manifestReceived) throw new Error('Unexpected file manifest.');
      this.manifestReceived = true; this.manifest = message.files;
      this.state.files = this.manifest.map(f => ({ ...f, progress: 0, status: 'pending' }));
      this.state.currentFileId = this.manifest[0].id;
      this.clearTimeout(); this.setPhase('awaiting-acceptance', 'Review the files, then accept the first file.'); return;
    }
    const file = this.manifest[this.index];
    if (!file || message.fileId !== file.id) throw new Error('Unexpected file ID.');
    if (message.type === 'accept') {
      if (this.state.role !== 'sender' || this.state.phase !== 'awaiting-acceptance') throw new Error('Unexpected file acceptance.');
      this.sent = 0; this.acknowledged = 0; this.sentEnd = false; this.expectedHash = ''; this.digest = sha256.create();
      this.state.files[this.index].status = 'transferring';
      this.setPhase('transferring', `Sending ${file.name}…`); this.armTimeout();
      void this.pump().catch(error => this.fail(errorMessage(error))); return;
    }
    if (message.type === 'ack') {
      if (this.state.role !== 'sender' || this.state.phase !== 'transferring' || message.offset <= this.acknowledged || message.offset > this.sent) throw new Error('Invalid receiver acknowledgement.');
      this.state.metrics.bytesTransferred += message.offset - this.acknowledged;
      this.acknowledged = message.offset;
      this.state.files[this.index].progress = file.size ? this.acknowledged / file.size : 1;
      this.updateBuffer(); this.armTimeout(); this.emit(); this.wake?.(); return;
    }
    if (message.type === 'end') {
      if (this.state.role !== 'receiver' || this.state.phase !== 'transferring' || !this.sink || this.written !== file.size || message.size !== file.size) throw new Error('Incomplete or unexpected file completion.');
      this.setPhase('verifying', `Verifying ${file.name}…`);
      const actualHash = hex(this.digest.digest());
      if (actualHash !== message.hash) throw new Error('File integrity verification failed. Nothing was saved.');
      const result = await this.sink.finish();
      if (this.stopped) { if (result.url) URL.revokeObjectURL(result.url); return; }
      this.sink = undefined; this.clearTimeout();
      this.state.received = { id: file.id, name: file.name, size: file.size, ...result, status: result.method === 'disk' ? 'saved' : 'verified' };
      this.state.files[this.index].status = 'verified'; this.state.files[this.index].progress = 1;
      this.state.metrics.bufferedBytes = 0;
      this.send({ type: 'receipt', fileId: file.id, size: file.size, hash: actualHash, saveStatus: result.method === 'disk' ? 'saved' : 'verified' });
      this.setPhase('received', result.method === 'disk' ? 'Received, verified, and saved.' : 'Received and verified. Download the file to keep it.'); return;
    }
    if (message.type === 'receipt') {
      if (this.state.role !== 'sender' || this.state.phase !== 'verifying' || !this.sentEnd || message.size !== file.size || message.hash !== this.expectedHash) throw new Error('Invalid verified-receipt acknowledgement.');
      this.clearTimeout(); this.state.files[this.index].status = 'verified'; this.state.files[this.index].progress = 1;
      this.index++; this.state.metrics.bufferedBytes = 0;
      if (this.index === this.manifest.length) this.setPhase('complete', 'All files received and verified by the other device.');
      else { this.state.currentFileId = this.manifest[this.index].id; this.setPhase('awaiting-acceptance', 'Waiting for the receiver to save and accept the next file.'); }
      return;
    }
  }
  private async chunk(buffer: ArrayBuffer): Promise<void> {
    if (this.state.role !== 'receiver' || this.state.phase !== 'transferring' || !this.sink) throw new Error('File bytes arrived before acceptance.');
    const frame = decodeFrame(buffer), file = this.manifest[this.index];
    if (frame.id !== file.id || frame.offset !== this.written || this.written + frame.bytes.length > file.size) throw new Error('Invalid file offset or declared size.');
    await this.sink.write(frame.bytes);
    if (this.stopped) return;
    this.digest.update(frame.bytes); this.written += frame.bytes.length;
    this.state.metrics.bytesTransferred += frame.bytes.length;
    this.state.files[this.index].progress = this.written / file.size;
    this.updateBuffer(); this.armTimeout(); this.emit();
    this.send({ type: 'ack', fileId: file.id, offset: this.written });
  }
  private async pump(): Promise<void> {
    const file = this.source[this.index];
    while (!this.stopped && this.sent < file.size) {
      const length = Math.min(CHUNK_BYTES, file.size - this.sent);
      if (this.sent - this.acknowledged + length > SEND_WINDOW_BYTES || this.channel.bufferedAmount + length + 16 > BUFFER_HIGH_BYTES) {
        await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined; continue;
      }
      const bytes = new Uint8Array(await file.slice(this.sent, this.sent + length).arrayBuffer());
      if (this.stopped) return;
      if (bytes.length !== length) throw new Error('The selected file could not be read completely.');
      this.channel.send(encodeFrame(this.index, this.sent, bytes));
      this.digest.update(bytes); this.sent += bytes.length; this.updateBuffer(); this.emit();
    }
    while (!this.stopped && this.acknowledged < this.sent) { await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined; }
    if (this.stopped) return;
    this.expectedHash = hex(this.digest.digest()); this.sentEnd = true;
    this.setPhase('verifying', 'Waiting for the receiver to verify the file…'); this.armTimeout();
    this.send({ type: 'end', fileId: this.index, size: file.size, hash: this.expectedHash });
  }
}
