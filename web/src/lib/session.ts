import { deriveConfirmationPhrase, readPairingCode, SignalingAuth, validateCredentials } from './crypto';
import type { Signal } from './crypto';
import { MAX_FILE_BYTES, MAX_FILES, validateSelection } from './protocol';
import { TransferEngine } from './transfer';
import type { PairingCredentials, OnChange, Role, SessionOptions, SessionSnapshot, TransferSession } from './types';

interface CreatedRoom { id: string; senderToken: string; code: string; key: string; attempt: string; expiresAt: string; maxFiles: number; maxFileBytes: number }
interface ClaimedPairing extends PairingCredentials { expiresAt: string }
interface IceResponse { iceServers: RTCIceServer[]; relayEnabled: boolean }
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Connection failed.';
const delayError = 'Connection service did not respond. It may be waking up; retry shortly.';

async function request<T>(path: string, method: string, token?: string, parentSignal?: AbortSignal, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { method, signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal, headers: Object.keys(headers).length ? headers : undefined, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', keepalive: method === 'DELETE' });
    if (!response.ok) {
      if (path === '/v1/pairings' && [404, 409, 410].includes(response.status)) throw new Error('This code is invalid, expired, or already used. Ask the sender for a new code.');
      if (path === '/v1/pairings' && response.status === 429) throw new Error('Too many pairing attempts. Wait a minute, then ask the sender for a new code.');
      if (response.status === 404 || response.status === 410) throw new Error('This pairing has expired. Ask the sender for a new code.');
      if (response.status === 409) throw new Error('The receiver is no longer waiting. Create a fresh pairing code.');
      if (response.status === 429 || response.status === 503) throw new Error('The connection service is busy or relay capacity is unavailable. Retry shortly.');
      if (response.status === 401 || response.status === 403) throw new Error('The pairing could not be authorized. Ask the sender for a new code.');
      throw new Error('The connection service could not complete the request. Retry with a fresh pairing code.');
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  } catch (error) {
    if (path === '/v1/pairings' && (controller.signal.aborted || error instanceof TypeError || error instanceof SyntaxError)) throw new Error('The code lookup was interrupted. This code may already be used; ask the sender for a new code.', { cause: error });
    if (controller.signal.aborted) throw new Error(delayError, { cause: error });
    throw error;
  } finally { clearTimeout(timeout); }
}
function initialState(role: Role): SessionSnapshot {
  return { role, phase: 'creating', message: 'Starting the connection service…', files: [], route: 'pending', signalingConnected: false, metrics: { startedAt: Date.now(), bytesTransferred: 0, bufferedBytes: 0, maxBufferedBytes: 0 } };
}

class BrowserSession implements TransferSession {
  private pc?: RTCPeerConnection;
  private ws?: WebSocket;
  private channel?: RTCDataChannel;
  private engine?: TransferEngine;
  private auth?: SignalingAuth;
  private incoming = Promise.resolve();
  private outgoing = Promise.resolve();
  private incomingCount = 0;
  private incomingBytes = 0;
  private localIce: (RTCIceCandidateInit | null)[] = [];
  private remoteIce: (RTCIceCandidateInit | null)[] = [];
  private localCandidateCount = 0;
  private remoteCandidateCount = 0;
  private serviceAbort = new AbortController();
  private descriptionSent = false;
  private negotiated = false;
  private confirmationPending = false;
  private approvalRequested = false;
  private approvalInFlight?: Promise<void>;
  private authenticated = false;
  private disposed = false;
  private closeRequested = false;
  private setupTimer?: ReturnType<typeof setTimeout>;
  private statsTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  constructor(private state: SessionSnapshot, private files: File[], private credentials: PairingCredentials, private token: string, private onChange: OnChange, private options: SessionOptions) {}

  publish = (): void => {
    if (['failed', 'cancelled', 'complete'].includes(this.state.phase)) {
      clearTimeout(this.setupTimer); clearInterval(this.statsTimer);
    }
    if (['failed', 'cancelled'].includes(this.state.phase)) this.cleanupConnections();
    if (!this.disposed) this.onChange({ ...this.state, files: this.state.files.map(f => ({ ...f })), received: this.state.received ? { ...this.state.received } : undefined, metrics: { ...this.state.metrics } });
  };
  async start(): Promise<void> {
    this.publish();
    try {
      validateCredentials(this.credentials);
      const [auth, phrase] = await Promise.all([
        SignalingAuth.create(this.credentials.key, this.credentials.id, this.credentials.attempt, this.state.role),
        deriveConfirmationPhrase(this.credentials),
      ]);
      this.auth = auth; this.state.confirmationPhrase = phrase;
      if (this.disposed) return;
      const url = new URL(`/v1/sessions/${this.credentials.id}`, window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = this.ws = new WebSocket(url);
      this.setupTimer = setTimeout(() => this.fail(delayError), 20_000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', role: this.state.role, token: this.token }));
      ws.onmessage = event => {
        if (typeof event.data !== 'string' || event.data.length > 70_000 || this.incomingCount >= 128 || this.incomingBytes + event.data.length > 1024 * 1024) { this.fail('Connection message limit exceeded.'); return; }
        const raw = event.data;
        this.incomingCount++; this.incomingBytes += raw.length;
        this.incoming = this.incoming.then(() => this.signalMessage(raw)).catch(error => this.fail(messageOf(error))).finally(() => { this.incomingCount--; this.incomingBytes -= raw.length; });
      };
      ws.onclose = () => this.signalingLost();
      ws.onerror = () => { /* onclose supplies the definitive state. */ };
      this.statsTimer = setInterval(() => { void this.updateRoute(); }, 3000);
    } catch (error) { this.fail(messageOf(error)); }
  }
  private async initializePeer(): Promise<void> {
    const ice = await request<IceResponse>(`/v1/sessions/${this.credentials.id}/ice`, 'POST', this.token, this.serviceAbort.signal);
    if (this.disposed || ['failed', 'cancelled'].includes(this.state.phase)) return;
      if (!Array.isArray(ice.iceServers)) throw new Error('The service returned invalid connection settings.');
      if (this.options.forceRelay && !ice.relayEnabled) throw new Error('Relay is unavailable. Enable managed TURN before testing a forced-relay connection.');
      const pc = this.pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: this.options.forceRelay ? 'relay' : 'all' });
      pc.onicecandidate = event => {
        if (++this.localCandidateCount > 128) { this.fail('Too many connection candidates.'); return; }
        const candidate = event.candidate?.toJSON() ?? null;
        if (!this.descriptionSent) {
          if (this.localIce.length >= 128) { this.fail('Too many connection candidates.'); return; }
          this.localIce.push(candidate);
        } else void this.sendSignal('ice', candidate);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') this.fail('A peer connection could not be maintained. Check the network and create a new invitation.');
        if (pc.connectionState === 'disconnected' && this.channel?.readyState !== 'open') this.fail('The peer disconnected. Create a new pairing code to restart.');
        if (pc.connectionState === 'connected') void this.updateRoute();
      };
      if (this.state.role === 'sender') this.attach(pc.createDataChannel('fsapp-v1', { ordered: true }));
      else pc.ondatachannel = event => {
        if (this.channel || event.channel.label !== 'fsapp-v1' || !event.channel.ordered || event.channel.maxRetransmits !== null || event.channel.maxPacketLifeTime !== null) { event.channel.close(); this.fail('Unexpected peer data channel.'); return; }
        this.attach(event.channel);
      };
  }
  private attach(channel: RTCDataChannel): void {
    this.channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 64 * 1024;
    this.engine = new TransferEngine(this.state, this.files, channel, this.publish, this.options);
    channel.onopen = () => { clearTimeout(this.setupTimer); this.engine?.open(); void this.updateRoute(); };
    channel.onmessage = event => this.engine?.receive(event.data);
    channel.onbufferedamountlow = () => this.engine?.bufferedLow();
    channel.onclose = () => this.engine?.closed();
    channel.onerror = () => { if (channel.readyState !== 'open') this.engine?.closed(); };
  }
  private async signalMessage(raw: string): Promise<void> {
    if (this.disposed || ['failed', 'cancelled'].includes(this.state.phase)) return;
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (!msg || typeof msg !== 'object') throw new Error('Invalid connection service message.');
    if (msg.type === 'ready') {
      if (this.authenticated || msg.role !== this.state.role) throw new Error('Invalid connection role.');
      this.authenticated = true;
      clearTimeout(this.setupTimer); this.state.signalingConnected = true;
      this.heartbeatTimer = setInterval(() => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping' })); }, 25_000);
      this.state.phase = 'waiting'; this.state.message = this.state.role === 'sender' ? 'Show the six-digit code to the receiving device.' : 'Waiting for the sender to connect…'; this.publish(); return;
    }
    if (msg.type === 'pong') return;
    if (!this.authenticated && msg.type !== 'error') throw new Error('The connection service skipped participant authorization.');
    if (msg.type === 'pairing-pending') {
      if (this.confirmationPending || this.negotiated) throw new Error('Unexpected repeated pairing confirmation.');
      this.confirmationPending = true; this.state.phase = 'confirming';
      this.state.pairingCode = undefined; this.state.inviteUrl = undefined;
      this.state.message = this.state.role === 'sender' ? 'Compare the four words on both devices. Approve only if they match.' : 'Compare these four words with the sending device, then ask the sender to approve.';
      this.publish(); return;
    }
    if (msg.type === 'peer-ready') {
      if (this.negotiated || !this.confirmationPending || (this.state.role === 'sender' && !this.approvalRequested)) throw new Error('The connection service skipped sender approval.');
      this.negotiated = true; this.state.phase = 'connecting'; this.state.message = 'Connecting the two devices…'; this.publish();
      clearTimeout(this.setupTimer);
      this.setupTimer = setTimeout(() => this.fail('Could not connect the devices. Try another network or enable relay, then create a fresh pairing code.'), 60_000);
      await this.initializePeer();
      if (!this.pc || this.disposed || ['failed', 'cancelled'].includes(this.state.phase)) return;
      if (this.state.role === 'sender') {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        await this.sendDescription('offer');
      }
      return;
    }
    if (msg.type === 'peer-left') { this.signalingLost(); return; }
    if (msg.type === 'error') {
      if (this.channel?.readyState === 'open' && ['expired', 'session_closed'].includes(String(msg.code))) { this.signalingLost(); return; }
      throw new Error(typeof msg.message === 'string' ? msg.message.slice(0, 240) : 'The connection service rejected this session.');
    }
    if (msg.type !== 'signal' || !this.auth || !this.pc) throw new Error('Unsupported connection message.');
    const verified = await this.auth.verify(msg);
    if (verified.kind === 'ice') {
      if (++this.remoteCandidateCount > 128) throw new Error('Too many peer candidates.');
      const candidate = this.parseIce(verified.payload);
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate);
      else { if (this.remoteIce.length >= 128) throw new Error('Too many peer candidates.'); this.remoteIce.push(candidate); }
      return;
    }
    const description = verified.payload as RTCSessionDescriptionInit;
    if (!description || description.type !== verified.kind || typeof description.sdp !== 'string' || description.sdp.length > 32 * 1024 || this.pc.remoteDescription) throw new Error('Invalid or repeated peer description.');
    if ((verified.kind === 'offer' && this.state.role !== 'receiver') || (verified.kind === 'answer' && this.state.role !== 'sender')) throw new Error('Invalid peer role.');
    await this.pc.setRemoteDescription({ type: description.type, sdp: description.sdp });
    for (const candidate of this.remoteIce.splice(0)) await this.pc.addIceCandidate(candidate);
    if (verified.kind === 'offer') {
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this.sendDescription('answer');
    }
  }
  private parseIce(payload: unknown): RTCIceCandidateInit | null {
    if (payload === null) return null;
    const x = payload as RTCIceCandidateInit;
    if (!x || typeof x !== 'object' || typeof x.candidate !== 'string' || x.candidate.length > 4096 || (x.sdpMid != null && (typeof x.sdpMid !== 'string' || x.sdpMid.length > 128)) || (x.sdpMLineIndex != null && (!Number.isInteger(x.sdpMLineIndex) || x.sdpMLineIndex < 0 || x.sdpMLineIndex > 128))) throw new Error('Invalid peer candidate.');
    return { candidate: x.candidate, sdpMid: x.sdpMid, sdpMLineIndex: x.sdpMLineIndex, usernameFragment: typeof x.usernameFragment === 'string' ? x.usernameFragment.slice(0, 256) : undefined };
  }
  private async sendDescription(kind: 'offer' | 'answer'): Promise<void> {
    const description = this.pc?.localDescription;
    if (!description) throw new Error('Could not create a peer description.');
    await this.sendSignal(kind, { type: kind, sdp: description.sdp });
    this.descriptionSent = true;
    for (const candidate of this.localIce.splice(0)) await this.sendSignal('ice', candidate);
  }
  private sendSignal(kind: Signal['kind'], payload: unknown): Promise<void> {
    this.outgoing = this.outgoing.then(async () => {
      if (this.disposed || this.ws?.readyState !== WebSocket.OPEN || !this.auth) throw new Error('Signaling is unavailable. Create a new pairing code if the peer connection fails.');
      const signed = await this.auth.sign(kind, payload);
      if (this.ws.bufferedAmount > 256 * 1024) throw new Error('The connection service is not keeping up. Retry shortly.');
      this.ws.send(JSON.stringify(signed));
    });
    // Handle event-triggered promises while preserving the awaited rejection for negotiation.
    void this.outgoing.catch(error => { if (this.channel?.readyState !== 'open') this.fail(messageOf(error)); });
    return this.outgoing;
  }
  private signalingLost(): void {
    if (this.disposed) return;
    this.state.signalingConnected = false; clearInterval(this.heartbeatTimer);
    if (this.channel?.readyState === 'open' || this.state.phase === 'complete' || (this.state.received && this.state.files.every(file => file.status === 'verified'))) { this.publish(); return; }
    this.fail('The pairing service disconnected. It may have restarted or the pairing code expired. Create a fresh pairing code.');
  }
  private async updateRoute(): Promise<void> {
    try {
      if (!this.pc || this.pc.connectionState !== 'connected') return;
      const stats = await this.pc.getStats();
      let pair: RTCStats | undefined;
      stats.forEach(report => { if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId); });
      if (!pair) stats.forEach(report => { if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) pair = report; });
      if (pair) {
        const selected = pair as RTCStats & { localCandidateId: string; remoteCandidateId: string };
        const local = stats.get(selected.localCandidateId), remote = stats.get(selected.remoteCandidateId);
        const route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
        if (this.state.route !== route) { this.state.route = route; this.publish(); }
      }
    } catch { /* Older browsers may not expose selected-pair statistics. */ }
  }
  private fail(message: string): void {
    if (this.disposed || ['failed', 'cancelled', 'complete'].includes(this.state.phase)) return;
    if (this.engine) this.engine.fail(message);
    else { this.state.error = message; this.state.phase = 'failed'; this.state.message = message; this.publish(); }
    this.cleanupConnections();
  }
  approvePairing(): Promise<void> {
    if (this.approvalInFlight) return this.approvalInFlight;
    if (this.disposed || this.state.role !== 'sender' || this.state.phase !== 'confirming' || !this.confirmationPending) return Promise.reject(new Error('Pairing is not awaiting sender confirmation.'));
    this.approvalRequested = true;
    this.approvalInFlight = request<void>(`/v1/sessions/${this.credentials.id}/approve`, 'POST', this.token, this.serviceAbort.signal).then(() => {
      if (this.state.phase === 'confirming') { this.state.message = 'Approved. Connecting to the receiving device…'; this.publish(); }
    }).catch(error => {
      if (this.disposed || ['cancelled', 'failed'].includes(this.state.phase)) return;
      throw error;
    }).finally(() => { this.approvalInFlight = undefined; });
    return this.approvalInFlight;
  }
  accept(): Promise<void> { return this.engine?.accept() ?? Promise.resolve(); }
  download(): void { this.engine?.download(); }
  nextFile(): Promise<void> { return this.engine?.nextFile() ?? Promise.resolve(); }
  cancel(): void {
    if (this.disposed) return;
    if (this.engine) this.engine.cancel();
    else { this.state.phase = 'cancelled'; this.state.message = 'Pairing cancelled.'; this.publish(); }
    this.cleanupConnections();
    this.closeRoom();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.engine?.dispose(); this.cleanupConnections();
    this.closeRoom();
  }
  private closeRoom(): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    // A claimed receiver may be cancelled before its socket authenticates; explicit deletion
    // prevents the consumed code leaving its sender waiting for the full invitation lifetime.
    void request<void>(`/v1/sessions/${this.credentials.id}`, 'DELETE', this.token).catch(() => {});
  }
  private cleanupConnections(): void {
    clearTimeout(this.setupTimer); clearInterval(this.statsTimer); clearInterval(this.heartbeatTimer);
    this.serviceAbort.abort();
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.pc?.close(); this.state.signalingConnected = false;
  }
}

export async function createSender(files: File[], onChange: OnChange, options: SessionOptions = {}): Promise<TransferSession> {
  const error = validateSelection(files); if (error) throw new Error(error);
  const state = initialState('sender');
  state.files = files.map((file, id) => ({ id, name: file.name, size: file.size, progress: 0, status: 'pending' }));
  onChange({ ...state, files: state.files.map(file => ({ ...file })), metrics: { ...state.metrics } });
  const room = await request<CreatedRoom>('/v1/sessions', 'POST');
  if (!room || room.maxFiles !== MAX_FILES || room.maxFileBytes !== MAX_FILE_BYTES || typeof room.senderToken !== 'string') throw new Error('The connection service uses an incompatible protocol.');
  if (typeof room.code !== 'string' || !/^[0-9]{6}$/.test(room.code)) throw new Error('The connection service returned an invalid pairing code.');
  const credentials: PairingCredentials = { id: room.id, token: room.senderToken, key: room.key, attempt: room.attempt };
  validateCredentials(credentials);
  const url = new URL('/', window.location.origin);
  url.hash = new URLSearchParams({ code: room.code }).toString();
  state.pairingCode = room.code; state.inviteUrl = url.href;
  const session = new BrowserSession(state, [...files], credentials, room.senderToken, onChange, options);
  await session.start(); return session;
}
export async function startReceiving(code: string, onChange: OnChange, options: SessionOptions = {}): Promise<TransferSession> {
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code.trim())) throw new Error('Enter the six-digit code shown on the sending device.');
  code = code.trim();
  // A reload deliberately requires a newly created code; do not persist pairing credentials.
  if (readPairingCode(window.location.href) === code) history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  const state = initialState('receiver');
  state.message = 'Checking the pairing code…';
  onChange({ ...state, files: [], metrics: { ...state.metrics } });
  const credentials = await request<ClaimedPairing>('/v1/pairings', 'POST', undefined, undefined, { code });
  validateCredentials(credentials);
  const session = new BrowserSession(state, [], credentials, credentials.token, onChange, options);
  await session.start(); return session;
}
