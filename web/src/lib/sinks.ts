import type { ManifestFile } from './protocol';
export interface SinkResult { method: 'disk' | 'download'; url?: string }
export interface FileSink { write(bytes: Uint8Array): Promise<void>; finish(): Promise<SinkResult>; abort(): Promise<void> }
interface WritableFile { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
interface SaveWindow { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableFile> }> }
export function createSink(file: ManifestFile, preferMemory = false): Promise<FileSink> {
  const picker = (window as unknown as SaveWindow).showSaveFilePicker;
  // Invoke the picker before the first await to preserve the accept button's user activation.
  if (picker && !preferMemory) return picker.call(window, { suggestedName: file.name }).then(async handle => {
    const stream = await handle.createWritable();
    return { write: bytes => stream.write(bytes), finish: async () => { await stream.close(); return { method: 'disk' }; }, abort: () => stream.abort() };
  });
  let chunks: Uint8Array<ArrayBuffer>[] = [], bytesWritten = 0, finished = false;
  return Promise.resolve({
    write: async bytes => {
      if (finished || bytesWritten + bytes.length > file.size) throw new Error('Receiver storage limit exceeded.');
      chunks.push(bytes.slice()); bytesWritten += bytes.length;
    },
    finish: async () => {
      if (finished || bytesWritten !== file.size) throw new Error('Incomplete received file.');
      finished = true;
      // Use an inert download type. Untrusted sender content is never rendered inline.
      const blob = new Blob(chunks, { type: 'application/octet-stream' });
      chunks = [];
      return { method: 'download', url: URL.createObjectURL(blob) };
    },
    abort: async () => { finished = true; chunks = []; },
  });
}
