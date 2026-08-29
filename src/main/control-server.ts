import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { SidecarClient } from './sidecar'
import type { ActionLog } from './action-log'

export type ControlDeps = {
  sidecar: Pick<SidecarClient, 'capture' | 'act'>
  log: ActionLog
  onAction: (tool: string) => void
  readImage?: (path: string) => Buffer
}

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

export type ControlTool = {
  name: string
  description: string
  schema: Record<string, z.ZodTypeAny>
  handler: (args: Record<string, never>) => Promise<ToolResult>
}

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] })
const failure = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
  isError: true,
})

/**
 * Voicer's own control tools.
 *
 * Claude Code ships a `computer-use` MCP server, but a headless SDK session
 * cannot use it: every call returns "not wired to a session", because the
 * implementation lives in an interactive session's app state. So Voicer
 * implements control itself, on top of the sidecar's CGEvent support.
 *
 * Split out from `createControlServer` so the behaviour can be tested without
 * standing up an MCP server.
 */
export function buildControlTools(deps: ControlDeps): ControlTool[] {
  const read = deps.readImage ?? readFileSync

  /** Every action is logged before it is reported — the log must not lose a call that then failed. */
  const act = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    deps.log.append({ tool: name, input: args })
    deps.onAction(name)
    try {
      await deps.sidecar.act(name, args)
      return text(`${name} ok`)
    } catch (err) {
      deps.log.append({ tool: name, input: args, error: String(err) })
      return failure(err)
    }
  }

  return [
    {
      name: 'screenshot',
      description:
        'Take a screenshot of the main display. Returns the image. All click and scroll ' +
        'coordinates are relative to this image, so take a fresh one after anything changes.',
      schema: {},
      handler: async () => {
        deps.onAction('screenshot')
        try {
          const shot = await deps.sidecar.capture()
          deps.log.append({ tool: 'screenshot', w: shot.w, h: shot.h })
          return {
            content: [
              { type: 'image', data: read(shot.path).toString('base64'), mimeType: 'image/jpeg' },
              { type: 'text', text: `Screen is ${shot.w}x${shot.h} in these coordinates.` },
            ],
          }
        } catch (err) {
          return failure(err)
        }
      },
    },
    {
      name: 'click',
      description: 'Click at a point, in the coordinate space of the most recent screenshot.',
      schema: {
        x: z.number().describe('X coordinate in the screenshot'),
        y: z.number().describe('Y coordinate in the screenshot'),
        button: z.enum(['left', 'right']).optional().describe('Defaults to left'),
      },
      handler: (args) => act('click', args),
    },
    {
      name: 'type',
      description: 'Type text into whatever currently has keyboard focus.',
      schema: { text: z.string().describe('The text to type') },
      handler: (args) => act('type', args),
    },
    {
      name: 'key',
      description:
        'Press a key combination, e.g. "cmd+s", "return", "escape", "cmd+shift+4". ' +
        'Modifiers are cmd, shift, alt and ctrl, joined with "+".',
      schema: { combo: z.string().describe('The key combination') },
      handler: (args) => act('key', args),
    },
    {
      name: 'scroll',
      description: 'Scroll at a point. Positive dy scrolls up, negative scrolls down.',
      schema: {
        x: z.number().describe('X coordinate in the screenshot'),
        y: z.number().describe('Y coordinate in the screenshot'),
        dy: z.number().int().describe('Pixels to scroll; negative is down'),
      },
      handler: (args) => act('scroll', args),
    },
  ]
}

/**
 * Named `voicer-control` deliberately. `computer-use` is a reserved MCP server
 * name: registering under it makes the CLI substitute its own built-in, and the
 * server then disappears from the session with no error raised anywhere.
 */
export function createControlServer(deps: ControlDeps) {
  return createSdkMcpServer({
    name: 'voicer-control',
    version: '0.1.0',
    tools: buildControlTools(deps).map((t) =>
      tool(t.name, t.description, t.schema, t.handler as never),
    ),
  })
}
