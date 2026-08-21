import { describe, expect, it, vi } from 'vitest'
import type { EventsApi, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { SessionId as toSessionId } from '@deepseek-ai/dsh-session/types'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { subscribeMuxEvents, type MuxEventSink } from '../src/events.ts'

const SID = toSessionId('session-d0')

/**
 * A controllable mux stream faithful to the real one: `push` wakes a pending
 * consumer, aborting the subscription's signal ends the iteration, and `close`
 * ends it cleanly. Frames pushed after the stream ended are dropped. Only the
 * `mux` face is implemented — the sink never touches `host`.
 */
function fakeEvents(): {
  events: Pick<EventsApi, 'mux'>
  push: (frame: MuxFrame) => void
  close: () => void
} {
  const pushed: MuxFrame[] = []
  const waiters: Array<() => void> = []
  let done = false
  const events: Pick<EventsApi, 'mux'> = {
    mux: (_req, signal) => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((resolve) => {
            const trySettle = (): boolean => {
              const payload = pushed.shift()
              if (payload !== undefined) { resolve({ value: { rpcId: RpcId('r'), payload }, done: false }); return true }
              if (done || signal.aborted) { resolve({ value: undefined, done: true }); return true }
              return false
            }
            if (!trySettle()) {
              const wake = (): void => { void trySettle() }
              waiters.push(wake)
              signal.addEventListener('abort', wake, { once: true })
            }
          }),
      }),
    }),
  }
  const notify = (): void => { for (const w of waiters.splice(0)) w() }
  return {
    events,
    push: (frame) => { if (!done) pushed.push(frame); notify() },
    close: () => { done = true; notify() },
  }
}

function turnEnd(kind: 'completed' | 'error'): SessionEvent<'turn/end'> {
  return { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind } } } as SessionEvent<'turn/end'>
}

const QUESTIONS: AskUserQuestionItem[] = []

describe('subscribeMuxEvents', () => {
  it('routes approval, question, and turn-end frames to their sink callbacks', async () => {
    const { events, push, close } = fakeEvents()
    const sink = {
      onApprovalRequested: vi.fn(),
      onApprovalResolved: vi.fn(),
      onQuestionRequested: vi.fn(),
      onTurnEnd: vi.fn(),
    } satisfies MuxEventSink
    subscribeMuxEvents(events, sink)

    push({ type: 'approval/requested', sessionId: SID, approvalId: ApprovalRequestId('a1'), toolName: 'bash' })
    push({ type: 'approval/resolved', sessionId: SID, approvalId: ApprovalRequestId('a1'), outcome: 'allowed-once' })
    push({ type: 'question/requested', sessionId: SID, questions: QUESTIONS })
    push({ type: 'session/event', sessionId: SID, event: turnEnd('completed') })
    close()

    await vi.waitFor(() => {
      expect(sink.onApprovalRequested).toHaveBeenCalledWith(SID, ApprovalRequestId('a1'), 'bash', undefined)
      expect(sink.onApprovalResolved).toHaveBeenCalledWith(SID, ApprovalRequestId('a1'), 'allowed-once')
      expect(sink.onQuestionRequested).toHaveBeenCalledWith(SID, QUESTIONS)
      expect(sink.onTurnEnd).toHaveBeenCalledWith(SID, turnEnd('completed'))
    })
  })

  it('passes through unmodelled session events and ignores control frames', async () => {
    const { events, push, close } = fakeEvents()
    const sink = { onSessionEvent: vi.fn(), onTurnEnd: vi.fn() } satisfies MuxEventSink
    subscribeMuxEvents(events, sink)

    const todo = { type: 'todo/write', seq: 2, time: 1, data: { todos: [] } } as unknown as SessionEvent
    push({ type: 'session/subscribed', sessionId: SID, lastSeq: 9 })
    push({ type: 'session/event', sessionId: SID, event: todo })
    close()

    await vi.waitFor(() => {
      expect(sink.onSessionEvent).toHaveBeenCalledWith(SID, todo)
      expect(sink.onTurnEnd).not.toHaveBeenCalled()
    })
  })

  it('routes stream/error frames to onError, but not self-abort on dispose', async () => {
    const { events, push } = fakeEvents()
    const onError = vi.fn()
    const dispose = subscribeMuxEvents(events, { onError })
    push({ type: 'stream/error', error: { code: 'boom', message: 'x' } as never })
    await vi.waitFor(() => { expect(onError).toHaveBeenCalledTimes(1) })

    // Self-abort (dispose) is clean teardown: it must not surface as an error.
    dispose()
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('stops dispatching after dispose', async () => {
    const { events, push } = fakeEvents()
    const onApprovalRequested = vi.fn()
    const dispose = subscribeMuxEvents(events, { onApprovalRequested })
    dispose()
    push({ type: 'approval/requested', sessionId: SID, approvalId: ApprovalRequestId('a2'), toolName: 'fs' })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(onApprovalRequested).not.toHaveBeenCalled()
  })
})
