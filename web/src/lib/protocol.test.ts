import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, decodeFrame, encodeFrame, MAX_FILE_BYTES, MAX_FRAME_BYTES, parseControl, safeFilename, validateSelection } from './protocol';

describe('bounded binary file protocol', () => {
  it('preserves binary bytes and precise file offsets at the frame boundary', () => {
    const bytes = Uint8Array.from({ length: CHUNK_BYTES }, (_, i) => i % 256);
    const encoded = encodeFrame(9, MAX_FILE_BYTES - bytes.length, bytes);
    expect(encoded.byteLength).toBe(MAX_FRAME_BYTES);
    const decoded = decodeFrame(encoded);
    expect(decoded.id).toBe(9); expect(decoded.offset).toBe(MAX_FILE_BYTES - bytes.length); expect(decoded.bytes).toEqual(bytes);
  });
  it.each([
    (frame: ArrayBuffer) => new DataView(frame).setUint16(0, 0),
    (frame: ArrayBuffer) => new DataView(frame).setUint8(2, 2),
    (frame: ArrayBuffer) => new DataView(frame).setUint8(3, 1),
    (frame: ArrayBuffer) => new DataView(frame).setUint32(4, 10),
    (frame: ArrayBuffer) => new DataView(frame).setUint32(8, MAX_FILE_BYTES),
    (frame: ArrayBuffer) => new DataView(frame).setUint32(12, 999),
  ])('rejects malformed headers', mutate => {
    const frame = encodeFrame(0, 0, new Uint8Array([0, 255])); mutate(frame);
    expect(() => decodeFrame(frame)).toThrow();
  });
  it('rejects oversized frames and empty chunks', () => {
    expect(() => decodeFrame(new ArrayBuffer(MAX_FRAME_BYTES + 1))).toThrow();
    expect(() => encodeFrame(0, 0, new Uint8Array())).toThrow();
    expect(() => encodeFrame(0, 0, new Uint8Array(CHUNK_BYTES + 1))).toThrow();
  });
  it('enforces file limits on incoming manifests independently of sender selection', () => {
    const manifest = { type: 'manifest', files: [{ id: 0, name: 'a', size: MAX_FILE_BYTES + 1, mime: '' }] };
    expect(() => parseControl(JSON.stringify(manifest))).toThrow();
    manifest.files[0].size = MAX_FILE_BYTES;
    expect(parseControl(JSON.stringify(manifest))).toEqual(manifest);
    manifest.files.push({ ...manifest.files[0] });
    expect(() => parseControl(JSON.stringify(manifest))).toThrow();
  });
  it('rejects oversized batches, metadata, controls and non-integer counters', () => {
    const files = Array.from({ length: 11 }, (_, id) => ({ id, name: 'a', size: 0, mime: '' }));
    expect(() => parseControl(JSON.stringify({ type: 'manifest', files }))).toThrow();
    expect(() => parseControl(JSON.stringify({ type: 'ack', fileId: 0, offset: 0.5 }))).toThrow();
    expect(() => parseControl(JSON.stringify({ type: 'error', message: 'x'.repeat(MAX_FRAME_BYTES) }))).toThrow();
    expect(() => parseControl('null')).toThrow();
  });
  it('sanitizes path-like filenames without interpreting file contents', () => {
    expect(safeFilename('../../evil\u0000.html')).toBe('_.._evil_.html');
    expect(safeFilename('...')).toBe('received-file');
    expect(safeFilename('résumé 日本語.zip')).toBe('résumé 日本語.zip');
  });
  it('accepts exactly 100 MiB and ten files and rejects larger selections without allocating files', () => {
    const boundary = { name: 'large', size: MAX_FILE_BYTES } as File;
    expect(validateSelection(Array(10).fill(boundary))).toBeNull();
    expect(validateSelection(Array(11).fill(boundary))).toContain('10');
    expect(validateSelection([{ ...boundary, size: MAX_FILE_BYTES + 1 } as File])).toContain('100 MiB');
    expect(validateSelection([])).toBeTruthy();
  });
});
