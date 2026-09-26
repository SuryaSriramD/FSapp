import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setInterval, clearInterval } from 'node:timers'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath, URL } from 'node:url'
import { promisify } from 'node:util'

// Measures real packaged-app transfers. It neither imports nor replaces application modules.
const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, '.artifacts', 'benchmarks')
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const resultPath = path.join(output, `chromium-${stamp}.json`)
const fixtureDir = path.join(output, 'fixtures')
const baseURL = new URL(process.env.FSAPP_BASE_URL || 'http://127.0.0.1:8080')
const sampleIntervalMs = 250
const withHeap = process.env.FSAPP_BENCH_HEAP !== '0'
const result = {
  schemaVersion: 2, recordedAt: new Date().toISOString(), completed: false,
  environment: {
    baseURL: baseURL.origin, browser: '', platform: platform(), osRelease: release(), arch: arch(),
    cpu: cpus()[0]?.model, totalSystemMemoryBytes: totalmem(), node: process.version,
    topology: 'Two isolated desktop Chromium contexts in one dedicated browser process tree on one host; packaged Spring application on loopback HTTP.',
    serviceState: 'Warm service: an application health check completes before timing starts. These figures do not include a managed-host cold start.',
    receivingStorage: 'Single-file Blob fallback explicitly selected using save=download.',
    concurrentSystemWorkload: 'Not controlled. Other applications and test jobs may be running; their RSS is excluded but CPU contention is possible.',
  },
  methodology: {
    repetitionsPerSize: 1,
    pairing: 'Monotonic elapsed time from clicking Create pairing code through numeric code entry, matching phrase verification and automated sender approval to receiver file consent becoming visible. Navigation-to-consent and approval-to-consent are reported separately. No human decision delay is represented.',
    transfer: 'Monotonic elapsed time from clicking Accept file until Received and verified is visible. Includes browser UI/automation latency; excludes subsequent download/export and comparison.',
    dataChannel: 'Sender RTCDataChannel.send is transparently observed. Native bufferedAmount is read immediately after each send, recording exact observed peaks without periodic-sampling aliasing.',
    rss: 'Every 250 ms, ps reports resident-set KiB for only this script-owned Chromium root PID and descendants. Sum converted to bytes; shared resident pages may be counted more than once. Node, Java, and other Chromium instances are excluded.',
    jsHeap: 'Optional Runtime.getHeapUsage.usedSize per page through CDP. This excludes Blob/file payload storage, off-heap/native WebRTC buffers, and other browser processes. It is not total memory.',
    cleanup: 'Memory is sampled one second after explicit UI file release and after contexts close. No forced garbage collection; a lack of immediate RSS reduction does not establish a leak.',
    limitations: 'One same-host desktop run is not evidence of internet throughput, TURN performance, physical phone/Safari behavior, or a universal/mobile memory bound. Instrumentation and sampling add overhead.',
  },
  pairing: {}, transfers: [], memorySamples: [], checkpoints: [], applicationAssets: [],
}

async function fixture(sizeMiB) {
  const name = `pattern-${sizeMiB}-MiB.bin`, filename = path.join(fixtureDir, name)
  const file = await open(filename, 'w'), hash = createHash('sha256'), block = Buffer.alloc(1024 * 1024)
  try {
    for (let blockIndex = 0; blockIndex < sizeMiB; blockIndex++) {
      for (let i = 0; i < block.length; i++) block[i] = (i * 17 + blockIndex * 31 + 7) % 256
      hash.update(block)
      let written = 0
      while (written < block.length) written += (await file.write(block, written, block.length - written)).bytesWritten
    }
  } finally { await file.close() }
  return { name, filename, bytes: sizeMiB * 1024 * 1024, sha256: hash.digest('hex') }
}

async function ownBrowserRss(rootPid) {
  if (!['darwin', 'linux'].includes(platform())) return null
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss='], { maxBuffer: 4 * 1024 * 1024, timeout: 3000 })
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
  const pids = new Set([rootPid])
  let changed = true
  while (changed) { changed = false; for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); changed = true } }
  const own = rows.filter(([pid]) => pids.has(pid))
  return { bytes: own.reduce((sum, [, , rssKiB]) => sum + rssKiB * 1024, 0), processCount: own.length }
}

function observeSender() {
  const observation = { channelCount: 0, maxRtcBufferedBytes: 0, binaryFrames: 0, maxBinaryFrameBytes: 0, files: {}, peers: [] }
  globalThis.__fsappBenchmark = observation
  const originalCreate = globalThis.RTCPeerConnection.prototype.createDataChannel
  globalThis.RTCPeerConnection.prototype.createDataChannel = function (...args) {
    const channel = originalCreate.apply(this, args)
    observation.channelCount++
    observation.peers.push(this)
    const originalSend = channel.send.bind(channel)
    let currentFileId = -1
    channel.send = data => {
      originalSend(data)
      observation.maxRtcBufferedBytes = Math.max(observation.maxRtcBufferedBytes, channel.bufferedAmount)
      if (data instanceof globalThis.ArrayBuffer && data.byteLength >= 16) {
        const view = new globalThis.DataView(data)
        if (view.getUint16(0) === 0x4653 && view.getUint8(2) === 1) {
          currentFileId = view.getUint32(4)
          const file = observation.files[currentFileId] ??= { binaryFrames: 0, payloadBytes: 0, maxRtcBufferedBytes: 0 }
          file.binaryFrames++; file.payloadBytes += view.getUint32(12)
          observation.binaryFrames++
          observation.maxBinaryFrameBytes = Math.max(observation.maxBinaryFrameBytes, data.byteLength)
        }
      }
      if (currentFileId >= 0) observation.files[currentFileId].maxRtcBufferedBytes = Math.max(observation.files[currentFileId].maxRtcBufferedBytes, channel.bufferedAmount)
    }
    return channel
  }
}

async function transportObservation(sender) {
  return sender.evaluate(async () => {
    const observation = globalThis.__fsappBenchmark
    let route = 'unavailable'
    const pc = observation.peers[0]
    if (pc) {
      const stats = await pc.getStats()
      let pair
      stats.forEach(report => { if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId) })
      if (!pair) stats.forEach(report => { if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) pair = report })
      if (pair) {
        const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId)
        route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct'
      }
    }
    return { channelCount: observation.channelCount, maxRtcBufferedBytes: observation.maxRtcBufferedBytes, binaryFrames: observation.binaryFrames, maxBinaryFrameBytes: observation.maxBinaryFrameBytes, files: observation.files, route }
  })
}

async function verifyDownload(download, expected) {
  assert.equal(download.suggestedFilename(), expected.name)
  const original = await open(expected.filename, 'r'), digest = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of await download.createReadStream()) {
      const baseline = Buffer.alloc(chunk.length)
      let read = 0
      while (read < baseline.length) {
        const next = await original.read(baseline, read, baseline.length - read, bytes + read)
        assert.notEqual(next.bytesRead, 0, 'Download exceeds the source file')
        read += next.bytesRead
      }
      assert.equal(Buffer.compare(Buffer.from(chunk), baseline), 0, `Downloaded bytes differ at offset ${bytes}`)
      digest.update(chunk); bytes += chunk.length
    }
  } finally { await original.close() }
  const sha256 = digest.digest('hex')
  assert.equal(bytes, expected.bytes); assert.equal(sha256, expected.sha256)
  return { bytes, sha256, byteIdentical: true }
}

await mkdir(fixtureDir, { recursive: true })
const health = await globalThis.fetch(new URL('/actuator/health', baseURL), { signal: globalThis.AbortSignal.timeout(75_000) })
assert.equal(health.ok, true, 'Start the packaged FSApp server before benchmarking')
const files = [await fixture(1), await fixture(100)]
const server = await chromium.launchServer({ executablePath: process.env.FSAPP_CHROMIUM_EXECUTABLE, headless: true })
const browser = await chromium.connect(server.wsEndpoint())
const rootPid = server.process().pid
result.environment.browser = browser.version()
let senderContext, receiverContext, senderHeap, receiverHeap, interval, inFlight
let phase = 'browser-started'
const runStarted = performance.now()

async function sample(checkpoint) {
  const values = await Promise.allSettled([
    ownBrowserRss(rootPid),
    withHeap && senderHeap ? senderHeap.send('Runtime.getHeapUsage') : null,
    withHeap && receiverHeap ? receiverHeap.send('Runtime.getHeapUsage') : null,
  ])
  const value = index => values[index].status === 'fulfilled' ? values[index].value : null
  const row = { elapsedMs: Math.round(performance.now() - runStarted), phase, browserTreeRssBytes: value(0)?.bytes ?? null, browserProcessCount: value(0)?.processCount ?? null, senderJsHeapUsedBytes: value(1)?.usedSize ?? null, receiverJsHeapUsedBytes: value(2)?.usedSize ?? null }
  result.memorySamples.push(row)
  if (checkpoint) result.checkpoints.push({ name: checkpoint, ...row })
}

try {
  await sample('browser-started')
  interval = setInterval(() => { if (!inFlight) { inFlight = sample().finally(() => { inFlight = undefined }) } }, sampleIntervalMs)
  senderContext = await browser.newContext({ acceptDownloads: true })
  receiverContext = await browser.newContext({ acceptDownloads: true })
  const sender = await senderContext.newPage(), receiver = await receiverContext.newPage()
  sender.setDefaultTimeout(30_000); receiver.setDefaultTimeout(180_000)
  await sender.addInitScript(observeSender)
  if (withHeap) { senderHeap = await senderContext.newCDPSession(sender); receiverHeap = await receiverContext.newCDPSession(receiver) }
  await sender.goto(baseURL.toString())
  result.applicationAssets = await sender.locator('script[src]').evaluateAll(elements => elements.map(element => element.getAttribute('src')))
  await sender.getByLabel('Choose files', { exact: true }).setInputFiles(files.map(file => file.filename))
  phase = 'pairing'
  const pairingStarted = performance.now()
  await sender.getByRole('button', { name: 'Create pairing code', exact: true }).click()
  const pairingInput = sender.getByRole('textbox', { name: 'Pairing code', exact: true })
  await expect(pairingInput).toHaveValue(/^\d{6}$/)
  const code = await pairingInput.inputValue()
  const receiverNavigationStarted = performance.now()
  await receiver.goto(new URL('/?receive=1&save=download', baseURL).toString())
  await receiver.getByLabel('Pairing code', { exact: true }).fill(code)
  await receiver.getByRole('button', { name: 'Connect to sender', exact: true }).click()
  await expect(sender.getByLabel('Confirmation phrase', { exact: true })).toBeVisible()
  await expect(receiver.getByLabel('Confirmation phrase', { exact: true })).toHaveText(await sender.getByLabel('Confirmation phrase', { exact: true }).innerText())
  await expect(receiver.getByRole('list', { name: 'Files', exact: true })).toHaveCount(0)
  const approvalStarted = performance.now()
  await sender.getByRole('button', { name: 'Approve connection', exact: true }).click()
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible({ timeout: 90_000 })
  result.pairing = { mode: 'single-use-six-digit-code-with-sender-approval', createToConsentMs: Math.round(performance.now() - pairingStarted), receiverNavigationToConsentMs: Math.round(performance.now() - receiverNavigationStarted), approvalToConsentMs: Math.round(performance.now() - approvalStarted) }
  assert.equal(new URL(receiver.url()).hash, '')
  phase = 'paired'
  await sample('paired-before-transfer')
  for (const [index, file] of files.entries()) {
    const transferPhase = `transferring-${file.bytes / 1024 / 1024}-MiB`
    phase = transferPhase
    const started = performance.now()
    await receiver.getByRole('button', { name: 'Accept file', exact: true }).click()
    await expect(receiver.getByRole('heading', { name: 'Received and verified', exact: true })).toBeVisible({ timeout: 180_000 })
    const acceptToVerifiedMs = Math.round(performance.now() - started)
    await sample(`${file.name}-verified`)
    const transport = await transportObservation(sender)
    phase = `downloading-${file.bytes / 1024 / 1024}-MiB`
    const pendingDownload = receiver.waitForEvent('download')
    await receiver.getByRole('button', { name: 'Download file', exact: true }).click()
    const download = await pendingDownload
    const verification = await verifyDownload(download, file)
    await sample(`${file.name}-download-compared`)
    const transferSamples = result.memorySamples.filter(row => row.phase === transferPhase)
    const peak = key => { const values = transferSamples.map(row => row[key]).filter(value => value !== null); return values.length ? Math.max(...values) : null }
    result.transfers.push({ name: file.name, sizeBytes: file.bytes, acceptToVerifiedMs, observedMiBPerSecond: Number(((file.bytes / 1024 / 1024) / (acceptToVerifiedMs / 1000)).toFixed(2)), route: transport.route, download: verification, dataChannel: transport.files[index], sampledTransferPeaks: { sampleCount: transferSamples.length, browserTreeRssBytes: peak('browserTreeRssBytes'), senderJsHeapUsedBytes: peak('senderJsHeapUsedBytes'), receiverJsHeapUsedBytes: peak('receiverJsHeapUsedBytes') } })
    await receiver.getByRole('button', { name: index === files.length - 1 ? 'Finish transfer' : 'Next file', exact: true }).click()
    await download.delete()
    phase = `released-${file.bytes / 1024 / 1024}-MiB`
    await pause(1000)
    await sample(`${file.name}-one-second-after-release`)
    process.stdout.write(`Verified ${file.name}: ${acceptToVerifiedMs} ms; ${transport.route}; RTC peak ${transport.files[index]?.maxRtcBufferedBytes} bytes.\n`)
  }
  await expect(sender.getByRole('heading', { name: 'All done. All yours.', exact: true })).toBeVisible()
  await expect(receiver.getByRole('heading', { name: 'All done. All yours.', exact: true })).toBeVisible()
  result.transport = await transportObservation(sender)
  result.completed = true
} catch (error) {
  result.error = String(error).replace(/(token|key|attempt|code)=[A-Za-z0-9_-]+/g, '$1=[redacted]')
  process.exitCode = 1
} finally {
  clearInterval(interval)
  await inFlight
  await receiverContext?.close(); await senderContext?.close()
  senderHeap = undefined; receiverHeap = undefined
  phase = 'contexts-closed'
  await pause(1000); await sample('one-second-after-contexts-close')
  await browser.close(); await server.close()
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`Benchmark ${result.completed ? 'completed' : 'failed'}; result: ${resultPath}\n`)
  if (result.error) process.stderr.write(`${result.error}\n`)
}
