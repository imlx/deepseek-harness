/**
 * Reusable main-process subscription to the dsh session-event stream.
 *
 * This is the shell↔dsh bridge foundation: the single channel every
 * desktop capability (notifications, tray, plugin management) hangs off. It
 * rides the **existing** host mux stream — `api.events.mux()`, the same
 * downlink the renderer consumes over the IPC bridge — so the shell adds no
 * transport, no endpoint, and no local HTTP server. The mux stream pushes the
 * authoritative `SessionEventMap` plus control frames; on open it replays every
 * session's still-pending approval/question, so a shell that (re)subscribes
 * after a window reload recovers the same baseline the renderer does.
 *
 * Frames are narrowed by their `type` discriminant into the semantic callbacks
 * a desktop capability cares about. The `SessionEventMap` is merge-extensible
 * (schedule, llm-retry, agent, … all merge members in), so this module does
 * NOT assertNever on the union: any frame variant it does not model falls
 * through the documented default and is ignored, keeping the foundation stable
 * as upstream adds event types. New desktop features extend the sink, not the
 * transport.
 *
 * Lifecycle: `subscribeMuxEvents` returns a disposer. `main.ts` already
 * disposes the whole cordis tree on `window-all-closed`; the returned disposer
 * aborts only this subscription's pump, so a capability can detach without
 * tearing the session down.
 */
import type { EventsApi, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

/**
 * Semantic callbacks the shell cares about, distilled from the raw mux frames.
 * Every method is optional: a capability subscribes to only the slices it
 * renders. All callbacks receive already-narrowed payloads — callers never
 * switch on `MuxFrame` themselves.
 */
export interface MuxEventSink {
  /** A tool call is awaiting a human decision (the approval baseline is replayed on subscribe). */
  onApprovalRequested?: (sessionId: SessionId, approvalId: ApprovalRequestId, toolName: string, reason?: string) => void
  /** A pending approval settled. */
  onApprovalResolved?: (sessionId: SessionId, approvalId: ApprovalRequestId, outcome: ApprovalOutcome) => void
  /** The agent asked the user a structured question. */
  onQuestionRequested?: (sessionId: SessionId, questions: AskUserQuestionItem[]) => void
  /** A turn closed. `reason` is the core `TurnEndReason` (completed/aborted/error/…). */
  onTurnEnd?: (sessionId: SessionId, event: SessionEvent<'turn/end'>) => void
  /**
   * Any other session event, passed through untouched. Capabilities that need
   * an event this sink does not yet model read it here; the foundation does not
   * enumerate the merge-extensible map.
   */
  onSessionEvent?: (sessionId: SessionId, event: SessionEvent) => void
  /** The stream reported a transport/server error or the pump itself failed. */
  onError?: (error: unknown) => void
}

/**
 * Subscribe the shell to the aggregated mux stream, distilling frames into `sink`.
 *
 * The pump is an async iterator over `events.mux`; cancelling the returned
 * disposer aborts the stream's `signal` and lets the iterator finish, so no
 * frame is processed after dispose and no rejection escapes the pump.
 *
 * @param events - the host `EventsApi` face (`ctx.apiProxy.events`).
 * @param sink - semantic callbacks; each is invoked synchronously per frame.
 * @returns a disposer that detaches this subscription.
 */
export function subscribeMuxEvents(events: Pick<EventsApi, 'mux'>, sink: MuxEventSink): () => void {
  const cancel = new AbortController()
  const stream = events.mux({ rpcId: RpcId(crypto.randomUUID()), payload: {} }, cancel.signal)

  void (async () => {
    try {
      for await (const frame of stream) {
        dispatch(frame.payload, sink)
      }
    } catch (error) {
      // Abortion from our own disposer is the normal teardown path, not an error.
      if (!cancel.signal.aborted) sink.onError?.(error)
    }
  })()

  return () => { cancel.abort() }
}

/**
 * Narrow one mux frame by its `type` discriminant and invoke the matching sink
 * callback. Unmodelled variants — every merge-extended `session/event` type this
 * sink does not special-case, plus control/projection frames — fall through the
 * default and are ignored by design; see the module doc.
 */
function dispatch(frame: MuxFrame, sink: MuxEventSink): void {
  switch (frame.type) {
    case 'approval/requested':
      sink.onApprovalRequested?.(frame.sessionId, frame.approvalId, frame.toolName, frame.reason)
      return
    case 'approval/resolved':
      sink.onApprovalResolved?.(frame.sessionId, frame.approvalId, frame.outcome)
      return
    case 'question/requested':
      sink.onQuestionRequested?.(frame.sessionId, frame.questions)
      return
    case 'session/event':
      // turn/end is the one session event the desktop shell acts on directly
      // (drive a completion notification); every other event passes through.
      // SessionEvent is a discriminated union, so the type guard narrows event.
      if (frame.event.type === 'turn/end') {
        sink.onTurnEnd?.(frame.sessionId, frame.event)
        return
      }
      sink.onSessionEvent?.(frame.sessionId, frame.event)
      return
    case 'stream/error':
      sink.onError?.(frame.error)
      return
    default:
      // session/subscribed, session/queue, session/jobs, session/projection,
      // question/resolved: control and projection frames the desktop shell does
      // not consume. Documented default — ignored, not asserted unreachable.
      return
  }
}
