import { query } from '@anthropic-ai/claude-agent-sdk'
const CLAUDE = '/Users/owen/.local/bin/claude'
const q = query({
  prompt: 'Reply with the single word: ok',
  options: {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    mcpServers: {
      'cu': { type: 'stdio', command: CLAUDE, args: ['--computer-use-mcp'], alwaysLoad: true },
    },
  },
})
for await (const m of q) {
  if (m.type === 'system') {
    console.log('SYSTEM subtype:', m.subtype)
    console.log('mcp_servers:', JSON.stringify(m.mcp_servers, null, 2))
    const cu = (m.tools ?? []).filter(t => /computer|screenshot|request_access|click/i.test(t))
    console.log('matching tools:', cu.length ? cu : '(none)')
    console.log('total tools:', (m.tools ?? []).length)
  }
  if (m.type === 'result') console.log('result:', m.subtype)
}
