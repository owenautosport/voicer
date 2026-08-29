import { describe, it, expect, vi } from 'vitest'
import { TurnMachine, type TurnEvent, type TurnState } from './turn-machine'

const drive = (m: TurnMachine, events: TurnEvent[]) => events.forEach((e) => m.send(e))

describe('TurnMachine', () => {
  it('starts idle', () => {
    expect(new TurnMachine().state).toBe('idle')
  })

  it('first mic click starts listening, second stops it', () => {
    const m = new TurnMachine()
    expect(m.send({ type: 'MIC_CLICK' })).toBe('listening')
    expect(m.send({ type: 'MIC_CLICK' })).toBe('transcribing')
  })

  it('walks a full happy turn to idle', () => {
    const m = new TurnMachine()
    drive(m, [{ type: 'MIC_CLICK' }, { type: 'MIC_CLICK' }])
    expect(m.send({ type: 'TRANSCRIPT', text: 'what is this' })).toBe('capturing')
    expect(m.send({ type: 'CAPTURED', path: '/tmp/a.jpg' })).toBe('thinking')
    expect(m.send({ type: 'AGENT_TEXT', text: 'It is a form.' })).toBe('speaking')
    expect(m.send({ type: 'AGENT_DONE', sessionId: 's1' })).toBe('speaking')
    expect(m.send({ type: 'SPEECH_DONE' })).toBe('idle')
  })

  it('an empty transcript abandons the turn without calling the agent', () => {
    const m = new TurnMachine()
    drive(m, [{ type: 'MIC_CLICK' }, { type: 'MIC_CLICK' }])
    expect(m.send({ type: 'TRANSCRIPT', text: '   ' })).toBe('idle')
  })

  it('a tool call moves to acting, and text moves back to speaking', () => {
    const m = new TurnMachine()
    drive(m, [
      { type: 'MIC_CLICK' }, { type: 'MIC_CLICK' },
      { type: 'TRANSCRIPT', text: 'send it' }, { type: 'CAPTURED', path: '/tmp/a.jpg' },
    ])
    expect(m.send({ type: 'AGENT_TOOL', tool: 'click' })).toBe('acting')
    expect(m.send({ type: 'AGENT_TEXT', text: 'Done.' })).toBe('speaking')
  })

  it('AGENT_DONE with no pending speech returns to idle', () => {
    const m = new TurnMachine()
    drive(m, [
      { type: 'MIC_CLICK' }, { type: 'MIC_CLICK' },
      { type: 'TRANSCRIPT', text: 'go' }, { type: 'CAPTURED', path: '/tmp/a.jpg' },
      { type: 'AGENT_TOOL', tool: 'click' },
    ])
    expect(m.send({ type: 'AGENT_DONE', sessionId: 's1' })).toBe('idle')
  })

  it.each<TurnState>([
    'listening', 'transcribing', 'capturing', 'thinking', 'speaking', 'acting',
  ])('ABORT from %s returns to idle', (target) => {
    const m = new TurnMachine()
    const path: TurnEvent[] = [
      { type: 'MIC_CLICK' }, { type: 'MIC_CLICK' },
      { type: 'TRANSCRIPT', text: 'go' }, { type: 'CAPTURED', path: '/tmp/a.jpg' },
      { type: 'AGENT_TOOL', tool: 'click' }, { type: 'AGENT_TEXT', text: 'hi' },
    ]
    for (const e of path) {
      if (m.state === target) break
      m.send(e)
    }
    expect(m.state).toBe(target)
    expect(m.send({ type: 'ABORT' })).toBe('idle')
  })

  it('FAIL moves to error and the next mic click recovers to listening', () => {
    const m = new TurnMachine()
    m.send({ type: 'MIC_CLICK' })
    expect(m.send({ type: 'FAIL', message: 'sidecar died' })).toBe('error')
    expect(m.send({ type: 'MIC_CLICK' })).toBe('listening')
  })

  it('notifies subscribers of transitions and stops after unsubscribe', () => {
    const m = new TurnMachine()
    const seen = vi.fn()
    const off = m.onChange(seen)
    m.send({ type: 'MIC_CLICK' })
    expect(seen).toHaveBeenCalledWith('listening', 'idle')
    off()
    m.send({ type: 'MIC_CLICK' })
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('ignores events that make no sense in the current state', () => {
    const m = new TurnMachine()
    expect(m.send({ type: 'CAPTURED', path: '/tmp/a.jpg' })).toBe('idle')
  })
})
