import type { PairingCredentials, Role } from './types';
export interface Signal { type: 'signal'; version: 1; roomId: string; attemptId: string; role: Role; seq: number; kind: 'offer' | 'answer' | 'ice'; payload: string; mac: string }
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export function base64url(bytes: Uint8Array): string {
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unbase64url(value: string, maxBytes = 65536): Uint8Array<ArrayBuffer> {
  if (value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error('Invalid encoded value.');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (bytes.length > maxBytes || base64url(bytes) !== value) throw new Error('Invalid encoded value.');
  return bytes;
}
export function readPairingCode(href: string): string | null {
  try {
    const url = new URL(href), parameters = new URLSearchParams(url.hash.slice(1));
    const code = parameters.get('code');
    if (!['http:', 'https:'].includes(url.protocol) || parameters.size !== 1 || !code || !/^[0-9]{6}$/.test(code)) return null;
    return code;
  } catch { return null; }
}

export function validateCredentials(value: PairingCredentials): void {
  if (!value || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(value.id)
      || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)
      || typeof value.key !== 'string' || unbase64url(value.key, 32).length !== 32
      || typeof value.attempt !== 'string' || unbase64url(value.attempt, 16).length !== 16) throw new Error('The connection service returned invalid pairing credentials.');
}

// Four independent six-bit words give a 24-bit visual comparison phrase.
// This helps users confirm the intended pairing; the service still knows the key.
const CONFIRMATION_WORDS = [
  'acorn', 'amber', 'apple', 'apron', 'arrow', 'atlas', 'badge', 'bamboo', 'beach', 'berry', 'birch', 'bloom', 'boat', 'brass', 'bread', 'breeze',
  'brook', 'cabin', 'cactus', 'candle', 'cedar', 'cherry', 'cloud', 'clover', 'coast', 'coral', 'daisy', 'dawn', 'delta', 'dune', 'eagle', 'ember',
  'fern', 'field', 'flame', 'forest', 'frost', 'garden', 'glass', 'grape', 'grove', 'harbor', 'hazel', 'honey', 'island', 'ivory', 'jade', 'lemon',
  'lilac', 'lotus', 'maple', 'meadow', 'mint', 'moon', 'olive', 'orchid', 'pearl', 'pine', 'plum', 'pond', 'reed', 'river', 'robin', 'stone',
] as const;
export async function deriveConfirmationPhrase(credentials: Pick<PairingCredentials, 'id' | 'key' | 'attempt'>): Promise<string> {
  const input = encoder.encode(JSON.stringify(['fsapp.v1.confirmation', credentials.id, credentials.attempt, credentials.key]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  const value = (digest[0] << 16) | (digest[1] << 8) | digest[2];
  return [18, 12, 6, 0].map(shift => CONFIRMATION_WORDS[(value >>> shift) & 63]).join(' ');
}
export function canonicalSignal(s: Omit<Signal, 'mac'>): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([s.version, s.roomId, s.attemptId, s.role, s.seq, s.kind, s.payload]));
}
export class SignalingAuth {
  private outSeq = 0;
  private inSeq = 0;
  private constructor(private roomId: string, private attemptId: string, private role: Role, private sendKey: CryptoKey, private receiveKey: CryptoKey) {}
  static async create(key: string, roomId: string, attemptId: string, role: Role): Promise<SignalingAuth> {
    const secret = unbase64url(key, 32);
    if (secret.length !== 32) throw new Error('Invalid pairing key.');
    const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const derive = (direction: Role) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('fsapp.v1.signaling'), info: encoder.encode(JSON.stringify([1, roomId, attemptId, direction])) }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
    const [sender, receiver] = await Promise.all([derive('sender'), derive('receiver')]);
    return new SignalingAuth(roomId, attemptId, role, role === 'sender' ? sender : receiver, role === 'sender' ? receiver : sender);
  }
  async sign(kind: Signal['kind'], payload: unknown): Promise<Signal> {
    const bytes = encoder.encode(JSON.stringify(payload));
    if (bytes.length > 32 * 1024) throw new Error('Connection message is too large.');
    const signal: Omit<Signal, 'mac'> = { type: 'signal', version: 1, roomId: this.roomId, attemptId: this.attemptId, role: this.role, seq: ++this.outSeq, kind, payload: base64url(bytes) };
    const mac = await crypto.subtle.sign('HMAC', this.sendKey, canonicalSignal(signal));
    return { ...signal, mac: base64url(new Uint8Array(mac)) };
  }
  async verify(input: unknown): Promise<{ kind: Signal['kind']; payload: unknown }> {
    const s = input as Signal;
    if (!s || s.type !== 'signal' || s.version !== 1 || s.roomId !== this.roomId || s.attemptId !== this.attemptId || s.role === this.role || !['sender', 'receiver'].includes(s.role) || !Number.isSafeInteger(s.seq) || s.seq !== this.inSeq + 1 || !['offer', 'answer', 'ice'].includes(s.kind) || typeof s.payload !== 'string' || typeof s.mac !== 'string') throw new Error('Connection authentication failed. Create a fresh pairing code.');
    if ((s.kind === 'offer' && s.role !== 'sender') || (s.kind === 'answer' && s.role !== 'receiver')) throw new Error('Invalid connection role.');
    const mac = unbase64url(s.mac, 32), data = unbase64url(s.payload, 32 * 1024);
    if (mac.length !== 32 || !await crypto.subtle.verify('HMAC', this.receiveKey, mac, canonicalSignal(s))) throw new Error('Connection authentication failed. Create a fresh pairing code.');
    const payload: unknown = JSON.parse(decoder.decode(data));
    this.inSeq = s.seq;
    return { kind: s.kind, payload };
  }
}
