export const PILL_WIDTH = 380
export const PILL_HEIGHT = 320

/**
 * Pure so the properties that actually matter — always on top, never focusable —
 * can be asserted without launching Electron. The preload path is a parameter
 * rather than derived from __dirname for the same reason.
 */
export function windowOptions(preloadPath: string, saved?: { x: number; y: number }) {
  return {
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    // The whole point: it floats in front of your work without ever stealing
    // the keyboard from the app you are actually using.
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }
}
