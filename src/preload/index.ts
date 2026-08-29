import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('voicer', {
  micClick: () => ipcRenderer.send('mic-click'),
  abort: () => ipcRenderer.send('abort'),
  onState: (fn: (s: string) => void) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onPartial: (fn: (t: string, l: number) => void) =>
    ipcRenderer.on('partial', (_e, t, l) => fn(t, l)),
  onAnswer: (fn: (t: string) => void) => ipcRenderer.on('answer', (_e, t) => fn(t)),
  onStatus: (fn: (t: string) => void) => ipcRenderer.on('status', (_e, t) => fn(t)),
  onAudio: (fn: (mp3: ArrayBuffer) => void) => ipcRenderer.on('audio', (_e, b) => fn(b)),
  audioDone: () => ipcRenderer.send('audio-done'),
})
