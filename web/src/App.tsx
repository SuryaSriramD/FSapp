import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import QRCode from 'qrcode'
import {
  startSending,
  startReceiving,
  readPairingCode,
  validateSelection,
  type SessionSnapshot,
  type TransferSession,
} from './lib'

type IconName = 'arrow' | 'upload' | 'download' | 'link' | 'copy' | 'check' | 'close' | 'file' | 'lock' | 'phone' | 'monitor' | 'share' | 'refresh'

function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5M5 15v5h14v-5" /></>,
    download: <><path d="M12 4v12m-5-5 5 5 5-5M5 16v4h14v-4" /></>,
    link: <><path d="m10 13 4-4m-6 6-1 1a4.24 4.24 0 0 1-6-6l4-4a4.24 4.24 0 0 1 6 0m2 2 1-1a4.24 4.24 0 0 1 6 6l-4 4a4.24 4.24 0 0 1-6 0" transform="translate(1 1)" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    file: <><path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9zM13 3v6h6M8 13h8M8 17h5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    phone: <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>,
    monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M12 17v4M7 21h10" /></>,
    share: <><path d="M12 15V3m-4 4 4-4 4 4M6 11H4v10h16V11h-2" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3" /></>,
  }
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

// Capture once, before any render or effect, so the fragment cannot be lost on remount.
const hadPairingFragment = window.location.hash.length > 1
const launchCode: string | null = (() => {
  try { return readPairingCode(window.location.href) } catch { return null }
})()
if (window.location.hash) {
  const clean = new URL(window.location.href)
  clean.hash = ''
  if (launchCode) clean.searchParams.set('receive', '1')
  window.history.replaceState(window.history.state, '', `${clean.pathname}${clean.search}`)
}
const receivingPage = new URLSearchParams(window.location.search).get('receive') === '1'
const launchOptions = {
  forceRelay: new URLSearchParams(window.location.search).get('relay') === 'only',
  preferMemorySink: new URLSearchParams(window.location.search).get('save') === 'download',
}

const terminalPhases = new Set(['complete', 'cancelled', 'failed'])
const phaseNames: Record<string, string> = {
  creating: 'Preparing your connection', waiting: 'Ready when they are', confirming: 'Check the words. Then connect.', connecting: 'Connecting your devices',
  'awaiting-acceptance': 'A little permission first', transferring: 'On its way', verifying: 'Checking every byte',
  received: 'Received and verified', complete: 'All done. All yours.', cancelled: 'Transfer cancelled', failed: 'Let’s try that again',
}

function FileList({ files, onRemove }: {
  files: Array<{ id: number; name: string; size: number; progress?: number; status?: string }>
  onRemove?: (id: number) => void
}) {
  return <ul className="file-list" aria-label="Files">
    {files.map((file) => {
      const progress = Math.max(0, Math.min(100, (file.progress ?? 0) * 100))
      const status = (file.status ?? 'Ready to send').replaceAll('-', ' ')
      return <li className="file-row" key={file.id}>
        <span className="file-icon"><Icon name="file" size={21} /></span>
        <div className="file-description">
          <span className="file-name" title={file.name}>{file.name}</span>
          <span className="file-meta">{formatSize(file.size)}<span className="separator">·</span><span className="file-status">{status}</span></span>
          {!onRemove && file.progress !== undefined && <progress className="file-progress" value={progress} max={100} aria-label={`Transfer progress for ${file.name}`}>{Math.round(progress)}%</progress>}
        </div>
        {onRemove ? <button type="button" className="icon-button" onClick={() => onRemove(file.id)} aria-label={`Remove ${file.name}`}><Icon name="close" size={17} /></button>
          : <span className="file-percentage">{progress === 100 ? <Icon name="check" size={18} /> : `${Math.round(progress)}%`}</span>}
      </li>
    })}
  </ul>
}

function PairingCard({ code, url }: { code: string; url?: string }) {
  const [qr, setQr] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    if (!url) return
    QRCode.toDataURL(url, { width: 208, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#173c39', light: '#ffffff' } })
      .then((result) => { if (active) setQr(result) })
      .catch(() => { if (active) setNotice('The QR shortcut is unavailable. Enter the six-digit code instead.') })
    return () => { active = false }
  }, [url])
  async function copy() {
    try { await navigator.clipboard.writeText(code); setNotice('Code copied. Share it with your receiver.') }
    catch { input.current?.select(); setNotice('Select and copy the six-digit code to share it.') }
  }
  async function share() {
    try { await navigator.share({ title: 'Receive files with FSApp', text: `Enter code ${code} in FSApp to connect with me.`, url: window.location.origin }) }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setNotice('Sharing is unavailable. Copy the pairing code instead.') }
  }
  return <aside className="side-card invitation-card pairing-card">
    <span className="eyebrow">YOUR SIX-DIGIT CODE</span>
    <h2>A few digits apart.</h2>
    <p>On the other device, open FSApp, choose Receive files, and enter this code.</p>
    <label className="field-label" htmlFor="pairing-code">Pairing code</label>
    <input className="pairing-code-display" ref={input} id="pairing-code" aria-label="Pairing code" value={code} readOnly onFocus={(event) => event.target.select()} />
    <div className="invitation-actions"><button type="button" className="button button-secondary" onClick={() => void copy()}><Icon name="copy" size={16} />Copy code</button>{typeof navigator.share === 'function' && <button type="button" className="button button-secondary" onClick={() => void share()}><Icon name="share" size={16} />Share code</button>}</div>
    <p className="small-note">One use. Expires in 10 minutes. You approve the connection before any filenames are shared.</p>
    {url && <details className="qr-shortcut"><summary>Or scan a QR code</summary><div className="qr-frame">{qr ? <img src={qr} width="208" height="208" alt="Scan the pairing code on the receiving device" /> : <span className="qr-pending">Preparing QR code…</span>}</div><a href={url} target="_blank" rel="noreferrer" className="qr-shortcut-link">Open QR shortcut</a></details>}
    <p className="action-notice" role="status">{notice}</p>
  </aside>
}

function HowItWorks() {
  return <aside className="side-card how-card">
    <span className="eyebrow">FROM HERE TO THERE</span>
    <h2>Three small steps.</h2>
    <ol className="steps">
      <li><span className="step-number">01</span><div><h3>Pick your files</h3><p>Photos, documents, or that thing you need on your other device.</p></div></li>
      <li><span className="step-number">02</span><div><h3>Share six digits</h3><p>Enter the code on the other device, or scan the optional QR shortcut.</p></div></li>
      <li><span className="step-number">03</span><div><h3>Check. Approve. Receive.</h3><p>Compare the words on both screens. The sender approves, then the receiver accepts each file.</p></div></li>
    </ol>
    <div className="open-reminder"><span className="reminder-icon"><Icon name="monitor" size={20} /></span><p><strong>Keep both devices open.</strong><br />Your browsers do the sending.</p></div>
  </aside>
}

export default function App() {
  const [mode, setMode] = useState<'sender' | 'receiver'>(launchCode || hadPairingFragment || receivingPage ? 'receiver' : 'sender')
  const [files, setFiles] = useState<File[]>([])
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const [error, setError] = useState(hadPairingFragment && !launchCode ? 'This QR shortcut is invalid. Ask the sender for a new six-digit code.' : '')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [enteredCode, setEnteredCode] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const session = useRef<TransferSession | null>(null)
  const operation = useRef(0)
  const initialJoinStarted = useRef(false)
  const pageWasLeft = useRef(false)

  async function start(role: 'sender' | 'receiver', code?: string) {
    const attempt = ++operation.current
    session.current?.dispose()
    session.current = null
    setError(''); setBusy(true); setSnapshot(null)
    const onChange = (value: SessionSnapshot) => { if (operation.current === attempt) setSnapshot(value) }
    try {
      const result = role === 'sender'
        ? await startSending(files, onChange, launchOptions)
        : await startReceiving(code!, onChange, launchOptions)
      if (operation.current !== attempt) result.dispose()
      else session.current = result
    } catch (cause) {
      if (operation.current === attempt) {
        const message = cause instanceof Error ? cause.message : 'The connection could not be started. Please try again.'
        setError(message)
        setSnapshot((previous) => previous ? { ...previous, phase: 'failed', error: message, message } : null)
      }
    } finally { if (operation.current === attempt) setBusy(false) }
  }

  useEffect(() => {
    const disposeSession = () => {
      operation.current++
      session.current?.dispose()
      session.current = null
    }
    const onPageHide = () => {
      // A browser navigation/close does not unmount React. Close the DataChannel
      // explicitly so its peer does not wait for an ICE inactivity timeout.
      pageWasLeft.current = true
      disposeSession()
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted && !pageWasLeft.current) return
      pageWasLeft.current = false
      disposeSession()
      // BFCache restores the old React tree. Its invitation, Blob URLs and file
      // handles were disposed on pagehide and must never look usable again.
      setSnapshot(null)
      setFiles([])
      setBusy(false)
      setDragging(false)
      setEnteredCode('')
      setError('This page was restored after you left. The previous transfer has ended. Ask the sender for a new code.')
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    if (launchCode && !initialJoinStarted.current) {
      initialJoinStarted.current = true
      void start('receiver', launchCode)
    }
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      disposeSession()
    }
    // The invitation is captured once at module initialization. Sessions own their callbacks.
  }, [])

  function selectFiles(incoming: File[]) {
    const next = [...files, ...incoming]
    const issue = validateSelection(next)
    if (issue) { setError(issue); return }
    setFiles(next); setError('')
  }
  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false)
    if (busy) return
    const entries = Array.from(event.dataTransfer.items).filter((item) => item.kind === 'file')
    if (entries.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) { setError('Choose individual files. Folder sharing is not supported yet.'); return }
    selectFiles(Array.from(event.dataTransfer.files))
  }
  function connectCode() {
    const code = enteredCode.replace(/\s/g, '')
    if (!/^\d{6}$/.test(code)) { setError('Enter the six-digit code shown on the sending device.'); return }
    const url = new URL(window.location.href)
    url.searchParams.set('receive', '1')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
    void start('receiver', code)
  }
  function reset() {
    operation.current++
    session.current?.dispose(); session.current = null
    setSnapshot(null); setError(''); setBusy(false); setEnteredCode('')
  }
  function cancel() {
    if (session.current) session.current.cancel()
    else {
      setSnapshot((previous) => previous ? { ...previous, phase: 'cancelled', message: 'Invitation cancelled.', signalingConnected: false } : null)
      // An outstanding create/join may finish after cancellation; start() disposes that stale result.
      operation.current++
    }
    setBusy(false)
  }
  async function act(action: 'accept' | 'nextFile' | 'approvePairing') {
    if (!session.current) return
    const attempt = operation.current
    setError(''); setBusy(true)
    try { await session.current[action]() }
    catch (cause) { if (operation.current === attempt) setError(cause instanceof Error ? cause.message : 'This action could not be completed. Please try again.') }
    finally { if (operation.current === attempt) setBusy(false) }
  }
  function download() {
    try { session.current?.download() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The download could not be started. Please try again.') }
  }

  const active = snapshot !== null
  const phase = snapshot?.phase ?? ''
  const isTerminal = terminalPhases.has(phase)
  const received = snapshot?.received
  const currentIndex = snapshot?.files.findIndex((file) => file.id === snapshot.currentFileId) ?? -1
  const isLastFile = currentIndex >= (snapshot?.files.length ?? 0) - 1
  const canAdvance = received && (received.status === 'download-requested' || received.status === 'saved')
  const visibleError = error || snapshot?.error
  const totalBytes = files.reduce((total, file) => total + file.size, 0)

  return <div className="app-shell">
    <header className="site-header">
      <a className="brand" href="/" aria-label="FSApp home"><span className="brand-mark"><Icon name="arrow" size={24} /></span><span>FSApp<span className="brand-dot">.</span></span></a>
      <div className="header-right"><span className="header-privacy"><Icon name="lock" size={14} />PRIVATE BY DESIGN</span><span className="beta-badge">WEB BETA</span></div>
    </header>
    <main>
      <section className="hero" aria-labelledby="page-title">
        <div className="hero-copy"><div className="eyebrow hero-eyebrow"><span className="status-dot" />BROWSER TO BROWSER. HUMAN TO HUMAN.</div><h1 id="page-title">Send it.<br /><span>Keep it yours.</span></h1><p>Your files, on another device. Share six digits, compare the words, and connect. No account, no cloud file storage.</p></div>
        <div className="connection-art" aria-hidden="true"><div className="art-orbit orbit-outer" /><div className="art-orbit orbit-inner" /><div className="art-path" /><span className="art-device art-computer"><Icon name="monitor" size={43} /><span>FROM YOU</span></span><span className="art-lock"><Icon name="lock" size={20} /></span><span className="art-device art-phone"><Icon name="phone" size={39} /><span>TO THEM</span></span><span className="art-caption">A SHORTER WAY TO SHARE</span></div>
      </section>

      <div className="workspace">
        <section className="transfer-card" aria-label="File sharing">
          <div className="card-heading">
            {active ? <><span className="card-title"><Icon name={snapshot.role === 'sender' ? 'upload' : 'download'} size={19} />{snapshot.role === 'sender' ? 'Sending files' : 'Receiving files'}</span><span className={`connection-badge ${snapshot.route !== 'pending' ? 'connected' : ''}`}><span className="status-dot" />{snapshot.route === 'direct' ? 'Encrypted · direct' : snapshot.route === 'relay' ? 'Encrypted · relay' : 'Connecting'}</span></>
              : <div className="mode-tabs" role="group" aria-label="Choose sharing direction"><button type="button" className={mode === 'sender' ? 'mode-tab selected' : 'mode-tab'} aria-pressed={mode === 'sender'} onClick={() => { setMode('sender'); setError('') }} disabled={busy}><Icon name="upload" size={17} />Send files</button><button type="button" className={mode === 'receiver' ? 'mode-tab selected' : 'mode-tab'} aria-pressed={mode === 'receiver'} onClick={() => { setMode('receiver'); setError('') }} disabled={busy}><Icon name="download" size={17} />Receive files</button></div>}
          </div>
          <div className="card-body">
            {!active && mode === 'sender' && <>
              <input className="visually-hidden" type="file" multiple ref={fileInput} tabIndex={-1} aria-label="Choose files" disabled={busy} onChange={(event) => { if (event.target.files?.length) selectFiles(Array.from(event.target.files)); event.target.value = '' }} />
              <div className={`dropzone ${dragging ? 'dragging' : ''} ${files.length ? 'has-files' : ''}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }} onDrop={onDrop}>
                <span className="upload-emblem"><Icon name="upload" size={29} /></span>
                <h2>{files.length ? 'A little more to send?' : 'Drop something here.'}</h2>
                <p>Good things are better on the right device.</p>
                <button type="button" className="button button-primary browse-button" onClick={() => fileInput.current?.click()} disabled={busy}>Choose files<Icon name="arrow" size={17} /></button>
                <span className="dropzone-limit">Up to 10 files<span>·</span>100 MiB per file</span>
              </div>
              {files.length > 0 && <><div className="list-heading"><span>{files.length} {files.length === 1 ? 'FILE' : 'FILES'} READY</span><span>{formatSize(totalBytes)} TOTAL</span></div><FileList files={files.map((file, id) => ({ id, name: file.name, size: file.size }))} onRemove={busy ? undefined : (id) => setFiles(files.filter((_, index) => index !== id))} /><button type="button" className="button button-primary full-width create-button" onClick={() => void start('sender')} disabled={busy}>{busy ? 'Preparing code…' : 'Create pairing code'}<Icon name="arrow" size={18} /></button></>}
              {!files.length && <div className="under-dropzone"><Icon name="lock" size={15} /><span>You approve the connection before any files are shared.</span></div>}
            </>}
            {!active && mode === 'receiver' && <form className="receive-start" onSubmit={(event) => { event.preventDefault(); connectCode() }}><span className="upload-emblem"><Icon name="link" size={28} /></span><h2>Something coming your way?</h2><p>Enter the six-digit code from the sending device. You’ll compare a short phrase before connecting.</p><label htmlFor="receive-code" className="field-label">Pairing code</label><input className="code-entry" id="receive-code" aria-label="Pairing code" placeholder="000000" value={enteredCode} onChange={(event) => setEnteredCode(event.target.value.replace(/\s/g, ''))} inputMode="numeric" autoComplete="off" maxLength={12} disabled={busy} spellCheck={false} aria-describedby="code-help" /><p id="code-help" className="code-help">Six digits, including any leading zero. Codes are single use.</p><button type="submit" className="button button-primary full-width" disabled={busy || !enteredCode.trim()}>{busy ? 'Connecting…' : 'Connect to sender'}<Icon name="arrow" size={18} /></button></form>}

            {active && <div className="session-panel">
              <div className={`session-emblem ${isTerminal && phase !== 'failed' ? 'session-done' : ''}`}><Icon name={phase === 'complete' || phase === 'received' ? 'check' : phase === 'failed' ? 'refresh' : snapshot.role === 'sender' ? 'upload' : 'download'} size={28} /></div>
              <h2>{phaseNames[phase] ?? 'Your transfer'}</h2>
              <p className="session-message" role="status" aria-live="polite">{snapshot.message}</p>
              {phase === 'creating' && <p className="small-note">The demo service may need a moment to wake up.</p>}
              {phase === 'waiting' && <div className="waiting-notice"><span className="pulse-dot" />{snapshot.role === 'sender' ? 'Waiting for your receiver to enter the code.' : 'Waiting for the sender to connect.'}</div>}
              {phase === 'confirming' && <section className="confirmation-panel" aria-label="Confirm this connection"><span className="eyebrow">COMPARE ON BOTH DEVICES</span><output className="confirmation-phrase" aria-label="Confirmation phrase">{snapshot.confirmationPhrase}</output><p>{snapshot.role === 'sender' ? 'Ask your receiver to read these words. Approve only when both screens match.' : 'Read these words to the sender. They approve the connection when both screens match.'}</p>{snapshot.role === 'sender' ? <div className="confirmation-actions"><button type="button" className="button button-primary full-width" disabled={busy || !snapshot.confirmationPhrase} onClick={() => void act('approvePairing')}><Icon name="check" size={18} />{busy ? 'Approving…' : 'Approve connection'}</button><button type="button" className="button button-secondary full-width" onClick={cancel}>Reject connection</button></div> : <p className="waiting-approval"><span className="pulse-dot" />Waiting for the sender’s approval. No filenames shared yet.</p>}</section>}
              {snapshot.files.length > 0 && (snapshot.role === 'sender' || !['creating', 'waiting', 'confirming', 'connecting'].includes(phase)) && <><div className="list-heading"><span>{snapshot.files.length} {snapshot.files.length === 1 ? 'FILE' : 'FILES'}</span>{currentIndex >= 0 && <span>FILE {currentIndex + 1} OF {snapshot.files.length}</span>}</div><FileList files={snapshot.files} /></>}
              {received && <div className="receipt"><Icon name="check" size={20} /><div><strong>{received.status === 'saved' ? 'Saved and verified' : received.status === 'download-requested' ? 'Download requested' : 'Received and verified'}</strong><p>{received.status === 'saved' ? 'The file was verified and written to your chosen location.' : received.status === 'download-requested' ? 'Check your browser’s downloads before moving on.' : 'Every byte checks out. Save your file to keep it.'}</p></div></div>}
              {snapshot.role === 'receiver' && phase === 'awaiting-acceptance' && <button type="button" className="button button-primary full-width" onClick={() => void act('accept')} disabled={busy}><Icon name="download" size={18} />{busy ? 'Preparing to receive…' : 'Accept file'}</button>}
              {snapshot.role === 'receiver' && received && <div className="receiver-actions">{received.method === 'download' && <button type="button" className={`button ${canAdvance ? 'button-secondary' : 'button-primary'} full-width`} onClick={download} disabled={busy}><Icon name="download" size={18} />Download file</button>}{phase === 'received' && canAdvance && <button type="button" className="button button-primary full-width" onClick={() => void act('nextFile')} disabled={busy}>{isLastFile ? 'Finish transfer' : 'Next file'}<Icon name="arrow" size={18} /></button>}</div>}
              {!snapshot.signalingConnected && snapshot.route !== 'pending' && !isTerminal && <p className="small-note">The connection service disconnected. Your existing peer connection can continue.</p>}
              {isTerminal ? <button type="button" className="button button-secondary full-width" onClick={reset}><Icon name="refresh" size={17} />Start a new transfer</button> : <button type="button" className="text-button cancel-button" onClick={cancel}>Cancel transfer</button>}
            </div>}
            {visibleError && <div className="error-box" role="alert"><strong>We couldn’t complete that.</strong><p>{visibleError}</p></div>}
          </div>
          <div className="card-footnote"><Icon name="lock" size={14} /><span>{active ? 'Keep both devices open until the files are received.' : 'No account. No cloud file storage. Just a connection.'}</span></div>
        </section>
        {snapshot?.pairingCode && snapshot.role === 'sender' && ['creating', 'waiting'].includes(phase) ? <PairingCard code={snapshot.pairingCode} url={snapshot.inviteUrl} /> : <HowItWorks />}
      </div>

      <section className="trust-strip" aria-label="How your files travel"><div><Icon name="lock" size={18} /><span><strong>Encrypted in transit</strong><small>Your browser protects the connection.</small></span></div><div><Icon name="monitor" size={18} /><span><strong>Made for your devices</strong><small>Phone, laptop, and the space between.</small></span></div><div><Icon name="link" size={18} /><span><strong>Nearby or far away</strong><small>A direct connection when possible.</small></span></div></section>
    </main>
    <footer className="site-footer"><span>FSApp<span className="brand-dot">.</span><span className="footer-tagline">A little less between your devices.</span></span><span>Files stay on your devices. Encrypted relay when needed.</span></footer>
  </div>
}
