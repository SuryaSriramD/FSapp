import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { once } from 'node:events';

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  const force = setTimeout(() => server.kill('SIGKILL'), 6000);
  try { await exited; } finally { clearTimeout(force); }
}
async function start(port: number): Promise<ChildProcess> {
  const jar = resolve(process.env.FSAPP_BUILD_DIR || '../backend/target', 'fsapp-server.jar');
  const child = spawn('java', ['-jar', jar], {
    // Dedicated test process: repeated claims must not consume production abuse budgets.
    env: { ...process.env, PORT: String(port), FSAPP_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, FSAPP_TURN_ENABLED: 'false', FSAPP_PAIRING_ATTEMPTS_PER_MINUTE: '1000', FSAPP_PAIRING_GLOBAL_ATTEMPTS_PER_MINUTE: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', data => { log = (log + String(data)).slice(-8000); });
  child.stderr?.on('data', data => { log = (log + String(data)).slice(-8000); });
  let startError: Error | undefined;
  child.on('error', error => { startError = error; });
  try {
    await expect.poll(async () => {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`Test server exited: ${log}`);
      try { return (await fetch(`http://127.0.0.1:${port}/actuator/health`)).status; } catch { return 0; }
    }, { timeout: 20000 }).toBe(200);
  } catch (error) { await stop(child); throw error; }
  return child;
}
async function pairing(page: Page, origin: string, size: number): Promise<{ code: string; id: string; token: string }> {
  await page.goto(origin);
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'restart.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(size, 37) });
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/sessions');
  await page.getByRole('button', { name: 'Create pairing code', exact: true }).click();
  const room = await (await created).json() as { id: string; senderToken: string };
  const input = page.getByRole('textbox', { name: 'Pairing code', exact: true });
  await expect(input).toHaveValue(/^\d{6}$/);
  return { code: await input.inputValue(), id: room.id, token: room.senderToken };
}

test('a real backend restart does not cancel an established file transfer', async ({ page, context, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'The process lifecycle regression runs once; protocol smoke runs in every engine.');
  test.skip(Boolean(process.env.FSAPP_SKIP_RESTART_TEST), 'An external-only test runner can opt out of spawning a local Java process.');
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  let server = await start(port);
  try {
    const size = 8 * 1024 * 1024;
    const room = await pairing(page, origin, size);
    const receiver = await context.newPage();
    // Add controlled write-ACK latency, keeping a real transfer in flight during restart.
    await receiver.addInitScript(() => {
      const send = RTCDataChannel.prototype.send as unknown as (this: RTCDataChannel, data: string | Blob | ArrayBuffer | ArrayBufferView) => void;
      RTCDataChannel.prototype.send = function(data: string | Blob | ArrayBuffer | ArrayBufferView) {
        if (typeof data === 'string' && JSON.parse(data).type === 'ack') {
          setTimeout(() => { if (this.readyState === 'open') send.call(this, data); }, 250);
        } else send.call(this, data);
      };
    });
    await receiver.goto(`${origin}/?receive=1&save=download`);
    await receiver.getByLabel('Pairing code', { exact: true }).fill(room.code);
    await receiver.getByRole('button', { name: 'Connect to sender', exact: true }).click();
    await expect(page.getByLabel('Confirmation phrase', { exact: true })).toBeVisible();
    await expect(receiver.getByLabel('Confirmation phrase', { exact: true })).toHaveText(await page.getByLabel('Confirmation phrase', { exact: true }).innerText());
    await page.getByRole('button', { name: 'Approve connection', exact: true }).click();
    await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible();
    await receiver.getByRole('button', { name: 'Accept file', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: 'On its way', exact: true })).toBeVisible();
    await stop(server);
    await expect(receiver.getByText('The connection service disconnected. Your existing peer connection can continue.', { exact: true })).toBeVisible();
    server = await start(port);
    expect((await fetch(`${origin}/v1/sessions/${room.id}/ice`, { method: 'POST', headers: { Authorization: `Bearer ${room.token}` } })).status).toBe(410);
    await expect(receiver.getByRole('heading', { name: 'Received and verified', exact: true })).toBeVisible({ timeout: 45000 });
    const downloaded = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: 'Download file', exact: true }).click();
    const stream = await (await downloaded).createReadStream();
    let total = 0;
    for await (const raw of stream) {
      const chunk = Buffer.from(raw);
      total += chunk.length;
      expect(chunk.every(value => value === 37)).toBe(true);
    }
    expect(total).toBe(size);
    await expect(page.getByRole('heading', { name: 'All done. All yours.', exact: true })).toBeVisible();
    await testInfo.attach('restart-evidence', { body: JSON.stringify({ realJavaProcessRestart: true, oldRoomStatus: 410, verifiedBytes: total, ackDelayMs: 250, environment: 'same host, direct Chromium transfer' }), contentType: 'application/json' });
  } finally { await stop(server); }
});
