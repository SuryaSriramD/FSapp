import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, MAX_FILE_BYTES, MAX_FILES, MAX_FRAME_BYTES, SEND_WINDOW_BYTES } from './protocol';
import type { FileSink } from './sinks';
import { TransferEngine } from './transfer';
import type { DataTransport } from './transfer';
import type { Role, SessionSnapshot } from './types';

const active: TransferEngine[] = [];
afterEach(() => { active.splice(0).forEach(e => e.dispose()); vi.useRealTimers(); });
function state(role: Role): SessionSnapshot {
  return { role, phase: 'connecting', message: '', files: [], route: 'pending', signalingConnected: true, metrics: { bytesTransferred: 0, bufferedBytes: 0, maxBufferedBytes: 0 } };
}
function harness(files: File[], options: { write?: (bytes: Uint8Array) => Promise<void>; sinkFactory?: () => Promise<FileSink>; mutate?: (data: string | ArrayBuffer, role: Role) => string | ArrayBuffer } = {}) {
  const senderState = state('sender'), receiverState = state('receiver'), received: number[] = [];
  const sink: FileSink = { write: vi.fn(async bytes => { await options.write?.(bytes); received.push(...bytes); }), finish: vi.fn(async () => ({ method: 'disk' as const })), abort: vi.fn(async () => {}) };
  const engines = {} as Record<Role, TransferEngine>;
  const sent: { sender: (string | ArrayBuffer)[]; receiver: (string | ArrayBuffer)[] } = { sender: [], receiver: [] };
  const transport = (role: Role): DataTransport => ({
    readyState: 'open', bufferedAmount: 0,
    send: data => { sent[role].push(data); const peer = role === 'sender' ? 'receiver' : 'sender'; queueMicrotask(() => engines[peer].receive(options.mutate?.(data, role) ?? data)); },
    close: () => {},
  });
  engines.sender = new TransferEngine(senderState, files, transport('sender'), () => {});
  engines.receiver = new TransferEngine(receiverState, [], transport('receiver'), () => {}, { sinkFactory: options.sinkFactory ?? (async () => sink) });
  active.push(engines.sender, engines.receiver);
  engines.sender.open(); engines.receiver.open();
  return { ...engines, senderState, receiverState, received, sink, sent };
}
const hello = JSON.stringify({ type: 'hello', version: 1, maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxFrameBytes: MAX_FRAME_BYTES });

describe('file transfer state and backpressure', () => {
  it('transfers binary bytes only after consent, verifies receipt, and distinguishes disk saving', async () => {
    const bytes = new Uint8Array([0, 255, 17, 128, 0]);
    const h = harness([new File([bytes], 'binary.zip')]);
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance'));
    expect(h.sent.sender.filter(x => x instanceof ArrayBuffer)).toHaveLength(0);
    await h.receiver.accept();
    await vi.waitFor(() => expect(h.senderState.phase).toBe('complete'));
    expect(h.received).toEqual(Array.from(bytes));
    expect(h.receiverState.received).toMatchObject({ name: 'binary.zip', status: 'saved', method: 'disk' });
    expect(h.senderState.metrics.bytesTransferred).toBe(bytes.length);
    await h.receiver.nextFile(); expect(h.receiverState.phase).toBe('complete');
  });
  it('verifies empty files without inventing a binary chunk', async () => {
    const h = harness([new File([], 'empty')]);
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance')); await h.receiver.accept();
    await vi.waitFor(() => expect(h.senderState.phase).toBe('complete'));
    expect(h.sent.sender.filter(x => x instanceof ArrayBuffer)).toHaveLength(0);
    expect(h.receiverState.files[0].progress).toBe(1); expect(h.sink.finish).toHaveBeenCalledOnce();
  });
  it('does not begin the next file until explicit progression and acceptance', async () => {
    const h = harness([new File(['first'], 'same.txt'), new File(['second'], 'same.txt')]);
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance')); await h.receiver.accept();
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('received'));
    expect(h.senderState.phase).toBe('awaiting-acceptance'); expect(h.receiverState.currentFileId).toBe(0);
    await h.receiver.nextFile(); expect(h.receiverState.currentFileId).toBe(1); expect(h.receiverState.phase).toBe('awaiting-acceptance');
    await h.receiver.accept(); await vi.waitFor(() => expect(h.senderState.phase).toBe('complete'));
    expect(h.receiverState.files.map(f => f.status)).toEqual(['verified', 'verified']);
  });
  it('preserves a verified download when the peer disconnects before the next file', async () => {
    const url = URL.createObjectURL(new Blob(['first']));
    const h = harness([new File(['first'], 'first.txt'), new File(['second'], 'second.txt')], { sinkFactory: async () => ({ write: async () => {}, finish: async () => ({ method: 'download', url }), abort: async () => {} }) });
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance')); await h.receiver.accept();
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('received'));
    h.receiver.closed(); expect(h.receiverState.phase).toBe('failed');
    expect(h.receiverState.received?.url).toBe(url); expect(await (await fetch(url)).text()).toBe('first');
    await h.receiver.nextFile(); expect(h.receiverState.currentFileId).toBe(0);
  });
  it('bounds sender outstanding bytes while receiver storage is blocked', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const h = harness([new File([new Uint8Array(1024 * 1024)], 'large')], { write: () => blocked });
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance')); await h.receiver.accept();
    await vi.waitFor(() => expect(h.senderState.metrics.bufferedBytes).toBeGreaterThan(SEND_WINDOW_BYTES - MAX_FRAME_BYTES));
    expect(h.senderState.metrics.bytesTransferred).toBe(0);
    expect(h.senderState.metrics.maxBufferedBytes).toBeLessThanOrEqual(SEND_WINDOW_BYTES);
    expect(h.sent.sender.filter(x => typeof x === 'string' && JSON.parse(x).type === 'end')).toHaveLength(0);
    release(); await vi.waitFor(() => expect(h.senderState.phase).toBe('complete'));
    expect(h.received).toHaveLength(1024 * 1024);
  });
  it('does not report delivery from send or write acknowledgements without a verified receipt', async () => {
    const h = harness([new File(['abc'], 'a')], { mutate: (data, role) => {
      if (role === 'receiver' && typeof data === 'string' && JSON.parse(data).type === 'receipt') return JSON.stringify({ ...JSON.parse(data), hash: '0'.repeat(64) });
      return data;
    } });
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance')); await h.receiver.accept();
    await vi.waitFor(() => expect(h.senderState.phase).toBe('failed'));
    expect(h.senderState.error).toContain('receipt');
  });
  it('aborts the destination instead of committing corrupted content', async () => {
    const h = harness([new File(['abc'], 'a')], { mutate: (data, role) => {
      if (role === 'sender' && data instanceof ArrayBuffer) { const copy = data.slice(0); new Uint8Array(copy)[16] ^= 255; return copy; }
      return data;
    } });
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance')); await h.receiver.accept();
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('failed'));
    expect(h.receiverState.error).toContain('integrity'); expect(h.sink.finish).not.toHaveBeenCalled(); expect(h.sink.abort).toHaveBeenCalled();
  });
  it('rejects file bytes before receiver consent', async () => {
    const h = harness([new File(['a'], 'a')]);
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance'));
    h.receiver.receive(encodeFrame(0, 0, new Uint8Array([1])));
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('failed'));
    expect(h.receiverState.error).toContain('before acceptance'); expect(h.sink.write).not.toHaveBeenCalled();
  });
  it('cleans up storage on write failure and tells the sender', async () => {
    const h = harness([new File(['abc'], 'a')], { write: async () => { throw new Error('Disk is full'); } });
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance')); await h.receiver.accept();
    await vi.waitFor(() => expect(h.senderState.phase).toBe('failed'));
    expect(h.receiverState.error).toBe('Disk is full'); expect(h.sink.abort).toHaveBeenCalled();
  });
  it('rejects an acknowledgement beyond the bytes actually sent', async () => {
    const h = harness([new File(['abc'], 'a')]);
    await vi.waitFor(() => expect(h.senderState.phase).toBe('awaiting-acceptance'));
    h.sender.receive(JSON.stringify({ type: 'ack', fileId: 0, offset: 3 }));
    await vi.waitFor(() => expect(h.senderState.phase).toBe('failed'));
  });
  it('cancels both peers without claiming completion', async () => {
    const h = harness([new File(['abc'], 'a')]);
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance'));
    h.receiver.cancel(); await vi.waitFor(() => expect(h.senderState.phase).toBe('cancelled'));
    expect(h.receiverState.phase).toBe('cancelled');
  });
  it('aborts a save picker result that arrives after cancellation without accepting the file', async () => {
    let resolvePicker!: (sink: FileSink) => void;
    const h = harness([new File(['a'], 'a')], { sinkFactory: () => new Promise(resolve => { resolvePicker = resolve; }) });
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance'));
    const acceptance = h.receiver.accept(); h.receiver.cancel(); resolvePicker(h.sink); await acceptance;
    expect(h.sink.abort).toHaveBeenCalledOnce(); expect(h.receiverState.phase).toBe('cancelled');
    expect(h.sent.receiver.filter(raw => typeof raw === 'string' && JSON.parse(raw).type === 'accept')).toHaveLength(0);
  });
  it('fails stalled protocol handshakes and oversized incoming buffers', async () => {
    vi.useFakeTimers(); const s = state('receiver');
    const engine = new TransferEngine(s, [], { send: () => {}, close: () => {}, readyState: 'open', bufferedAmount: 0 }, () => {}, { stallMs: 100 }); active.push(engine);
    engine.open(); await vi.advanceTimersByTimeAsync(101); expect(s.phase).toBe('failed');
    const s2 = state('receiver'); const e2 = new TransferEngine(s2, [], { send: () => {}, close: () => {}, readyState: 'open', bufferedAmount: 0 }, () => {}); active.push(e2);
    e2.receive(new ArrayBuffer(MAX_FRAME_BYTES + 1)); expect(s2.phase).toBe('failed');
  });
  it('rejects repeated capabilities rather than resetting consent state', async () => {
    const h = harness([new File(['a'], 'a')]);
    await vi.waitFor(() => expect(h.receiverState.phase).toBe('awaiting-acceptance'));
    h.receiver.receive(hello); await vi.waitFor(() => expect(h.receiverState.phase).toBe('failed'));
  });
});
