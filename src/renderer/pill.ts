type Bridge = {
  micClick(): void
  abort(): void
  onState(fn: (s: string) => void): void
  onPartial(fn: (t: string, l: number) => void): void
  onAnswer(fn: (t: string) => void): void
  onStatus(fn: (t: string) => void): void
  onAudio(fn: (mp3: ArrayBuffer) => void): void
  audioDone(): void
}

const v = (window as unknown as { voicer: Bridge }).voicer

const app = document.getElementById('app')!
const card = document.getElementById('card') as HTMLDivElement
const answer = document.getElementById('answer')!
const statusEl = document.getElementById('status')!
const mic = document.getElementById('mic')!
const stopBtn = document.getElementById('stop') as HTMLButtonElement

mic.addEventListener('click', () => v.micClick())
stopBtn.addEventListener('click', () => v.abort())

v.onState((state) => {
  app.dataset.state = state
  stopBtn.hidden = state === 'idle' || state === 'error'
  if (state === 'idle') {
    statusEl.textContent = ''
    app.style.setProperty('--level', '1')
  }
})

v.onPartial((text, level) => {
  answer.textContent = text
  card.hidden = text.trim() === ''
  // 1.0 to 1.25 — reads as a level meter without the ring jumping about.
  app.style.setProperty('--level', String(1 + level * 0.25))
})

v.onAnswer((text) => {
  answer.textContent = text
  card.hidden = false
  card.scrollTop = card.scrollHeight
})

v.onStatus((text) => { statusEl.textContent = text })

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
