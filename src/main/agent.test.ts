import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentClient } from './agent'
import { ActionLog } from './action-log'

const logPath = () => join(mkdtempSync(join(tmpdir(), 'voicer-')), 'actions.jsonl')

const stream = (messages: unknown[]) =>
  vi.fn(() => {
    const gen = (async function* () { for (const m of messages) yield m })()
    return Object.assign(gen, { interrupt: vi.fn(async () => undefined) })
  })

const assistantText = (text: string) => ({
  type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text }] },
})
const assistantTool = (name: string, input: unknown) => ({
  type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', name, input }] },
})
const result = () => ({ type: 'result', subtype: 'success', is_error: false, session_id: 's1' })
const costed = (costUsd: number, tokens: Partial<Record<string, number>> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, session_id: 's1',
  total_cost_usd: costUsd,
  modelUsage: {
    'claude-opus-5': {
      inputTokens: tokens.input ?? 0,
      outputTokens: tokens.output ?? 0,
      cacheReadInputTokens: tokens.cacheRead ?? 0,
      cacheCreationInputTokens: tokens.cacheWrite ?? 0,
      costUSD: costUsd,
    },
  },
})

const CONTROL = { type: 'sdk', name: 'voicer-control' }

const CLAUDE = '/usr/local/bin/claude'

const make = (query: unknown, extra: Record<string, unknown> = {}) =>
  new AgentClient({
    log: new ActionLog(logPath()), controlServer: CONTROL, claudePath: CLAUDE,
    query: query as never, ...extra,
  })

const callbacks = () => ({ onText: vi.fn(), onTool: vi.fn(), onDone: vi.fn(), onError: vi.fn() })

const argOf = (query: { mock: { calls: unknown[][] } }, call = 0) =>
  query.mock.calls[call]![0] as any

const optionsOf = (query: { mock: { calls: unknown[][] } }, call = 0) => argOf(query, call).options

describe('AgentClient', () => {
  it('passes bypassPermissions together with the required danger flag', async () => {
    const query = stream([result()])
    await make(query).run('hello', undefined, callbacks())
    expect(optionsOf(query).permissionMode).toBe('bypassPermissions')
    expect(optionsOf(query).allowDangerouslySkipPermissions).toBe(true)
  })

  it("registers Voicer's own control server, and never one called computer-use", async () => {
    const query = stream([result()])
    await make(query).run('hello', undefined, callbacks())
    const { mcpServers } = optionsOf(query)
    expect(mcpServers['voicer-control']).toBe(CONTROL)
    // `computer-use` is reserved: the CLI swallows a server registered under it.
    expect(mcpServers['computer-use']).toBeUndefined()
  })

  it('appends the spoken-style instructions to the Claude Code preset', async () => {
    const query = stream([result()])
    await make(query).run('hello', undefined, callbacks())
    const { systemPrompt } = optionsOf(query)
    expect(systemPrompt.preset).toBe('claude_code')
    expect(systemPrompt.append).toContain('spoken aloud')
  })

  it('reports text and tool calls, then completes with the session id', async () => {
    const query = stream([assistantText('It is a form.'), assistantTool('click', { x: 1 }), result()])
    const cb = callbacks()
    await make(query).run('what is this', undefined, cb)
    expect(cb.onText).toHaveBeenCalledWith('It is a form.')
    expect(cb.onTool).toHaveBeenCalledWith('click', { x: 1 })
    expect(cb.onDone).toHaveBeenCalledWith('s1')
  })

  it('logs every tool call', async () => {
    const path = logPath()
    const query = stream([assistantTool('type', { text: 'hi' }), result()])
    const c = new AgentClient({
      log: new ActionLog(path), controlServer: CONTROL, claudePath: CLAUDE, query: query as never,
    })
    await c.run('go', undefined, callbacks())
    expect(readFileSync(path, 'utf8')).toContain('"tool":"type"')
  })

  it('resumes the previous session on the second turn', async () => {
    const query = stream([result()])
    const c = make(query)
    await c.run('first', undefined, callbacks())
    await c.run('second', undefined, callbacks())
    expect(optionsOf(query, 0).resume).toBeUndefined()
    expect(optionsOf(query, 1).resume).toBe('s1')
  })

  it('sends the screenshot as an image block alongside the transcript', async () => {
    const query = stream([result()])
    const c = make(query, { readImage: () => Buffer.from('jpegbytes') })
    await c.run('what is this', '/tmp/a.jpg', callbacks())
    const prompt = argOf(query).prompt
    let blocks: any[] = []
    for await (const msg of prompt) { blocks = msg.message.content; break }
    expect(blocks.some((b) => b.type === 'image')).toBe(true)
    expect(blocks.some((b) => b.type === 'text' && b.text.includes('what is this'))).toBe(true)
  })

  it('sends a plain string prompt when there is no screenshot', async () => {
    const query = stream([result()])
    await make(query).run('just talking', undefined, callbacks())
    expect(argOf(query).prompt).toBe('just talking')
  })

  it('reports an error rather than throwing when the stream fails', async () => {
    const query = vi.fn(() => {
      const gen = (async function* () { throw new Error('boom') })()
      return Object.assign(gen, { interrupt: vi.fn() })
    })
    const cb = callbacks()
    await make(query).run('go', undefined, cb)
    expect(cb.onError).toHaveBeenCalled()
  })

  it('stays quiet when the failure was our own abort', async () => {
    let client: AgentClient
    const query = vi.fn(() => {
      const gen = (async function* () {
        client.abort()
        throw new Error('aborted')
      })()
      return Object.assign(gen, { interrupt: vi.fn() })
    })
    client = make(query)
    const cb = callbacks()
    await client.run('go', undefined, cb)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it('drives the installed Claude Code binary, not the SDK bundled one', async () => {
    // The bundled CLI resolves to a path inside app.asar, which is a file:
    // spawning it fails with ENOTDIR before the agent ever starts.
    const query = stream([assistantText('hi'), result()])
    await make(query).run('hello', undefined, callbacks())
    expect(optionsOf(query).pathToClaudeCodeExecutable).toBe(CLAUDE)
  })

  it('says so plainly when Claude Code cannot be found', async () => {
    const query = stream([assistantText('hi'), result()])
    const cb = callbacks()
    await make(query, { claudePath: undefined }).run('hello', undefined, cb)
    expect(query).not.toHaveBeenCalled()
    expect(cb.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('claudePath') }),
    )
  })

  it('starts with nothing spent', () => {
    expect(make(stream([])).usage).toMatchObject({ turns: 0, costUsd: 0, inputTokens: 0 })
  })

  it('accumulates tokens and cost across turns', async () => {
    // Each turn is its own query() call — a resumed session starts its counters
    // fresh — so the running total is the sum of the per-turn results.
    const c = make(stream([costed(0.02, { input: 100, output: 20, cacheRead: 900 })]))
    await c.run('one', undefined, callbacks())
    await c.run('two', undefined, callbacks())
    expect(c.usage).toMatchObject({
      turns: 2, inputTokens: 200, outputTokens: 40, cacheReadTokens: 1800,
    })
    expect(c.usage.costUsd).toBeCloseTo(0.04, 6)
    expect(c.usage.models).toEqual(['claude-opus-5'])
  })

  it('counts a turn even when the result carries no usage at all', async () => {
    const c = make(stream([result()]))
    await c.run('one', undefined, callbacks())
    expect(c.usage).toMatchObject({ turns: 1, costUsd: 0, inputTokens: 0 })
  })

  it('runs the session in the directory it is given', async () => {
    // The working directory is what makes ~/SecondBrain as reachable to Voicer
    // as to any other Claude Code session; Electron's own is usually "/".
    const query = stream([assistantText('hi'), result()])
    await make(query, { cwd: '/Users/someone' }).run('hello', undefined, callbacks())
    expect(optionsOf(query).cwd).toBe('/Users/someone')
  })
})
