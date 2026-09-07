import { readFileSync } from 'node:fs'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { ActionLog } from './action-log'

export type AgentCallbacks = {
  onText: (delta: string) => void
  onTool: (tool: string, input: unknown) => void
  onDone: (sessionId: string) => void
  onError: (err: Error) => void
}

const SPOKEN_STYLE = `
You are Voicer, a voice assistant pinned in front of the user's screen. Your replies are
spoken aloud, so:
- Answer in two or three sentences. Never more unless asked.
- No markdown, no bullet points, no code blocks, and do not read file paths aloud unless asked.
- Say what you are about to do in one short clause before you do it.
- If you cannot tell what the user means, ask one short question rather than guessing.

To act on the user's Mac, use the voicer-control tools: take a screenshot first, then click,
type, key or scroll using coordinates from that screenshot. Take a fresh screenshot after
anything on screen changes.
`.trim()

type QueryFn = typeof sdkQuery

/** What this run of Voicer has spent, as an estimate rather than a bill. */
export type UsageTotals = {
  turns: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  models: string[]
}

const noUsage = (): UsageTotals => ({
  turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, models: [],
})

export type AgentOptions = {
  log: ActionLog
  controlServer: unknown
  /** The installed Claude Code binary; see resolveClaudePath. */
  claudePath?: string
  /** Where the session runs; see resolveAgentCwd. */
  cwd?: string
  /** Model alias or id; unset follows Claude Code's own default. */
  model?: string
  /** Base environment for the session. Defaults to Voicer's own. */
  env?: Record<string, string | undefined>
  query?: QueryFn
  readImage?: (path: string) => Buffer
}

/**
 * The environment the agent session runs in.
 *
 * The SDK marks the CLI it spawns with `CLAUDE_CODE_CHILD_SESSION=1`, and that
 * marker turns transcript saving off. It would be harmless if it stopped there
 * — but `open -a` hands the caller's whole environment to the app it launches,
 * so every app the agent opens inherits the marker, and any Claude Code started
 * inside one silently keeps no transcript. Forcing persistence alongside it
 * means what Voicer opens still records its own history.
 */
export function agentEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...base, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' }
}

/**
 * One turn of conversation with a headless Claude Code session.
 *
 * Sessions are resumed across turns so "no, the other one" resolves against
 * what was said before.
 */
export class AgentClient {
  #sessionId?: string
  #controller?: AbortController
  #usage: UsageTotals = noUsage()

  /**
   * Read on each turn rather than captured at construction, so changing the
   * model in Settings takes effect on the next thing you say.
   */
  model?: string

  constructor(private readonly opts: AgentOptions) {
    this.model = opts.model
  }

  get sessionId(): string | undefined {
    return this.#sessionId
  }

  get usage(): UsageTotals {
    return { ...this.#usage, models: [...this.#usage.models] }
  }

  /**
   * Each turn is its own `query()` call. A result carries the running total for
   * that call, and a resumed session starts its counters from zero — so the
   * total across a conversation is the sum of the per-turn results, not the
   * last one.
   */
  #record(message: Record<string, any>): void {
    this.#usage.turns += 1

    const perModel = (message.modelUsage ?? {}) as Record<string, Record<string, number>>
    let modelCost = 0
    for (const [model, u] of Object.entries(perModel)) {
      this.#usage.inputTokens += u.inputTokens ?? 0
      this.#usage.outputTokens += u.outputTokens ?? 0
      this.#usage.cacheReadTokens += u.cacheReadInputTokens ?? 0
      this.#usage.cacheWriteTokens += u.cacheCreationInputTokens ?? 0
      modelCost += u.costUSD ?? 0
      if (!this.#usage.models.includes(model)) this.#usage.models.push(model)
    }

    this.#usage.costUsd +=
      typeof message.total_cost_usd === 'number' ? message.total_cost_usd : modelCost
  }

  abort(): void {
    this.#controller?.abort()
    this.#controller = undefined
  }

  async run(transcript: string, imagePath: string | undefined, cb: AgentCallbacks): Promise<void> {
    if (!this.opts.claudePath) {
      cb.onError(new Error(
        'Claude Code was not found on this Mac. Install it, or set "claudePath" '
        + 'in ~/.voicer/config.json.',
      ))
      return
    }

    const controller = new AbortController()
    this.#controller = controller
    const run = this.opts.query ?? sdkQuery
    const read = this.opts.readImage ?? readFileSync

    try {
      const stream = run({
        prompt: this.#buildPrompt(transcript, imagePath, read),
        options: {
          permissionMode: 'bypassPermissions',
          // The SDK refuses bypassPermissions without this explicit acknowledgement.
          allowDangerouslySkipPermissions: true,
          abortController: controller,
          // Never the SDK's bundled CLI: inside app.asar it is not a real path.
          pathToClaudeCodeExecutable: this.opts.claudePath,
          ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
          ...(this.#sessionId ? { resume: this.#sessionId } : {}),
          // Absent, not null: the CLI's own default model must win.
          ...(this.model ? { model: this.model } : {}),
          env: agentEnv(this.opts.env),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SPOKEN_STYLE },
          // Named `voicer-control`: `computer-use` is reserved by the CLI, which
          // substitutes its own built-in and then drops the server from the
          // session without raising an error.
          mcpServers: { 'voicer-control': this.opts.controlServer },
        },
      } as Parameters<QueryFn>[0])

      for await (const message of stream as AsyncIterable<Record<string, any>>) {
        if (message.type === 'assistant') {
          this.#sessionId = message.session_id ?? this.#sessionId
          for (const block of message.message?.content ?? []) {
            if (block.type === 'text' && block.text) cb.onText(block.text)
            if (block.type === 'tool_use') {
              this.opts.log.append({
                tool: block.name, input: block.input, session: message.session_id,
              })
              cb.onTool(block.name, block.input)
            }
          }
        }
        if (message.type === 'result') {
          this.#sessionId = message.session_id ?? this.#sessionId
          this.#record(message)
          cb.onDone(this.#sessionId ?? '')
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return
      cb.onError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.#controller = undefined
    }
  }

  #buildPrompt(transcript: string, imagePath: string | undefined, read: (p: string) => Buffer) {
    if (!imagePath) return transcript
    // An async iterable of user messages is the only shape that carries an
    // image block into the turn.
    const content = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: read(imagePath).toString('base64') },
      },
      { type: 'text', text: transcript },
    ]
    return (async function* () {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content },
        parent_tool_use_id: null,
        session_id: '',
      }
    })()
  }
}
