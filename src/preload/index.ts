import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('voicer', {
  micClick: () => ipcRenderer.send('mic-click'),
  abort: () => ipcRenderer.send('abort'),
  contentSize: (w: number, h: number) => ipcRenderer.send('content-size', w, h),
  submit: (text: string) => ipcRenderer.send('submit', text),
  composeOpen: () => ipcRenderer.send('compose-open'),
  composeClose: () => ipcRenderer.send('compose-close'),
  usage: () => ipcRenderer.invoke('usage'),
  quit: () => ipcRenderer.send('quit'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  onAlign: (fn: (a: string) => void) => ipcRenderer.on('align', (_e, a) => fn(a)),
  onState: (fn: (s: string) => void) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onPartial: (fn: (t: string, l: number) => void) =>
    ipcRenderer.on('partial', (_e, t, l) => fn(t, l)),
  onAnswer: (fn: (t: string) => void) => ipcRenderer.on('answer', (_e, t) => fn(t)),
  onStatus: (fn: (t: string) => void) => ipcRenderer.on('status', (_e, t) => fn(t)),
  onFail: (fn: (m: string) => void) => ipcRenderer.on('fail', (_e, m) => fn(m)),
  onAudio: (fn: (audio: ArrayBuffer, mime: string) => void) =>
    ipcRenderer.on('audio', (_e, b, mime) => fn(b, mime)),
  audioDone: () => ipcRenderer.send('audio-done'),
})
