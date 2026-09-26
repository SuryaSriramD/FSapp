import { test, expect, type Page, type BrowserContext, type Download } from '@playwright/test'
import { open, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

interface Payload { name: string; mimeType: string; buffer: Buffer }
interface Pairing { sender: Page; code: string; shortcut: string }

async function invite(sender: Page, files: Payload[] | string[], relay = false): Promise<Pairing> {
  await sender.goto(relay ? '/?relay=only' : '/')
  await sender.getByLabel('Choose files', { exact: true }).setInputFiles(files)
  await sender.getByRole('button', { name: 'Create pairing code', exact: true }).click()
  const input = sender.getByRole('textbox', { name: 'Pairing code', exact: true })
  await expect(input).toHaveValue(/^\d{6}$/)
  const shortcut = await sender.getByRole('link', { name: 'Open QR shortcut', exact: true, includeHidden: true }).getAttribute('href')
  if (!shortcut) throw new Error('The pairing shortcut is missing.')
  return { sender, code: await input.inputValue(), shortcut }
}

async function approve(pairing: Pairing, receiver: Page) {
  const phrase = pairing.sender.getByLabel('Confirmation phrase', { exact: true })
  await expect(phrase).toBeVisible()
  await expect(receiver.getByLabel('Confirmation phrase', { exact: true })).toHaveText(await phrase.innerText())
  await expect(receiver.getByRole('list', { name: 'Files', exact: true })).toHaveCount(0)
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toHaveCount(0)
  await pairing.sender.getByRole('button', { name: 'Approve connection', exact: true }).click()
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible()
}

async function receive(context: BrowserContext, pairing: Pairing, relay = false, autoApprove = true): Promise<Page> {
  const receiver = await context.newPage()
  const url = new URL('/?receive=1&save=download', pairing.sender.url())
  if (relay) url.searchParams.set('relay', 'only')
  await receiver.goto(url.toString())
  await receiver.getByLabel('Pairing code', { exact: true }).fill(`${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}`)
  await receiver.getByRole('button', { name: 'Connect to sender', exact: true }).click()
  await expect(receiver.getByLabel('Confirmation phrase', { exact: true })).toBeVisible()
  if (autoApprove) await approve(pairing, receiver)
  await expect.poll(() => new URL(receiver.url()).hash).toBe('')
  return receiver
}

async function bytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('transfers an empty file and a Unicode binary batch with explicit per-file consent', async ({ page, context }, testInfo) => {
  const files: Payload[] = [
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    { name: 'résumé-नमस्ते.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(Array.from({ length: 4099 }, (_, i) => i % 256)) },
    { name: 'binary.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(Array.from({ length: 512 * 1024 }, (_, i) => (i * 17 + 31) % 256)) },
    { name: 'binary.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([9, 0, 8, 255]) },
  ]
  const started = Date.now()
  const invitation = await invite(page, files)
  const receiver = await receive(context, invitation)
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible()
  const pairingMs = Date.now() - started
  const transferMeasurements: Array<{ name: string; bytes: number; acceptToVerifiedMs: number }> = []

  for (const [index, file] of files.entries()) {
    await expect(receiver.getByRole('button', { name: 'Download file', exact: true })).toHaveCount(0)
    const transferStarted = Date.now()
    await receiver.getByRole('button', { name: 'Accept file', exact: true }).click()
    await expect(receiver.getByRole('heading', { name: 'Received and verified', exact: true })).toBeVisible()
    transferMeasurements.push({ name: file.name, bytes: file.buffer.length, acceptToVerifiedMs: Date.now() - transferStarted })
    const downloaded = receiver.waitForEvent('download')
    await receiver.getByRole('button', { name: 'Download file', exact: true }).click()
    const download = await downloaded
    // macOS/WebKit may use canonically equivalent decomposed Unicode names.
    expect(download.suggestedFilename().normalize('NFC')).toBe(file.name.normalize('NFC'))
    expect(await bytes(download)).toEqual(file.buffer)
    await expect(receiver.getByText('Download requested', { exact: true })).toBeVisible()
    await receiver.getByRole('button', { name: index === files.length - 1 ? 'Finish transfer' : 'Next file', exact: true }).click()
    if (index < files.length - 1) await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible()
  }
  await expect(page.getByRole('heading', { name: 'All done. All yours.', exact: true })).toBeVisible()
  await expect(receiver.getByRole('heading', { name: 'All done. All yours.', exact: true })).toBeVisible()
  await testInfo.attach('same-host-transfer-measurements', {
    body: JSON.stringify({ environment: 'Two automated browser pages on the same host; this does not measure cross-network or physical-device performance.', browser: testInfo.project.name, pairingMs, transfers: transferMeasurements }, null, 2),
    contentType: 'application/json',
  })
})

test('either device can cancel before the receiver consents', async ({ page, context }) => {
  const invitation = await invite(page, [{ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('This file must not transfer without consent.') }])
  const receiver = await receive(context, invitation)
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible()
  await receiver.getByRole('button', { name: 'Cancel transfer', exact: true }).click()
  await expect(receiver.getByRole('heading', { name: 'Transfer cancelled', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Transfer cancelled', exact: true })).toBeVisible()
  await expect(receiver.getByRole('button', { name: 'Download file', exact: true })).toHaveCount(0)
})

test('cancels while the connection service is waking without reviving the invitation', async ({ page }) => {
  let releaseRequest!: () => void
  const gate = new Promise<void>((resolve) => { releaseRequest = resolve })
  await page.route('**/v1/sessions', async (route) => { await gate; await route.continue() })
  await page.goto('/')
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
  await page.getByRole('button', { name: 'Create pairing code', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Preparing your connection', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Transfer cancelled', exact: true })).toBeVisible()
  const creationFinished = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/sessions' && response.request().method() === 'POST')
  releaseRequest()
  await creationFinished
  await expect(page.getByRole('heading', { name: 'Transfer cancelled', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Pairing code', exact: true })).toHaveCount(0)
})

test('offers a fresh attempt when the connection service cannot create a room', async ({ page }) => {
  await page.route('**/v1/sessions', (route) => route.fulfill({ status: 503, body: 'Unavailable' }))
  await page.goto('/')
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep the selection for retry.') })
  await page.getByRole('button', { name: 'Create pairing code', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Let’s try that again', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('connection service is busy')
  await expect(page.getByRole('textbox', { name: 'Pairing code', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Start a new transfer', exact: true }).click()
  await expect(page.getByText('retry.txt', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create pairing code', exact: true })).toBeEnabled()
})

test('accepts a ten-file batch including an exact 100 MiB file', { tag: '@large' }, async ({ page, context }, testInfo) => {
  test.slow()
  const paths: string[] = []
  for (let i = 0; i < 9; i++) {
    const path = testInfo.outputPath(`small-${i}.bin`)
    await writeFile(path, Buffer.from([i, 255 - i]))
    paths.push(path)
  }
  const boundaryPath = testInfo.outputPath('exactly-100-MiB.bin')
  const boundaryFile = await open(boundaryPath, 'w')
  try { await boundaryFile.truncate(100 * 1024 * 1024) } finally { await boundaryFile.close() }
  paths.push(boundaryPath)
  const receiver = await receive(context, await invite(page, paths))
  for (let i = 0; i < 10; i++) {
    await receiver.getByRole('button', { name: 'Accept file', exact: true }).click()
    await expect(receiver.getByRole('heading', { name: 'Received and verified', exact: true })).toBeVisible({ timeout: 150_000 })
    const downloaded = receiver.waitForEvent('download')
    await receiver.getByRole('button', { name: 'Download file', exact: true }).click()
    const download = await downloaded
    if (i < 9) expect(await bytes(download)).toEqual(Buffer.from([i, 255 - i]))
    else {
      const actual = createHash('sha256')
      let size = 0
      const stream = await download.createReadStream()
      for await (const chunk of stream) { actual.update(chunk); size += chunk.length }
      const expected = createHash('sha256'), zeroMiB = Buffer.alloc(1024 * 1024)
      for (let block = 0; block < 100; block++) expected.update(zeroMiB)
      expect(size).toBe(100 * 1024 * 1024)
      expect(actual.digest('hex')).toBe(expected.digest('hex'))
    }
    await receiver.getByRole('button', { name: i === 9 ? 'Finish transfer' : 'Next file', exact: true }).click()
  }
  await expect(receiver.getByRole('heading', { name: 'All done. All yours.', exact: true })).toBeVisible()
})

test('rejects too many files and a file above 100 MiB before creating a session', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByLabel('Choose files', { exact: true }).setInputFiles(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') })))
  await expect(page.getByRole('alert')).toContainText('Choose no more than 10 files.')
  await expect(page.getByRole('button', { name: 'Create pairing code', exact: true })).toHaveCount(0)

  const oversizedPath = testInfo.outputPath('oversized.bin')
  const file = await open(oversizedPath, 'w')
  try { await file.truncate(100 * 1024 * 1024 + 1) } finally { await file.close() }
  await page.getByLabel('Choose files', { exact: true }).setInputFiles(oversizedPath)
  await expect(page.getByRole('alert')).toContainText('Each file must be 100 MiB or smaller.')
  await expect(page.getByRole('button', { name: 'Create pairing code', exact: true })).toHaveCount(0)
})

test('checks matching phrases and hides filenames and ICE until sender approval', async ({ page, context }) => {
  const iceRequests: string[] = []
  context.on('request', request => { if (new URL(request.url()).pathname.endsWith('/ice')) iceRequests.push(request.url()) })
  const pairing = await invite(page, [{ name: 'not-shared-before-approval.txt', mimeType: 'text/plain', buffer: Buffer.from('Explicit sender consent.') }])
  const receiver = await receive(context, pairing, false, false)
  await expect(receiver.getByText('not-shared-before-approval.txt', { exact: true })).toHaveCount(0)
  await expect(receiver.getByRole('button', { name: 'Approve connection', exact: true })).toHaveCount(0)
  expect(iceRequests).toEqual([])
  await approve(pairing, receiver)
  await expect(receiver.getByText('not-shared-before-approval.txt', { exact: true })).toBeVisible()
  expect(iceRequests.length).toBeGreaterThan(0)
})

test('rejecting a phrase match prevents the connection and any filename disclosure', async ({ page, context }) => {
  const pairing = await invite(page, [{ name: 'never-disclosed.txt', mimeType: 'text/plain', buffer: Buffer.from('Reject this pairing.') }])
  const receiver = await receive(context, pairing, false, false)
  await page.getByRole('button', { name: 'Reject connection', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Transfer cancelled', exact: true })).toBeVisible()
  await expect(receiver.getByRole('heading', { name: /Transfer cancelled|Let’s try that again/ })).toBeVisible()
  await expect(receiver.getByText('never-disclosed.txt', { exact: true })).toHaveCount(0)
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toHaveCount(0)
})

test('mismatched pairing keys fail signaling authentication even if the sender approves', async ({ page, context }) => {
  const pairing = await invite(page, [{ name: 'hmac-protected.txt', mimeType: 'text/plain', buffer: Buffer.from('No disclosure on a mismatched authenticated connection.') }])
  const receiver = await context.newPage()
  await receiver.route('**/v1/pairings', async route => {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const credentials = await response.json() as Record<string, unknown>
    await route.fulfill({ response, json: { ...credentials, key: Buffer.alloc(32, 23).toString('base64url') } })
  })
  await receiver.goto('/?receive=1')
  await receiver.getByLabel('Pairing code', { exact: true }).fill(pairing.code)
  await receiver.getByRole('button', { name: 'Connect to sender', exact: true }).click()
  await expect(page.getByLabel('Confirmation phrase', { exact: true })).toBeVisible()
  await expect(receiver.getByLabel('Confirmation phrase', { exact: true })).toBeVisible()
  await expect(receiver.getByLabel('Confirmation phrase', { exact: true })).not.toHaveText(await page.getByLabel('Confirmation phrase', { exact: true }).innerText())
  // Deliberately simulate a user ignoring the mismatched words. HMAC verification
  // remains an independent barrier before applying the offer or revealing files.
  await page.getByRole('button', { name: 'Approve connection', exact: true }).click()
  await expect(receiver.getByRole('alert')).toContainText('authentication failed')
  await expect(receiver.getByText('hmac-protected.txt', { exact: true })).toHaveCount(0)
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toHaveCount(0)
})

test('a consumed pairing code cannot be claimed by a second receiver', async ({ page, context }) => {
  const pairing = await invite(page, [{ name: 'one-receiver.txt', mimeType: 'text/plain', buffer: Buffer.from('Single use code.') }])
  const first = await receive(context, pairing, false, false)
  const second = await context.newPage()
  await second.goto('/?receive=1')
  await second.getByLabel('Pairing code', { exact: true }).fill(pairing.code)
  await second.getByRole('button', { name: 'Connect to sender', exact: true }).click()
  await expect(second.getByRole('alert')).toContainText('invalid, expired, or already used')
  await expect(second.getByRole('button', { name: 'Accept file', exact: true })).toHaveCount(0)
  await approve(pairing, first)
})

test('cancelling a pending real code claim closes the claimed room without reviving either screen', async ({ page, context }) => {
  const pairing = await invite(page, [{ name: 'cancel-pending-claim.txt', mimeType: 'text/plain', buffer: Buffer.from('Never approved or disclosed.') }])
  const receiver = await context.newPage()
  let releaseResponse!: () => void
  let claimCompleted!: () => void
  const release = new Promise<void>(resolve => { releaseResponse = resolve })
  const claimed = new Promise<void>(resolve => { claimCompleted = resolve })
  await receiver.route('**/v1/pairings', async route => {
    // The real backend consumes the code now, but its response is delayed until
    // after the user cancels. No mock room or synthetic lifecycle is involved.
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    claimCompleted()
    await release
    await route.fulfill({ response })
  })
  await receiver.goto('/?receive=1')
  await receiver.getByLabel('Pairing code', { exact: true }).fill(pairing.code)
  await receiver.getByRole('button', { name: 'Connect to sender', exact: true }).click()
  await claimed
  await receiver.getByRole('button', { name: 'Cancel transfer', exact: true }).click()
  await expect(receiver.getByRole('heading', { name: 'Transfer cancelled', exact: true })).toBeVisible()
  releaseResponse()
  await expect(page.getByRole('heading', { name: /Transfer cancelled|Let’s try that again/ })).toBeVisible({ timeout: 15_000 })
  await expect(receiver.getByRole('heading', { name: 'Transfer cancelled', exact: true })).toBeVisible()
  await expect(receiver.getByLabel('Confirmation phrase', { exact: true })).toHaveCount(0)
  await expect(receiver.getByRole('list', { name: 'Files', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve connection', exact: true })).toHaveCount(0)
  const retry = await context.newPage()
  await retry.goto('/?receive=1')
  await retry.getByLabel('Pairing code', { exact: true }).fill(pairing.code)
  await retry.getByRole('button', { name: 'Connect to sender', exact: true }).click()
  await expect(retry.getByRole('alert')).toContainText('invalid, expired, or already used')
})

test('a cancelled code is invalid for a new receiver', async ({ page, context }) => {
  const pairing = await invite(page, [{ name: 'cancel-code.txt', mimeType: 'text/plain', buffer: Buffer.from('This room is gone.') }])
  const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname.startsWith('/v1/sessions/'))
  await page.getByRole('button', { name: 'Cancel transfer', exact: true }).click()
  await deleted
  const receiver = await context.newPage()
  await receiver.goto('/?receive=1')
  await receiver.getByLabel('Pairing code', { exact: true }).fill(pairing.code)
  await receiver.getByRole('button', { name: 'Connect to sender', exact: true }).click()
  await expect(receiver.getByRole('alert')).toContainText('invalid, expired, or already used')
})

test('the QR shortcut enters the same code flow and clears the fragment immediately', async ({ page, context }) => {
  const pairing = await invite(page, [{ name: 'qr.txt', mimeType: 'text/plain', buffer: Buffer.from('QR is only a code entry shortcut.') }])
  await page.getByText('Or scan a QR code', { exact: true }).click()
  await expect(page.getByAltText('Scan the pairing code on the receiving device', { exact: true })).toBeVisible()
  const receiver = await context.newPage()
  const shortcut = new URL(pairing.shortcut)
  shortcut.searchParams.set('save', 'download')
  await receiver.goto(shortcut.toString())
  await expect.poll(() => new URL(receiver.url()).hash).toBe('')
  await expect(receiver.getByLabel('Confirmation phrase', { exact: true })).toBeVisible()
  await approve(pairing, receiver)
})

test('keeps a verified file downloadable if the sender leaves before the rest of the batch', async ({ page, context }) => {
  const first = Buffer.from('This verified file survives the peer leaving.')
  const invitation = await invite(page, [
    { name: 'keep.txt', mimeType: 'text/plain', buffer: first },
    { name: 'later.txt', mimeType: 'text/plain', buffer: Buffer.from('This file has not been accepted.') },
  ])
  const receiver = await receive(context, invitation)
  await receiver.getByRole('button', { name: 'Accept file', exact: true }).click()
  await expect(receiver.getByRole('heading', { name: 'Received and verified', exact: true })).toBeVisible()
  await page.close()
  await expect(receiver.getByRole('heading', { name: 'Let’s try that again', exact: true })).toBeVisible({ timeout: 30_000 })
  const downloaded = receiver.waitForEvent('download')
  await receiver.getByRole('button', { name: 'Download file', exact: true }).click()
  expect(await bytes(await downloaded)).toEqual(first)
  await expect(receiver.getByRole('button', { name: 'Next file', exact: true })).toHaveCount(0)
})

test('a receiver reload clears the live session and its single-use code', async ({ page, context }) => {
  const invitation = await invite(page, [{ name: 'reload.txt', mimeType: 'text/plain', buffer: Buffer.from('Do not persist this session.') }])
  const receiver = await receive(context, invitation)
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible()
  await receiver.reload()
  await expect(receiver.getByLabel('Pairing code', { exact: true })).toBeEmpty()
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toHaveCount(0)
  expect(new URL(receiver.url()).hash).toBe('')
})

test('navigation and history return do not revive a disposed receiving session', async ({ page, context }, testInfo) => {
  const invitation = await invite(page, [{ name: 'history.txt', mimeType: 'text/plain', buffer: Buffer.from('History navigation must create a new pairing.') }])
  const receiver = await receive(context, invitation)
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible()
  // Observe an actual browser pageshow; do not synthesize lifecycle events or
  // require BFCache admission, which differs with live WebRTC across browsers.
  await receiver.evaluate(() => {
    window.addEventListener('pageshow', (event) => { document.documentElement.dataset.fsappHistoryPersisted = String(event.persisted) })
  })
  await receiver.goto('/?history-destination=1')
  await expect(page.getByRole('heading', { name: 'Let’s try that again', exact: true })).toBeVisible({ timeout: 30_000 })
  await receiver.goBack()
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toHaveCount(0)
  await expect(receiver.getByRole('textbox', { name: 'Pairing code', exact: true })).toBeEmpty()
  expect(new URL(receiver.url()).hash).toBe('')
  await testInfo.attach('history-restoration', {
    body: JSON.stringify({ persisted: await receiver.locator('html').getAttribute('data-fsapp-history-persisted'), note: 'true exercises BFCache restoration; null means a new document load exercised the cleared-invitation path.' }),
    contentType: 'application/json',
  })
})

test('mobile layout stays within the viewport and exposes keyboard-accessible controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Send it. Keep it yours.' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const choose = page.locator('button').filter({ hasText: /^Choose files$/ })
  await choose.focus()
  await expect(choose).toBeFocused()
  const screenshot = await page.screenshot({ path: testInfo.outputPath('mobile-home.png'), fullPage: true })
  await testInfo.attach('mobile-home', { body: screenshot, contentType: 'image/png' })
  await page.getByRole('button', { name: 'Receive files', exact: true }).click()
  await expect(page.getByLabel('Pairing code', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect to sender', exact: true })).toBeDisabled()
  await page.getByLabel('Pairing code', { exact: true }).fill('012 345')
  await expect(page.getByLabel('Pairing code', { exact: true })).toHaveValue('012345')
  await expect(page.getByLabel('Pairing code', { exact: true })).toHaveAttribute('inputmode', 'numeric')
  await page.getByLabel('Pairing code', { exact: true }).fill('12345')
  await page.getByRole('button', { name: 'Connect to sender', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Enter the six-digit code')
})

test('uses managed TURN when relay is explicitly required', async ({ page, context }) => {
  test.skip(process.env.FSAPP_TEST_TURN !== '1', 'Requires configured, funded TURN credentials and explicit relay test opt-in.')
  const file: Payload = { name: 'relay.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 255]) }
  const invitation = await invite(page, [file], true)
  const receiver = await receive(context, invitation, true)
  await expect(receiver.getByRole('button', { name: 'Accept file', exact: true })).toBeVisible()
  await expect(receiver.getByText('Encrypted · relay', { exact: true })).toBeVisible()
  await receiver.getByRole('button', { name: 'Accept file', exact: true }).click()
  await expect(receiver.getByRole('heading', { name: 'Received and verified', exact: true })).toBeVisible()
  const downloaded = receiver.waitForEvent('download')
  await receiver.getByRole('button', { name: 'Download file', exact: true }).click()
  expect(await bytes(await downloaded)).toEqual(file.buffer)
})
