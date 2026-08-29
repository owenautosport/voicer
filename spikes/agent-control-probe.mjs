/**
 * Go/no-go spike for Voicer.
 *
 * The question is NOT whether `claude --computer-use-mcp` runs — that is already
 * verified. It is whether an Agent SDK session, driven headlessly with no
 * interactive Claude Code host, can obtain the `request_access` grant that the
 * computer-use server demands before any other tool will work.
 *
 * If it cannot, Voicer v1 ships as the answers-only assistant and computer
 * control needs a different route entirely.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const CLAUDE = '/Users/owen/.local/bin/claude'

const q = query({
  prompt:
    'Use the computer-use tools. First call request_access for the app "TextEdit" ' +
    'with a reason. Then take a screenshot. Then tell me in one sentence what you see. ' +
    'Do not click anything.',
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    mcpServers: {
      'cu': { type: 'stdio', command: CLAUDE, args: ['--computer-use-mcp'], alwaysLoad: true },
    },
  },
})

for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message.content) {
      if (b.type === 'text' && b.text.trim()) console.log('TEXT:', b.text)
      if (b.type === 'tool_use') console.log('TOOL:', b.name, JSON.stringify(b.input).slice(0, 200))
    }
  }
  if (m.type === 'user') {
    for (const b of m.message.content ?? []) {
      if (b.type === 'tool_result') {
        const text = Array.isArray(b.content)
          ? b.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ')
          : String(b.content)
        console.log('RESULT:', b.is_error ? 'ERROR ' : '', text.slice(0, 300))
      }
    }
  }
  if (m.type === 'result') {
    console.log('---')
    console.log('subtype:', m.subtype, 'is_error:', m.is_error)
    console.log('session_id:', m.session_id)
  }
}

/*
 * OUTCOME — 2026-08-30: (b) NO-GO for borrowing the built-in computer-use server.
 *
 * Two distinct findings:
 *
 * 1. The MCP server name `computer-use` is RESERVED. Registering a server under
 *    that name causes the CLI to intercept it and substitute its own built-in,
 *    which needs interactive app state. The server then vanishes silently — it
 *    does not appear in the init message's mcp_servers list at all, and no error
 *    is reported. Renaming it to `cu` makes it register as "connected" with all
 *    177 tools present.
 *
 * 2. Even when it connects, EVERY tool call fails with:
 *      "This computer-use server instance is not wired to a session.
 *       Per-session app permissions are not available on this code path."
 *
 *    So `claude --computer-use-mcp` spawned standalone is only a shell. The real
 *    implementation lives inside an interactive Claude Code session's app state
 *    (`computerUseMcpState` in the binary), which a headless Agent SDK session
 *    does not have. The same is expected of `--claude-in-chrome-mcp`.
 *
 * CONSEQUENCE: Voicer cannot borrow Claude Code's computer control. To keep both
 * subscription auth AND autonomy, Voicer must expose its OWN control tools as an
 * in-process MCP server backed by CGEvent, extending the voicerkit sidecar that
 * already does screen capture.
 *
 * Feasibility checked the same day: CGEventSource and CGEvent construct fine on
 * this machine; posting them needs Accessibility permission, which the app bundle
 * must request (AXIsProcessTrusted() is currently false for an unsigned binary).
 */
