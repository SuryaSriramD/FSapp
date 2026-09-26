import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { setTimeout as pause } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

// This records real transfers on one computer. The narrow page is a viewport
// simulation in desktop Chromium, not evidence of a physical phone/Safari test.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.resolve(webRoot, '..', '.artifacts', 'demo')
const baseURL = new URL(process.env.FSAPP_BASE_URL || 'http://127.0.0.1:8080')

async function cachedChromium() {
  if (process.env.FSAPP_CHROMIUM_EXECUTABLE) return process.env.FSAPP_CHROMIUM_EXECUTABLE
  if (existsSync(chromium.executablePath())) return undefined
  const roots = [path.join(homedir(), 'Library/Caches/ms-playwright'), path.join(homedir(), '.cache/ms-playwright')]
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'))
  for (const root of roots) {
    if (!existsSync(root)) continue
    const revisions = (await readdir(root)).filter((name) => name.startsWith('chromium_headless_shell-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const revision of revisions) {
      for (const relative of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-win64/chrome-headless-shell.exe']) {
        const executable = path.join(root, revision, relative)
        if (existsSync(executable)) return executable
      }
    }
  }
  throw new Error('Chromium is not installed. Run npx playwright install chromium or set FSAPP_CHROMIUM_EXECUTABLE.')
}

async function label(page, text) {
  // Annotation changes only the existing beta badge. It does not fake product
  // state, connection progress, receipts, network conditions, or performance.
  await page.locator('.beta-badge').evaluate((badge, value) => { badge.textContent = value }, text)
}

async function downloadAndVerify(page, expected) {
  const ready = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download file', exact: true }).click()
  const download = await ready
  const chunks = []
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), expected)
  await expect(page.getByText('Download requested', { exact: true })).toBeVisible()
}

await mkdir(output, { recursive: true })
const health = await globalThis.fetch(new URL('/actuator/health', baseURL), { signal: globalThis.AbortSignal.timeout(75_000) })
if (!health.ok) throw new Error('Start the packaged FSApp server before recording the demonstration.')

const browser = await chromium.launch({ executablePath: await cachedChromium() })
const senderContext = await browser.newContext({ viewport: { width: 1060, height: 900 }, acceptDownloads: true, recordVideo: { dir: output, size: { width: 1060, height: 900 } } })
let receiverContext
let senderVideo
let receiverVideo
let completed = false
const started = Date.now()
const evidence = { recordedAt: new Date().toISOString(), browser: browser.version(), environment: 'Two desktop Chromium contexts on one computer. The 390px receiver is a simulated narrow viewport, not a physical phone.', verifiedFiles: [], network: 'No claim of a different-network or forced-TURN test.', durationMs: 0 }

try {
  const sender = await senderContext.newPage()
  senderVideo = sender.video()
  sender.setDefaultTimeout(20_000)
  await sender.goto(baseURL.toString())
  await label(sender, 'DESKTOP DEMO')
  await sender.screenshot({ path: path.join(output, '01-desktop-home.png'), fullPage: true })
  process.stdout.write('Recording desktop sender and a clearly labelled simulated narrow receiver.\n')
  await pause(2500)

  const note = Buffer.from('Hello from FSApp.\n\nThis file was sent through an authenticated WebRTC connection.\nBoth browsers remained open.\nNo cloud file storage was used.\n')
  const binary = Buffer.alloc(8 * 1024 * 1024)
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 17 + 31) % 256
  const files = [
    { name: 'hello-from-fsapp.txt', mimeType: 'text/plain', buffer: note },
    { name: 'pattern-8-MiB.bin', mimeType: 'application/octet-stream', buffer: binary },
  ]
  await sender.getByLabel('Choose files', { exact: true }).setInputFiles(files)
  await sender.getByRole('button', { name: 'Create pairing code', exact: true }).scrollIntoViewIfNeeded()
  await pause(2000)
  await sender.getByRole('button', { name: 'Create pairing code', exact: true }).click()
  const pairingInput = sender.getByRole('textbox', { name: 'Pairing code', exact: true })
  await expect(pairingInput).toHaveValue(/^\d{6}$/)
  const code = await pairingInput.inputValue()
  await pairingInput.scrollIntoViewIfNeeded()
  await sender.screenshot({ path: path.join(output, '02-desktop-code.png'), fullPage: true })
  await pause(2500)

  receiverContext = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, recordVideo: { dir: output, size: { width: 390, height: 844 } } })
  const receiver = await receiverContext.newPage()
  receiverVideo = receiver.video()
  receiver.setDefaultTimeout(30_000)
  await receiver.goto(new URL('/?receive=1&save=download', baseURL).toString())
  await label(receiver, 'SIMULATED PHONE VIEWPORT')
  await receiver.getByLabel('Pairing code', { exact: true }).fill(`${code.slice(0, 3)} ${code.slice(3)}`)
  await pause(1500)
  await receiver.getByRole('button', { name: 'Connect to sender', exact: true }).click()
  await expect(sender.getByLabel('Confirmation phrase', { exact: true })).toBeVisible()
  await expect(receiver.getByLabel('Confirmation phrase', { exact: true })).toHaveText(await sender.getByLabel('Confirmation phrase', { exact: true }).innerText())
  await expect(receiver.getByRole('list', { name: 'Files', exact: true })).toHaveCount(0)
  await receiver.screenshot({ path: path.join(output, '03-simulated-viewport-confirmation.png'), fullPage: true })
  await sender.getByRole('button', { name: 'Approve connection', exact: true }).scrollIntoViewIfNeeded()
  await pause(2500)
  await sender.getByRole('button', { name: 'Approve connection', exact: true }).click()
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible()
  assert.equal(new URL(receiver.url()).hash, '')
  await receiver.screenshot({ path: path.join(output, '03b-simulated-viewport-file-consent.png'), fullPage: true })
  await pause(1500)

  for (const [index, file] of files.entries()) {
    await receiver.getByRole('button', { name: 'Accept file', exact: true }).scrollIntoViewIfNeeded()
    await pause(1800)
    const transferStarted = Date.now()
    await receiver.getByRole('button', { name: 'Accept file', exact: true }).click()
    await expect(receiver.getByRole('heading', { name: 'Received and verified', exact: true })).toBeVisible()
    evidence.verifiedFiles.push({ name: file.name, size: file.buffer.length, acceptToVerifiedMs: Date.now() - transferStarted })
    await receiver.getByRole('button', { name: 'Download file', exact: true }).scrollIntoViewIfNeeded()
    await pause(2500)
    await downloadAndVerify(receiver, file.buffer)
    await receiver.screenshot({ path: path.join(output, `0${index + 4}-simulated-viewport-verified.png`), fullPage: true })
    await pause(2500)
    await receiver.getByRole('button', { name: index === files.length - 1 ? 'Finish transfer' : 'Next file', exact: true }).click()
  }
  await expect(sender.getByRole('heading', { name: 'All done. All yours.', exact: true })).toBeVisible()
  await expect(receiver.getByRole('heading', { name: 'All done. All yours.', exact: true })).toBeVisible()
  await sender.getByRole('heading', { name: 'All done. All yours.', exact: true }).scrollIntoViewIfNeeded()
  await sender.screenshot({ path: path.join(output, '06-desktop-complete.png'), fullPage: true })
  evidence.durationMs = Date.now() - started
  // The pauses let viewers read actual states; never substitute fabricated progress.
  await pause(Math.max(3000, 42_000 - evidence.durationMs))
  await sender.getByRole('button', { name: 'Start a new transfer', exact: true }).click()
  completed = true
} finally {
  await receiverContext?.close()
  await senderContext.close()
  if (senderVideo) { await senderVideo.saveAs(path.join(output, 'desktop-sender.webm')); await senderVideo.delete() }
  if (receiverVideo) { await receiverVideo.saveAs(path.join(output, 'simulated-phone-viewport.webm')); await receiverVideo.delete() }
  await browser.close()
  evidence.durationMs = Date.now() - started
  await writeFile(path.join(output, 'recording.json'), `${JSON.stringify({ ...evidence, completed }, null, 2)}\n`)
}

process.stdout.write(`Verified two downloaded files byte-for-byte. Demo artifacts saved to ${output}\n`)
