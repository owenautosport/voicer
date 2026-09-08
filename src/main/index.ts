import { app, BrowserWindow, ipcMain, globalShortcut, screen } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowOptions, PILL_WIDTH, PILL_HEIGHT } from './window'
import { SidecarClient } from './sidecar'
import { AgentClient } from './agent'
import { ActionLog } from './action-log'
import { Orchestrator } from './orchestrator'
import { createControlServer } from './control-server'
import { TtsRouter } from './tts/router'
import { FishBackend } from './tts/fish'
import { AppleBackend } from './tts/apple'
import { KokoroBackend } from './tts/kokoro'
import { createKokoroSynth } from './tts/kokoro-model'
import { loadConfig, saveConfig, configDir, resolveClaudePath, resolveAgentCwd } from './config'
import { placeIn, alignmentAwayFrom, type Alignment } from './placement'
import type { ConfigPatch } from './config'
import type { TtsBackend } from './tts/types'

const here = dirname(fileURLToPath(import.meta.url))
app.whenReady().then(() => {
  let settings = loadConfig()

  const area = () => screen.getPrimaryDisplay().workArea

  /** What the user chose, and where it actually is — the two differ while it is
   *  standing aside for something the agent needs to reach. */
  let preferred: Alignment = settings.window.alignment
  let alignment: Alignment = preferred
  let size = { width: PILL_WIDTH, height: PILL_HEIGHT }

  const win = new BrowserWindow(
    windowOptions(join(here, '../preload/index.mjs'), placeIn(area(), size, alignment)),
  )

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setAlwaysOnTop(true, 'screen-saver')
  const place = () => win.setBounds({ ...placeIn(area(), size, alignment), ...size })

  const setAlignment = (next: Alignment) => {
    if (next === alignment) return
    alignment = next
    place()
    win.webContents.send('align', alignment)
  }

  // The renderer measures itself and the window follows, so the transparent
  // area never covers more of the screen than the capsule actually draws on.
  ipcMain.on('content-size', (_e, w: number, h: number) => {
    const width = Math.max(1, Math.ceil(w))
    const height = Math.max(1, Math.ceil(h))
    if (size.width === width && size.height === height) return
    size = { width, height }
    place()
  })

  /**
   * Voicer floats above everything — including whatever it is being asked to
   * drive. A click landing under the capsule would hit the capsule, so it steps
   * to whichever alignment is furthest from the target and goes back to the one
   * you chose when the turn is over.
   */
  const avoid = (x: number, y: number, shot?: { w: number; h: number }) => {
    if (!settings.window.autoMove) return
    const display = screen.getPrimaryDisplay()
    // Click coordinates are in the screenshot's space, not the display's.
    const scale = shot && shot.w > 0 ? display.bounds.width / shot.w : 1
    const moved = alignmentAwayFrom(
      area(), size, alignment,
      display.bounds.x + x * scale,
      display.bounds.y + y * scale,
    )
    if (moved) setAlignment(moved)
  }

  const sidecarPath = app.isPackaged
    ? join(process.resourcesPath, 'voicerkit')
    : join(app.getAppPath(), 'native/voicerkit/.build/debug/voicerkit')

  console.log('[voicer] sidecar:', sidecarPath, 'packaged:', app.isPackaged)
  const sidecar = new SidecarClient(sidecarPath, [], settings.listen.silenceMs)
  sidecar.captureOptions = {
    maxEdge: settings.capture.maxEdgePx,
    quality: settings.capture.quality,
  }
  sidecar.onError((err) => console.error('[voicer] sidecar failure:', err.message))
  sidecar.start()

  /**
   * Audio playback lives in the renderer; the main process has no output device.
   *
   * The container travels with the bytes because the backends do not agree on
   * one: Fish answers with MP3, Kokoro hands back raw samples that are wrapped
   * as a WAV here.
   */
  const playAudio = (audio: Buffer, mime = 'audio/mpeg') =>
    new Promise<void>((resolve) => {
      ipcMain.once('audio-done', () => resolve())
      // Copied out rather than passed along: a Buffer can be a window onto a
      // larger pooled ArrayBuffer, and handing over the whole pool would play
      // whatever else happened to be sitting in it.
      const bytes = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)
      win.webContents.send('audio', bytes, mime)
    })

  const backends: TtsBackend[] = []
  if (settings.tts.backend === 'fish' && settings.tts.fishApiKey) {
    backends.push(
      new FishBackend(
        { apiKey: settings.tts.fishApiKey, voiceId: settings.tts.voiceId },
        playAudio,
      ),
    )
  }
  if (settings.tts.backend === 'kokoro') {
    const { synth, warm } = createKokoroSynth({
      voice: settings.tts.kokoroVoice,
      dtype: settings.tts.kokoroDtype,
      cacheDir: join(configDir(), 'models'),
      onStatus: (text) => win.webContents.send('status', text),
    })
    // Load it now rather than when it is first spoken to. Warm, the model takes
    // about a second; cold, it is a few hundred megabytes off the internet, and
    // neither of those should be charged to the first thing you say.
    warm()
    backends.push(new KokoroBackend(synth, playAudio))
  }

  // Always last, always present: the voice Voicer can never lose.
  backends.push(new AppleBackend(sidecar))

  const log = new ActionLog(join(configDir(), 'actions.jsonl'))

  const claudePath = resolveClaudePath(settings.claudePath)
  const agentCwd = resolveAgentCwd(settings.agentCwd)
  console.log('[voicer] claude:', claudePath ?? 'NOT FOUND', '· cwd:', agentCwd)

  let reportAction: (tool: string) => void = () => {}
  const controlServer = createControlServer({
    sidecar,
    log,
    onAction: (tool) => reportAction(tool),
    avoid,
  })

  const agent = new AgentClient({
    log, controlServer, claudePath, cwd: agentCwd, model: settings.model,
  })

  const orchestrator = new Orchestrator({
    sidecar,
    agent,
    tts: new TtsRouter(backends),
  })

  ipcMain.handle('usage', () => agent.usage)
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_e, patch: ConfigPatch) => {
    try {
      settings = saveConfig(patch)
    } catch (err) {
      // Reported both ways: to the log for us, and to the panel for the user.
      console.error('[voicer] could not save settings:', err)
      throw err
    }

    preferred = settings.window.alignment
    setAlignment(preferred)

    // Applied live. Everything else — voice, paths — is read at startup.
    agent.model = settings.model
    sidecar.listenSilenceMs = settings.listen.silenceMs
    sidecar.captureOptions = {
      maxEdge: settings.capture.maxEdgePx,
      quality: settings.capture.quality,
    }
    globalShortcut.unregisterAll()
    if (!globalShortcut.register(settings.hotkeys.kill, () => orchestrator.abort())) {
      console.warn(`[voicer] could not register kill hotkey ${settings.hotkeys.kill}`)
    }
    return settings
  })

  orchestrator.onState((s) => {
    console.log('[voicer] state:', s)
    // The turn is over; go back to where you were asked to sit.
    if (s === 'idle') setAlignment(preferred)
    win.webContents.send('state', s)
  })
  orchestrator.onPartial((t, l) => win.webContents.send('partial', t, l))
  orchestrator.onAnswer((t) => win.webContents.send('answer', t))
  orchestrator.onStatus((t) => win.webContents.send('status', t))
  orchestrator.onFail((m) => win.webContents.send('fail', m))
  reportAction = (tool) => win.webContents.send('status', `${tool}…`)

  ipcMain.on('mic-click', () => orchestrator.micClick())
  ipcMain.on('abort', () => orchestrator.abort())
  ipcMain.on('submit', (_e, text: string) => orchestrator.submit(text))
  // will-quit stops the sidecar and releases the global hotkey.
  ipcMain.on('quit', () => app.quit())

  /**
   * The window is deliberately unfocusable so typing carries on in the app
   * underneath — which also means a text field in it can never receive a
   * keystroke. Composing is the one moment Voicer is allowed the keyboard, and
   * it gives it straight back.
   */
  ipcMain.on('compose-open', () => {
    win.setFocusable(true)
    win.focus()
  })
  ipcMain.on('compose-close', () => {
    win.blur()
    win.setFocusable(false)
  })

  // The kill switch must work while another app owns the keyboard, so it is global.
  if (!globalShortcut.register(settings.hotkeys.kill, () => orchestrator.abort())) {
    console.warn(`[voicer] could not register kill hotkey ${settings.hotkeys.kill}`)
  }

  // After the page exists, not before: a send to a webContents that has not
  // loaded yet goes nowhere, and the renderer never learns which edge it is on.
  win.webContents.on('did-finish-load', () => win.webContents.send('align', alignment))

  win.loadFile(join(here, '../renderer/index.html'))

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    sidecar.stop()
  })
})

// A widget has no windows to reopen; closing it means quitting.
app.on('window-all-closed', () => app.quit())
