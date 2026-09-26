import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSink } from './sinks';
const file = { id: 0, name: 'untrusted.html', size: 3, mime: 'text/html' };
afterEach(() => vi.unstubAllGlobals());
describe('receiver storage', () => {
  it('calls the native picker synchronously within the user acceptance gesture', async () => {
    const stream = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const picker = vi.fn(async () => ({ createWritable: async () => stream })); vi.stubGlobal('window', { showSaveFilePicker: picker });
    const pending = createSink(file); expect(picker).toHaveBeenCalledOnce();
    const sink = await pending; await sink.write(new Uint8Array([1, 2, 3]));
    expect(stream.close).not.toHaveBeenCalled(); expect(await sink.finish()).toEqual({ method: 'disk' }); expect(stream.close).toHaveBeenCalledOnce();
  });
  it('keeps fallback content inert and bounds it to the declared file size', async () => {
    vi.stubGlobal('window', {}); const sink = await createSink(file, true);
    await sink.write(new Uint8Array([0, 255, 3]));
    await expect(sink.write(new Uint8Array([4]))).rejects.toThrow('limit');
    const result = await sink.finish();
    try {
      const response = await fetch(result.url!); expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 3]));
    } finally { URL.revokeObjectURL(result.url!); }
  });
  it('refuses to finalize incomplete content and releases cancelled buffers', async () => {
    vi.stubGlobal('window', {}); const sink = await createSink(file, true);
    await sink.write(new Uint8Array([1])); await expect(sink.finish()).rejects.toThrow('Incomplete');
    await sink.abort(); await expect(sink.write(new Uint8Array([2]))).rejects.toThrow();
  });
});
