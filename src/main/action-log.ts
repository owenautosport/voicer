import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Append-only record of everything the agent did to the machine. With
 * permissions bypassed and Voicer owning the executor, this is the only way to
 * find out after the fact what actually happened.
 */
export class ActionLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
  }

  append(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
    try {
      appendFileSync(this.path, line)
    } catch (err) {
      console.warn('[action-log] could not write:', err)
    }
  }
}
