import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSender, startReceiving } from './session';
import { base64url } from './crypto';
import type { SessionSnapshot, TransferSession } from './types';

class FakeChannel {
  readyState = 'connecting'; bufferedAmount = 0; bufferedAmountLowThreshold = 0; binaryType = 'arraybuffer';
  onopen?: () => void; onclose?: () => void; onerror?: () => void; onmessage?: (event: { data: unknown }) => void; onbufferedamountlow?: () => void;
  send = vi.fn();
  close(): void { this.readyState = 'closed'; this.onclose?.(); }
  open(): void { this.readyState = 'open'; this.onopen?.(); }
}
class FakePeer {
  static instances: FakePeer[] = [];
  channel = new FakeChannel(); connectionState = 'new'; localDescription?: RTCSessionDescriptionInit;
  onicecandidate?: (event: { candidate: { toJSON: () => unknown } | null }) => void;
  onconnectionstatechange?: () => void;
  ondatachannel?: unknown;
  close = vi.fn(() => { this.connectionState = 'closed'; this.channel.close(); });
  constructor() { FakePeer.instances.push(this); }
  createDataChannel(): FakeChannel { return this.channel; }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n' }; }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    // Some browsers emit a candidate while setLocalDescription is still pending.
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'candidate:1 1 UDP 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 }) } });
  }
}
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0; bufferedAmount = 0;
  onopen?: () => void; onclose?: (() => void) | null; onerror?: () => void; onmessage?: (event: { data: string }) => void;
  send = vi.fn();
  constructor(public url: URL) { FakeSocket.instances.push(this); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

let sessions: TransferSession[] = [];
let snapshots: SessionSnapshot[] = [];
const room = { id: 'r'.repeat(24), senderToken: 's'.repeat(43), code: '001234', key: base64url(new Uint8Array(32).fill(7)), attempt: base64url(new Uint8Array(16).fill(3)), expiresAt: '2026-09-14T12:00:00Z', maxFiles: 10, maxFileBytes: 104857600 };
const claimed = { id: room.id, token: 't'.repeat(43), key: room.key, attempt: room.attempt, expiresAt: room.expiresAt };
beforeEach(() => {
  FakeSocket.instances = []; FakePeer.instances = []; snapshots = [];
  vi.stubGlobal('window', { location: { origin: 'http://localhost:5173', href: 'http://localhost:5173/', pathname: '/', search: '' } });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('WebSocket', FakeSocket); vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === 'DELETE' || path.endsWith('/approve')) return new Response(null, { status: 204 });
    if (path === '/v1/pairings') return Response.json(claimed);
    return Response.json(path.endsWith('/ice') ? { iceServers: [{ urls: 'stun:stun.example.test:3478' }], relayEnabled: false } : room);
  }));
});
afterEach(() => { sessions.forEach(session => session.dispose()); sessions = []; vi.unstubAllGlobals(); });
async function sender() {
  const session = await createSender([new File(['hello'], 'hello.txt')], snapshot => snapshots.push(snapshot));
  sessions.push(session); return session;
}
async function pair() {
  const session = await sender(); const socket = FakeSocket.instances[0]; socket.open(); socket.message({ type: 'ready', role: 'sender' });
  await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('waiting'));
  socket.message({ type: 'pairing-pending' });
  await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('confirming'));
  await session.approvePairing();
  socket.message({ type: 'peer-ready' });
  await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1));
  return { session, socket, peer: FakePeer.instances[0] };
}

describe('browser session service boundaries', () => {
  it('shares only the six-digit code in the QR URL, never authentication credentials', async () => {
    await sender();
    const snapshot = snapshots.at(-1)!;
    expect(snapshot.pairingCode).toBe('001234');
    expect(snapshot.inviteUrl).toBe('http://localhost:5173/#code=001234');
    expect(snapshot.inviteUrl).not.toContain(room.key); expect(snapshot.inviteUrl).not.toContain(room.senderToken);
  });
  it('claims the code once in a JSON body and shows matching confirmation without exposing files', async () => {
    const senderSession = await sender(), senderSocket = FakeSocket.instances[0];
    senderSocket.open(); senderSocket.message({ type: 'ready', role: 'sender' }); senderSocket.message({ type: 'pairing-pending' });
    await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('confirming'));
    const senderPhrase = snapshots.at(-1)?.confirmationPhrase;
    expect(senderPhrase).toBe('ivory honey grove dune');
    const receiverSnapshots: SessionSnapshot[] = [];
    window.location.href = 'http://localhost:5173/#code=001234';
    const receiverSession = await startReceiving('001234', snapshot => receiverSnapshots.push(snapshot)); sessions.push(receiverSession);
    expect(fetch).toHaveBeenLastCalledWith('/v1/pairings', expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"001234"}' }));
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
    const receiverSocket = FakeSocket.instances[1]; receiverSocket.open(); receiverSocket.message({ type: 'ready', role: 'receiver' }); receiverSocket.message({ type: 'pairing-pending' });
    await vi.waitFor(() => expect(receiverSnapshots.at(-1)?.phase).toBe('confirming'));
    expect(receiverSnapshots.at(-1)?.confirmationPhrase).toBe(senderPhrase);
    expect(receiverSnapshots.at(-1)?.files).toEqual([]); expect(FakePeer.instances).toHaveLength(0);
    await expect(receiverSession.approvePairing()).rejects.toThrow('sender confirmation');
    await senderSession.approvePairing(); expect(FakePeer.instances).toHaveLength(0);
  });
  it.each(['12345', '1234567', '123a56', '12 3456', '１２３４５６'])('rejects malformed code %s before a network request', async code => {
    await expect(startReceiving(code, () => {})).rejects.toThrow('six-digit code'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([404, 409, 410])('explains invalid, expired, or reused lookup status %s', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
    await expect(startReceiving('123456', () => {})).rejects.toThrow('invalid, expired, or already used');
    expect(FakeSocket.instances).toHaveLength(0);
  });
  it('tells the receiver to get a new code if the single-use claim response is lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network failed'); }));
    await expect(startReceiving('123456', () => {})).rejects.toThrow('may already be used');
  });
  it('retires a claimed receiver exactly once when disposed before WebSocket authentication', async () => {
    const session = await startReceiving('001234', () => {}); sessions.push(session);
    expect(FakeSocket.instances[0].send).not.toHaveBeenCalled();
    session.dispose(); session.dispose(); session.cancel();
    expect(fetch).toHaveBeenLastCalledWith(`/v1/sessions/${room.id}`, expect.objectContaining({ method: 'DELETE', headers: { Authorization: `Bearer ${claimed.token}` }, keepalive: true }));
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect(FakeSocket.instances[0].readyState).toBe(3);
  });
  it('does not duplicate receiver deletion when cancellation is followed by disposal', async () => {
    const session = await startReceiving('001234', () => {}); sessions.push(session);
    session.cancel(); session.cancel(); session.dispose(); session.dispose();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });
  it('rejects a peer-ready event that bypasses explicit sender approval', async () => {
    await sender(); const socket = FakeSocket.instances[0]; socket.open(); socket.message({ type: 'ready', role: 'sender' }); socket.message({ type: 'pairing-pending' });
    await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('confirming'));
    socket.message({ type: 'peer-ready' }); await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('failed'));
    expect(snapshots.at(-1)?.message).toContain('skipped sender approval'); expect(FakePeer.instances).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite connecting when peer-ready arrives before the approval HTTP response', async () => {
    let resolveApproval!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (path.endsWith('/approve')) return new Promise<Response>(resolve => { resolveApproval = resolve; });
      return Response.json(path.endsWith('/ice') ? { iceServers: [], relayEnabled: false } : room);
    }));
    const session = await sender(), socket = FakeSocket.instances[0]; socket.open(); socket.message({ type: 'ready', role: 'sender' }); socket.message({ type: 'pairing-pending' });
    await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('confirming'));
    const approval = session.approvePairing(), repeated = session.approvePairing();
    expect(repeated).toBe(approval);
    await vi.waitFor(() => expect(resolveApproval).toBeTypeOf('function'));
    socket.message({ type: 'peer-ready' }); await vi.waitFor(() => expect(FakePeer.instances).toHaveLength(1));
    resolveApproval(new Response(null, { status: 204 })); await approval;
    expect(snapshots.at(-1)?.phase).toBe('connecting');
    expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/approve'))).toHaveLength(1);
  });
  it('cannot revive a cancelled pair from a delayed approval response or peer-ready event', async () => {
    let resolveApproval!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (path.endsWith('/approve')) return new Promise<Response>(resolve => { resolveApproval = resolve; });
      return Response.json(room);
    }));
    const session = await sender(), socket = FakeSocket.instances[0]; socket.open(); socket.message({ type: 'ready', role: 'sender' }); socket.message({ type: 'pairing-pending' });
    await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('confirming'));
    const approval = session.approvePairing(); await vi.waitFor(() => expect(resolveApproval).toBeTypeOf('function'));
    session.cancel(); socket.message({ type: 'peer-ready' }); resolveApproval(new Response(null, { status: 204 })); await approval;
    expect(snapshots.at(-1)?.phase).toBe('cancelled'); expect(FakePeer.instances).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/ice'))).toBe(false);
  });
  it('requires sender approval before ICE or any peer connection is created', async () => {
    const session = await sender(); expect(fetch).toHaveBeenCalledTimes(1); expect(FakePeer.instances).toHaveLength(0);
    const socket = FakeSocket.instances[0];
    expect(socket.url.pathname).toBe(`/v1/sessions/${room.id}`);
    expect(socket.url.search).toBe(''); expect(socket.url.hash).toBe('');
    socket.open(); expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'auth', role: 'sender', token: room.senderToken });
    socket.message({ type: 'ready', role: 'sender' });
    await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('waiting'));
    expect(fetch).toHaveBeenCalledTimes(1);
    socket.message({ type: 'pairing-pending' });
    await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('confirming'));
    expect(fetch).toHaveBeenCalledTimes(1); expect(FakePeer.instances).toHaveLength(0);
    expect(snapshots.at(-1)?.inviteUrl).toBeUndefined(); expect(snapshots.at(-1)?.pairingCode).toBeUndefined();
    expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).toEqual(['auth']);
    await session.approvePairing();
    expect(fetch).toHaveBeenLastCalledWith(`/v1/sessions/${room.id}/approve`, expect.objectContaining({ method: 'POST', headers: { Authorization: `Bearer ${room.senderToken}` } }));
    expect(FakePeer.instances).toHaveLength(0);
    socket.message({ type: 'peer-ready' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch).toHaveBeenLastCalledWith(`/v1/sessions/${room.id}/ice`, expect.objectContaining({ method: 'POST', headers: { Authorization: `Bearer ${room.senderToken}` } }));
  });
  it('sends the signed offer before a candidate emitted during setLocalDescription', async () => {
    const { socket } = await pair();
    await vi.waitFor(() => expect(socket.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === 'signal')).toHaveLength(2));
    const signals = socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(msg => msg.type === 'signal');
    expect(signals.map(msg => [msg.kind, msg.seq])).toEqual([['offer', 1], ['ice', 2]]);
    expect(signals.every(msg => typeof msg.mac === 'string')).toBe(true);
  });
  it('keeps an open data channel alive after signaling transport closes', async () => {
    const { socket, peer } = await pair(); peer.channel.open(); socket.close();
    expect(snapshots.at(-1)?.signalingConnected).toBe(false);
    expect(snapshots.at(-1)?.phase).not.toBe('failed'); expect(peer.close).not.toHaveBeenCalled();
    expect(peer.channel.readyState).toBe('open');
  });
  it('preserves the transfer when room expiry removes signaling', async () => {
    const { socket, peer } = await pair(); peer.channel.open(); socket.message({ type: 'error', code: 'expired', message: 'Room expired' });
    await vi.waitFor(() => expect(snapshots.at(-1)?.signalingConnected).toBe(false));
    expect(peer.close).not.toHaveBeenCalled(); expect(snapshots.at(-1)?.phase).not.toBe('failed');
  });
  it('fails closed when signaling disappears before a peer connection exists', async () => {
    await sender(); FakeSocket.instances[0].close();
    expect(snapshots.at(-1)?.phase).toBe('failed'); expect(snapshots.at(-1)?.message).toContain('fresh pairing code');
  });
  it('does not create a peer after cancellation while credentials are pending', async () => {
    let resolveIce!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
      if (init.method === 'DELETE' || path.endsWith('/approve')) return new Response(null, { status: 204 });
      if (path.endsWith('/ice')) return new Promise<Response>(resolve => { resolveIce = resolve; });
      return Response.json(room);
    }));
    const session = await sender(), socket = FakeSocket.instances[0]; socket.open(); socket.message({ type: 'ready', role: 'sender' }); socket.message({ type: 'pairing-pending' });
    await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('confirming')); await session.approvePairing(); socket.message({ type: 'peer-ready' });
    await vi.waitFor(() => expect(resolveIce).toBeTypeOf('function'));
    session.cancel(); resolveIce(Response.json({ iceServers: [], relayEnabled: false }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(FakePeer.instances).toHaveLength(0); expect(snapshots.at(-1)?.phase).toBe('cancelled');
  });
  it('shuts down signaling and peer resources if the file protocol fails', async () => {
    const { socket, peer } = await pair(); peer.channel.open(); peer.channel.onmessage?.({ data: 'not-json' });
    await vi.waitFor(() => expect(snapshots.at(-1)?.phase).toBe('failed'));
    expect(socket.readyState).toBe(3); expect(peer.close).toHaveBeenCalled();
  });
});
