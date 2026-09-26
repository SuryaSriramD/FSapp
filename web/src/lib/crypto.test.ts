import { describe, expect, it } from 'vitest';
import { base64url, canonicalSignal, deriveConfirmationPhrase, readPairingCode, SignalingAuth, unbase64url, validateCredentials } from './crypto';

const key = base64url(new Uint8Array(32).fill(7)), attempt = base64url(new Uint8Array(16).fill(3)), room = 'room_0123456789';
const participants = () => Promise.all([SignalingAuth.create(key, room, attempt, 'sender'), SignalingAuth.create(key, room, attempt, 'receiver')]);
describe('pairing codes and authenticated signaling', () => {
  it('roundtrips canonical base64url and rejects noncanonical aliases', () => {
    expect(unbase64url(base64url(new Uint8Array([0, 255, 127])))).toEqual(new Uint8Array([0, 255, 127]));
    expect(() => unbase64url('AB')).toThrow();
    expect(() => unbase64url('AA==')).toThrow();
  });
  it('reads exactly six digits from the fragment and preserves leading zeroes', () => {
    expect(readPairingCode('https://example.com/#code=001234')).toBe('001234');
    expect(readPairingCode('https://example.com/?save=download#code=123456')).toBe('123456');
    expect(readPairingCode('https://example.com/?code=123456')).toBeNull();
    expect(readPairingCode('https://example.com/#code=12345')).toBeNull();
    expect(readPairingCode('https://example.com/#code=1234567')).toBeNull();
    expect(readPairingCode('https://example.com/#code=12ab56')).toBeNull();
    expect(readPairingCode('https://example.com/#code=123456&code=987654')).toBeNull();
    expect(readPairingCode('https://example.com/#code=123456&key=secret')).toBeNull();
    expect(readPairingCode(`https://example.com/?join=${room}#token=${'t'.repeat(43)}&key=${key}&attempt=${attempt}`)).toBeNull();
  });
  it('validates strong server credentials separately from the short code', () => {
    const credentials = { id: 'r'.repeat(24), token: 't'.repeat(43), key, attempt };
    expect(() => validateCredentials(credentials)).not.toThrow();
    expect(() => validateCredentials({ ...credentials, key: '123456' })).toThrow();
    expect(() => validateCredentials({ ...credentials, attempt: '123456' })).toThrow();
    expect(() => validateCredentials({ ...credentials, token: 'short' })).toThrow();
    expect(() => validateCredentials({ ...credentials, id: '../../etc/passwd' })).toThrow();
  });
  it('derives the same four-word comparison phrase on both devices and binds room, attempt, and strong key', async () => {
    const credentials = { id: 'r'.repeat(24), key, attempt };
    const phrase = await deriveConfirmationPhrase(credentials);
    // Frozen Node/OpenSSL SHA-256 fixture for interoperable clients.
    expect(phrase).toBe('ivory honey grove dune');
    expect(phrase.split(' ')).toHaveLength(4);
    expect(await deriveConfirmationPhrase({ ...credentials })).toBe(phrase);
    expect(await deriveConfirmationPhrase({ ...credentials, id: 's'.repeat(24) })).not.toBe(phrase);
    expect(await deriveConfirmationPhrase({ ...credentials, attempt: base64url(new Uint8Array(16).fill(4)) })).not.toBe(phrase);
    expect(await deriveConfirmationPhrase({ ...credentials, key: base64url(new Uint8Array(32).fill(8)) })).not.toBe(phrase);
  });
  it('authenticates a complete SDP payload in both directions', async () => {
    const [sender, receiver] = await participants();
    const offer = await sender.sign('offer', { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 01:23\r\n' });
    // Independent Node/OpenSSL HKDF + HMAC fixture, frozen for future native clients.
    expect(offer.mac).toBe('XRF25NjQgWJN-JRvRJzqHi03_uHwGii-i0LZaNoca7w');
    expect(new TextDecoder().decode(canonicalSignal(offer))).toBe(JSON.stringify([1, room, attempt, 'sender', 1, 'offer', offer.payload]));
    expect(await receiver.verify(offer)).toEqual({ kind: 'offer', payload: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 01:23\r\n' } });
    expect((await sender.verify(await receiver.sign('answer', { type: 'answer', sdp: 'answer' }))).kind).toBe('answer');
  });
  it('rejects a different invitation secret', async () => {
    const [sender] = await participants();
    const wrong = await SignalingAuth.create(base64url(new Uint8Array(32).fill(8)), room, attempt, 'receiver');
    await expect(wrong.verify(await sender.sign('offer', { type: 'offer', sdp: 'test' }))).rejects.toThrow('authentication');
  });
  it('rejects altered SDP fingerprints before consuming a sequence number', async () => {
    const [sender, receiver] = await participants();
    const offer = await sender.sign('offer', { type: 'offer', sdp: 'fingerprint:original' });
    await expect(receiver.verify({ ...offer, payload: base64url(new TextEncoder().encode(JSON.stringify({ type: 'offer', sdp: 'fingerprint:attacker' }))) })).rejects.toThrow('authentication');
    await expect(receiver.verify(offer)).resolves.toHaveProperty('kind', 'offer');
  });
  it('rejects replay, skipped sequence, wrong room, wrong attempt, and reflected roles', async () => {
    const [sender, receiver] = await participants();
    const offer = await sender.sign('offer', {});
    await expect(receiver.verify({ ...offer, seq: 2 })).rejects.toThrow();
    await expect(receiver.verify({ ...offer, roomId: 'wrongroom' })).rejects.toThrow();
    await expect(receiver.verify({ ...offer, attemptId: 'wrongattempt' })).rejects.toThrow();
    await expect(receiver.verify({ ...offer, role: 'receiver' })).rejects.toThrow();
    await receiver.verify(offer);
    await expect(receiver.verify(offer)).rejects.toThrow();
  });
  it('rejects a valid MAC used for an invalid role action', async () => {
    const [sender, receiver] = await participants();
    await expect(receiver.verify(await sender.sign('answer', {}))).rejects.toThrow('role');
  });
});
