import { app, BrowserWindow, ipcMain, globalShortcut, screen } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { windowOptions, PILL_WIDTH, PILL_HEIGHT } from './window'
import { SidecarClient } from './sidecar'
import { AgentClient } from './agent'
import { ActionLog } from './action-log'
import { Orchestrator } from './orchestrator'
import { createControlServer } from './control-server'
import { TtsRouter } from './tts/router'
import { FishBackend } from './tts/fish'
import { AppleBackend } from './tts/apple'
import { loadConfig, configDir } from './config'
import type { TtsBackend } from './tts/types'

const here = dirname(fileURLToPath(import.meta.url))
const POSITION_FILE = join(configDir(), 'window.json')

const savedPosition = (): { x: number; y: number } | undefined => {
  try {
    return JSON.parse(readFileSync(POSITION_FILE, 'utf8'))
  } catch {
    return undefined
  }
}

app.whenReady().then(() => {
  const config = loadConfig()

  // Default position: bottom-right of the primary display, clear of the Dock.
  const { workArea } = screen.getPrimaryDisplay()
  const fallback = {
    x: workArea.x + workArea.width - PILL_WIDTH - 24,
    y: workArea.y + workArea.height - PILL_HEIGHT - 24,
  }

  const win = new BrowserWindow(
    windowOptions(join(here, '../preload/index.mjs'), savedPosition() ?? fallback),
  )

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.on('moved', () => {
    const [x, y] = win.getPosition()
    try {
      writeFileSync(POSITION_FILE, JSON.stringify({ x, y }))
    } catch {
      // Losing the window position is not worth failing a session over.
    }
  })

  const sidecarPath = app.isPackaged
    ? join(process.resourcesPath, 'voicerkit')
    : join(app.getAppPath(), 'native/voicerkit/.build/debug/voicerkit')

  console.log('[voicer] sidecar:', sidecarPath, 'packaged:', app.isPackaged)
  const sidecar = new SidecarClient(sidecarPath)
  sidecar.onError((err) => console.error('[voicer] sidecar failure:', err.message))
  sidecar.start()

  /** Audio playback lives in the renderer; the main process has no output device. */
  const playAudio = (mp3: Buffer) =>
    new Promise<void>((resolve) => {
      ipcMain.once('audio-done', () => resolve())
      win.webContents.send('audio', mp3.buffer)
    })

  const backends: TtsBackend[] = []
  if (config.tts.backend === 'fish' && config.tts.fishApiKey) {
    backends.push(
      new FishBackend(
        { apiKey: config.tts.fishApiKey, voiceId: config.tts.voiceId },
        playAudio,
      ),
    )
  }
  // Always last, always present: the voice Voicer can never lose.
  backends.push(new AppleBackend(sidecar))

  const log = new ActionLog(join(configDir(), 'actions.jsonl'))

  let reportAction: (tool: string) => void = () => {}
  const controlServer = createControlServer({
    sidecar,
    log,
    onAction: (tool) => reportAction(tool),
  })

  const orchestrator = new Orchestrator({
    sidecar,
    agent: new AgentClient({ log, controlServer }),
    tts: new TtsRouter(backends),
  })

  orchestrator.onState((s) => win.webContents.send('state', s))
  orchestrator.onPartial((t, l) => win.webContents.send('partial', t, l))
  orchestrator.onAnswer((t) => win.webContents.send('answer', t))
  orchestrator.onStatus((t) => win.webContents.send('status', t))
  reportAction = (tool) => win.webContents.send('status', `${tool}…`)

  ipcMain.on('mic-click', () => orchestrator.micClick())
  ipcMain.on('abort', () => orchestrator.abort())

  // The kill switch must work while another app owns the keyboard, so it is global.
  if (!globalShortcut.register(config.hotkeys.kill, () => orchestrator.abort())) {
    console.warn(`[voicer] could not register kill hotkey ${config.hotkeys.kill}`)
  }

  win.loadFile(join(here, '../renderer/index.html'))

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    sidecar.stop()
  })
})

// A widget has no windows to reopen; closing it means quitting.
app.on('window-all-closed', () => app.quit())
