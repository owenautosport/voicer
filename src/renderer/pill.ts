type Bridge = {
  micClick(): void
  abort(): void
  onState(fn: (s: string) => void): void
  onPartial(fn: (t: string, l: number) => void): void
  onAnswer(fn: (t: string) => void): void
  contentSize(w: number, h: number): void
  submit(text: string): void
  composeOpen(): void
  composeClose(): void
  quit(): void
  getSettings(): Promise<any>
  setSettings(patch: unknown): Promise<any>
  onAlign(fn: (a: string) => void): void
  usage(): Promise<{
    turns: number
    costUsd: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    models: string[]
  }>
  onStatus(fn: (t: string) => void): void
  onFail(fn: (m: string) => void): void
  onAudio(fn: (mp3: ArrayBuffer) => void): void
  audioDone(): void
}

const v = (window as unknown as { voicer: Bridge }).voicer

const app = document.getElementById('app')!
const card = document.getElementById('card') as HTMLDivElement
const answer = document.getElementById('answer')!
const statusEl = document.getElementById('status')!
const capsule = document.getElementById('capsule')!
const typeBtn = document.getElementById('type')!
const compose = document.getElementById('compose') as HTMLDivElement
const promptEl = document.getElementById('prompt') as HTMLTextAreaElement
const statsBtn = document.getElementById('stats')!
const usageEl = document.getElementById('usage') as HTMLDivElement
const dismiss = document.getElementById('dismiss')!
const quitBtn = document.getElementById('quit')!
const gearBtn = document.getElementById('gear')!
const settingsEl = document.getElementById('settings') as HTMLDivElement
const alignGrid = document.getElementById('align-grid')!
const saveBtn = document.getElementById('settings-save')!
const note = document.getElementById('settings-note')!
const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const heard = document.getElementById('heard')!
const stopBtn = document.getElementById('stop') as HTMLButtonElement

// The window is sized to whatever is actually drawn, every frame of every
// transition, so the invisible rectangle never sits over the app behind it.
const measure = () => {
  const r = app.getBoundingClientRect()
  v.contentSize(r.width, r.height)
}
new ResizeObserver(measure).observe(app)
measure()

// Anywhere on the capsule starts and stops a turn; the controls inside it must
// not also count as a click on the capsule itself.
capsule.addEventListener('click', () => v.micClick())
stopBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  v.abort()
})

dismiss.addEventListener('click', () => {
  card.hidden = true
  card.classList.remove('fail')
  answer.textContent = ''
})

const n = (v: number) => v.toLocaleString('en-GB')

/** Four decimal places: a turn costs cents, and $0.00 tells you nothing. */
const money = (v: number) => `$${v.toFixed(4)}`

const renderUsage = async () => {
  const u = await v.usage()
  usageEl.innerHTML = `
    <h3>Tokens &amp; cost</h3>
    <dl>
      <dt>Turns</dt><dd>${n(u.turns)}</dd>
      <dt>Input</dt><dd>${n(u.inputTokens)}</dd>
      <dt>Output</dt><dd>${n(u.outputTokens)}</dd>
      <dt>Cache read</dt><dd>${n(u.cacheReadTokens)}</dd>
      <dt>Cache write</dt><dd>${n(u.cacheWriteTokens)}</dd>
      <dt class="total">Cost</dt><dd class="total">${money(u.costUsd)}</dd>
    </dl>
    <footer>Since launch${u.models.length ? ` · ${u.models.join(', ')}` : ''}<br />An estimate, not a bill.</footer>
  `
}

// The window follows the alignment, so the drawing has to follow it too.
v.onAlign((a) => { app.dataset.align = a })

let chosenAlign = 'top'

const paintAlign = () => {
  for (const b of alignGrid.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.align === chosenAlign))
  }
}

/*
 * Position applies the moment you pick it, rather than waiting for Save. It is
 * the one setting whose effect you are looking straight at, and a grid that
 * highlights a cell while the window stays put reads as broken.
 */
alignGrid.addEventListener('click', async (e) => {
  const target = (e.target as HTMLElement).closest('button')
  if (!target?.dataset.align) return
  chosenAlign = target.dataset.align
  paintAlign()
  await save({
    window: {
      alignment: chosenAlign,
      autoMove: field<HTMLInputElement>('set-automove').checked,
    },
  }, 'Moved.')
})

const loadSettings = async () => {
  const c = await v.getSettings()
  chosenAlign = c.window.alignment
  paintAlign()
  field<HTMLInputElement>('set-automove').checked = c.window.autoMove
  field<HTMLInputElement>('set-silence').value = String(c.listen.silenceMs)
  field<HTMLSelectElement>('set-model').value = c.model ?? ''
  field<HTMLSelectElement>('set-backend').value = c.tts.backend
  field<HTMLInputElement>('set-fishkey').value = c.tts.fishApiKey ?? ''
  field<HTMLInputElement>('set-voiceid').value = c.tts.voiceId ?? ''
  field<HTMLInputElement>('set-maxedge').value = String(c.capture.maxEdgePx)
  field<HTMLInputElement>('set-quality').value = String(c.capture.quality)
  field<HTMLInputElement>('set-hotkey').value = c.hotkeys.kill
  field<HTMLInputElement>('set-claudepath').value = c.claudePath ?? ''
  field<HTMLInputElement>('set-agentcwd').value = c.agentCwd ?? ''
  note.textContent = 'Voice and paths apply next launch.'
}

const num = (id: string, fallback: number) => {
  const n = Number(field<HTMLInputElement>(id).value)
  return Number.isFinite(n) ? n : fallback
}
const str = (id: string) => field<HTMLInputElement>(id).value.trim()

/** One place that reports what happened, so a rejected save cannot go unseen. */
const save = async (patch: Record<string, unknown>, ok: string) => {
  try {
    await v.setSettings(patch)
    note.textContent = ok
  } catch (err) {
    note.textContent = err instanceof Error ? err.message : String(err)
  }
}

saveBtn.addEventListener('click', async () => {
  await save({
    window: { alignment: chosenAlign, autoMove: field<HTMLInputElement>('set-automove').checked },
    listen: { silenceMs: num('set-silence', 2000) },
    // Empty means "no opinion" — the key is dropped so Claude Code's own
    // model choice applies, rather than Voicer pinning one behind your back.
    model: field<HTMLSelectElement>('set-model').value || undefined,
    tts: {
      backend: field<HTMLSelectElement>('set-backend').value,
      fishApiKey: str('set-fishkey') || undefined,
      voiceId: str('set-voiceid') || undefined,
    },
    capture: { maxEdgePx: num('set-maxedge', 1280), quality: num('set-quality', 70) },
    hotkeys: { kill: str('set-hotkey') || 'Alt+Command+.' },
    claudePath: str('set-claudepath') || undefined,
    agentCwd: str('set-agentcwd') || undefined,
  }, 'Saved.')
})

gearBtn.addEventListener('click', async (e) => {
  e.stopPropagation()
  const open = settingsEl.hidden
  if (open) await loadSettings()
  settingsEl.hidden = !open
  app.dataset.settings = open ? 'open' : 'closed'
})

quitBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  v.quit()
})

statsBtn.addEventListener('click', async (e) => {
  e.stopPropagation()
  const open = usageEl.hidden
  if (open) await renderUsage()
  usageEl.hidden = !open
  app.dataset.usage = open ? 'open' : 'closed'
})

/** Grow the box to the text rather than making people scroll a one-line field. */
const fitPrompt = () => {
  promptEl.style.height = 'auto'
  promptEl.style.height = `${promptEl.scrollHeight}px`
}

const setCompose = (open: boolean) => {
  compose.hidden = !open
  app.dataset.compose = open ? 'open' : 'closed'
  if (open) {
    v.composeOpen()
    promptEl.focus()
    fitPrompt()
  } else {
    promptEl.value = ''
    fitPrompt()
    v.composeClose()
  }
}

typeBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  setCompose(compose.hidden)
})

promptEl.addEventListener('input', fitPrompt)
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setCompose(false)
    return
  }
  // Enter sends; shift-enter is a new line, as everywhere else.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = promptEl.value
    setCompose(false)
    if (text.trim()) v.submit(text)
  }
})

v.onState((state) => {
  app.dataset.state = state
  stopBtn.hidden = state === 'idle' || state === 'error'
  if (state === 'idle') {
    statusEl.textContent = ''
    app.style.setProperty('--level', '1')
  }
  // A new turn starts from silence, not from the last one's words.
  if (state === 'listening' || state === 'idle') {
    heard.textContent = ''
    app.style.setProperty('--level-raw', '0')
  }
})

// Partials live in the bar, never in the card: the card is for the answer, and
// for the reason a turn died.
v.onPartial((text, level) => {
  // 1.0 to 1.25 — reads as a level meter without the ring jumping about.
  app.style.setProperty('--level', String(1 + level * 0.25))
  app.style.setProperty('--level-raw', String(level))
  // Wraps over several lines now, so keep enough to read a whole sentence back.
  heard.textContent = text.length > 220 ? '…' + text.slice(-220) : text
})

v.onAnswer((text) => {
  answer.textContent = text
  card.hidden = false
  card.scrollTop = card.scrollHeight
})

v.onStatus((text) => { statusEl.textContent = text })

// Why the turn died, in words. Without this the pill goes dark and says nothing.
v.onFail((message) => {
  if (message === '') {
    card.classList.remove('fail')
    card.hidden = true
    answer.textContent = ''
    return
  }
  card.classList.add('fail')
  answer.textContent = message
  card.hidden = false
})

// Audio is played here because the main process has no output device.
v.onAudio(async (mp3) => {
  const url = URL.createObjectURL(new Blob([mp3], { type: 'audio/mpeg' }))
  const el = new Audio(url)
  const done = () => { URL.revokeObjectURL(url); v.audioDone() }
  el.addEventListener('ended', done, { once: true })
  el.addEventListener('error', done, { once: true })
  try {
    await el.play()
  } catch {
    done()
  }
})
