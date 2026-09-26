export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_FRAME_BYTES = 16 * 1024;
export const HEADER_BYTES = 16;
export const CHUNK_BYTES = MAX_FRAME_BYTES - HEADER_BYTES;
export const SEND_WINDOW_BYTES = 256 * 1024;
export const BUFFER_HIGH_BYTES = 128 * 1024;
export const PROTOCOL_VERSION = 1;
export interface ManifestFile { id: number; name: string; size: number; mime: string }
export type Control =
  | { type: 'hello'; version: 1; maxFiles: number; maxFileBytes: number; maxFrameBytes: number }
  | { type: 'manifest'; files: ManifestFile[] }
  | { type: 'accept'; fileId: number }
  | { type: 'ack'; fileId: number; offset: number }
  | { type: 'end'; fileId: number; size: number; hash: string }
  | { type: 'receipt'; fileId: number; size: number; hash: string; saveStatus: 'verified' | 'saved' }
  | { type: 'cancel'; message: string }
  | { type: 'error'; message: string };
const utf8 = new TextEncoder();
const integer = (x: unknown, max = MAX_FILE_BYTES): x is number => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= max;
const fileId = (x: unknown): x is number => integer(x, MAX_FILES - 1);
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export function safeFilename(name: string): string {
  // Control characters are intentionally removed from untrusted display/save names.
  // eslint-disable-next-line no-control-regex
  return [...name.replace(/[\u0000-\u001f\u007f/\\:]/g, '_').replace(/^\.+/, '').trim()].slice(0, 160).join('') || 'received-file';
}
export function validateSelection(files: File[]): string | null {
  if (files.length < 1) return 'Select at least one file.';
  if (files.length > MAX_FILES) return 'Choose no more than 10 files.';
  if (files.some(file => !integer(file.size))) return 'Each file must be 100 MiB or smaller.';
  return null;
}
export function parseControl(raw: string): Control {
  if (utf8.encode(raw).length > MAX_FRAME_BYTES) throw new Error('Control message exceeds the protocol limit.');
  const x = JSON.parse(raw) as Record<string, unknown>;
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('Invalid control message.');
  switch (x.type) {
    case 'hello':
      if (x.version !== 1 || !integer(x.maxFiles, MAX_FILES) || x.maxFiles === 0 || !integer(x.maxFileBytes) || !integer(x.maxFrameBytes, MAX_FRAME_BYTES) || (x.maxFrameBytes as number) <= HEADER_BYTES) break;
      return x as unknown as Control;
    case 'manifest': {
      if (!Array.isArray(x.files) || x.files.length < 1 || x.files.length > MAX_FILES) break;
      const files = x.files as ManifestFile[];
      if (files.some((f, i) => !f || f.id !== i || !integer(f.size) || typeof f.name !== 'string' || f.name.length > 320 || !f.name || typeof f.mime !== 'string' || f.mime.length > 128)) break;
      return { type: 'manifest', files: files.map(f => ({ id: f.id, name: safeFilename(f.name), size: f.size, mime: f.mime })) };
    }
    case 'accept': if (fileId(x.fileId)) return x as unknown as Control; break;
    case 'ack': if (fileId(x.fileId) && integer(x.offset)) return x as unknown as Control; break;
    case 'end': if (fileId(x.fileId) && integer(x.size) && hash(x.hash)) return x as unknown as Control; break;
    case 'receipt': if (fileId(x.fileId) && integer(x.size) && hash(x.hash) && (x.saveStatus === 'verified' || x.saveStatus === 'saved')) return x as unknown as Control; break;
    case 'cancel': case 'error':
      if (typeof x.message === 'string' && x.message.length <= 240) return x as unknown as Control;
  }
  throw new Error('Invalid or unsupported control message.');
}
export function encodeFrame(id: number, offset: number, bytes: Uint8Array): ArrayBuffer {
  if (!fileId(id) || !integer(offset) || bytes.length < 1 || bytes.length > CHUNK_BYTES || offset + bytes.length > MAX_FILE_BYTES) throw new Error('Invalid chunk.');
  const buffer = new ArrayBuffer(HEADER_BYTES + bytes.length);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4653); view.setUint8(2, 1); view.setUint8(3, 0);
  view.setUint32(4, id); view.setUint32(8, offset); view.setUint32(12, bytes.length);
  new Uint8Array(buffer, HEADER_BYTES).set(bytes);
  return buffer;
}
export function decodeFrame(buffer: ArrayBuffer): { id: number; offset: number; bytes: Uint8Array } {
  if (buffer.byteLength <= HEADER_BYTES || buffer.byteLength > MAX_FRAME_BYTES) throw new Error('Invalid binary frame length.');
  const view = new DataView(buffer);
  const id = view.getUint32(4), offset = view.getUint32(8), size = view.getUint32(12);
  if (view.getUint16(0) !== 0x4653 || view.getUint8(2) !== 1 || view.getUint8(3) !== 0 || !fileId(id) || !integer(offset) || size !== buffer.byteLength - HEADER_BYTES || offset + size > MAX_FILE_BYTES) throw new Error('Invalid binary frame header.');
  return { id, offset, bytes: new Uint8Array(buffer, HEADER_BYTES) };
}
