// Stands in for voicerkit. Same protocol, deterministic, no hardware.
process.stdin.setEncoding('utf8')
let buffer = ''
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n')

process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    const req = JSON.parse(line)
    switch (req.cmd) {
      case 'listen_start':
        emit({ id: req.id, event: 'partial', text: 'hello', level: 0.4 })
        emit({ id: req.id, event: 'partial', text: 'hello world', level: 0.6 })
        break
      case 'listen_stop':
        emit({ id: req.id, event: 'final', text: 'hello world' })
        break
      case 'capture':
        emit({ id: req.id, event: 'captured', path: '/tmp/fake.jpg', w: 1280, h: 800 })
        break
      case 'speak':
        setTimeout(() => emit({ id: req.id, event: 'speech_done' }), 10)
        break
      case 'click':
      case 'type':
      case 'key':
      case 'scroll':
        if (req.fail) emit({ id: req.id, event: 'error', code: 'not_trusted', message: 'not trusted' })
        else emit({ id: req.id, event: 'acted' })
        break
      case 'hang':
        break // deliberately never replies, so a caller can be left in flight
      case 'crash':
        process.exit(1)
      default:
        emit({ id: req.id, event: 'error', code: 'unknown', message: req.cmd })
    }
  }
})
