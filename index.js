/**
 * Cross-session direct messaging for DeepSeek Harness.
 *
 * Registers one model-facing tool `session_send` that delivers a text message
 * to another Session's inbox through `ctx.sessionController.prompt()`.
 * Authorization mirrors `tool-session-query`: the target must share the
 * caller's exact `cwd`. Subagent-owned and archived Sessions are refused.
 *
 * No top-level `@deepseek-ai/*` imports on purpose: on desktop profiles those
 * peers are not installed and a bare import fails the whole entry. Everything
 * below uses only the `ctx` services and `node:crypto`.
 *
 * @module @local/dsh-session-send
 */

import { randomUUID } from 'node:crypto'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'session-send'

/**
 * Required Host services. The plugin stays inactive in compositions
 * without any of these, so the tool never appears half-wired.
 */
export const inject = ['tools', 'systemPrompt', 'sessionQuery', 'sessionController', 'agents']

const AUTHORIZATION_TEXT =
  'Only send a cross-session message at the user\'s explicit request. '
  + 'session_send delivers immediately to another session in the same workspace (exact cwd match) '
  + 'and wakes it. Never use it for replies inside the current session.'

/** Numeric prompt order between TOOL_SESSION_QUERY (2300) and TOOL_GOAL (2400). */
const SECTION_ORDER = 2350

const SEND_ERRORS = [
  'invalid_text',
  'invalid_target',
  'unauthorized',
  'target_archived',
  'target_not_found',
  'delivery_failed',
  'subagent_session',
  'internal_error',
]

// NOTE: ctx.tools.register() takes already-compiled RAW JSON schemas
// (it calls assertSupportedJsonSchema directly). It does NOT compile the
// author DSL the way defineTool() does, so per-property `required: true`
// is rejected here ("required is not supported on type boolean/string").
// Required fields must be lifted to an object-level `required: [...]` array.
// See web-server.log: JsonSchemaError from session-send did not activate.
const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    target_session_id: {
      type: 'string',
      description: 'Target session id. Must share the caller exact cwd; self-send is refused.',
    },
    text: {
      type: 'string',
      description: 'Message text delivered to the target session. Non-empty after trimming, at most 8000 characters.',
    },
    mode: {
      type: 'string',
      enum: ['queue', 'steer'],
      description: 'queue (default) appends a normal followup turn; steer interrupts to the next step boundary. Omit for queue.',
    },
  },
  required: ['target_session_id', 'text'],
}

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        accepted: { type: 'boolean', const: true },
        targetSessionId: { type: 'string' },
      },
      required: ['accepted', 'targetSessionId'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        code: { type: 'string', enum: SEND_ERRORS },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  ],
}

function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function err(code, message) {
  return { code, message }
}

/**
 * Local delegation-depth read (mirrors `delegationDepthOf` without importing
 * `@deepseek-ai/dsh-subagent`, which is not installed on desktop profiles).
 */
function depthOf(agent) {
  const runtime = agent?.options?.subagentDepth
  if (runtime !== undefined) {
    if (!Number.isSafeInteger(runtime) || runtime < 0) throw new TypeError('bad depth')
    return Math.max(agent.session.header.delegationDepth ?? 0, runtime)
  }
  return agent.session.header.delegationDepth ?? 0
}

/** Register `session_send` and its guidance in the mounting scope. */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:session-send',
    order: SECTION_ORDER,
    text: ({ scope }) =>
      ctx.tools.get('session_send', scope) !== undefined ? AUTHORIZATION_TEXT : '',
  })

  ctx.tools.register({
    name: 'session_send',
    description:
      'Send a text message to another session in the same workspace. '
      + 'The message enters the target session inbox immediately as a user message and wakes it. '
      + 'Use session_search to find the target session id first. '
      + 'Only the target session id, text, and delivery mode are accepted; file/image attachments are not supported.',
    parameters: PARAMETERS_SCHEMA,
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    execute: (args, exec) => runSend(ctx, args, exec),
    presentCall: (args) => ({
      card: 'generic',
      title: 'Send session message',
      kind: 'other',
      rawInput: args?.text,
    }),
  })
}

async function runSend(ctx, args, exec) {
  const agent = exec?.agent
  if (agent === undefined) return err('internal_error', 'session_send requires an agent-bound caller.')
  try {
    if (depthOf(agent) > 0) {
      return err('subagent_session', 'A delegated subagent cannot send cross-session messages.')
    }
  } catch {
    return err('internal_error', 'session_send requires an agent-bound caller.')
  }

  const text = typeof args?.text === 'string' ? args.text.trim() : ''
  if (text.length === 0) return err('invalid_text', 'text must be non-empty after trimming.')
  if (text.length > 8000) return err('invalid_text', 'text must be at most 8000 characters.')

  const targetSessionId = typeof args?.target_session_id === 'string' ? args.target_session_id.trim() : ''
  if (targetSessionId.length === 0) return err('invalid_target', 'target_session_id must be a non-empty session id.')
  if (targetSessionId === agent.session.id) {
    return err('invalid_target', 'target_session_id must name a different session, not the caller itself.')
  }

  const mode = args?.mode ?? 'queue'
  if (mode !== 'queue' && mode !== 'steer') {
    return err('invalid_target', 'mode must be "queue" or "steer".')
  }

  const callerCwd = agent.session.header.cwd
  if (callerCwd === undefined) {
    return err('unauthorized', 'cross-session send is unavailable because the caller session has no workspace.')
  }

  // Archived targets are refused up front: prompt would admit the message
  // but the archived gate ends the turn as blocked without running it.
  try {
    const archived = ctx.get('workspaceRegistry')?.archivedSessionIds
    if (Array.isArray(archived) && archived.includes(targetSessionId)) {
      return err('target_archived', `target session "${targetSessionId}" is archived.`)
    }
  } catch {
    // Workspace registry is optional; a lookup failure falls through to query auth.
  }

  // Live-target fast path: same-process agent registry, no persistence read.
  const live = ctx.agents.get(targetSessionId)
  if (live !== undefined) {
    let depth = 0
    try {
      depth = depthOf(live)
    } catch {
      return err('target_not_found', `target session "${targetSessionId}" cannot be inspected.`)
    }
    if (depth > 0) {
      return err('subagent_session', 'target session is owned by subagent routing; use subagent delivery.')
    }
    const header = live.session.header
    if (header.origin === 'subagent') {
      return err('subagent_session', 'target session is owned by subagent routing; use subagent delivery.')
    }
    if (header.cwd !== callerCwd) {
      return err('unauthorized', 'session target is outside the caller workspace.')
    }
  } else {
    // Cold-target path: existence + exact-cwd match in one query, so a
    // missing session and a cross-workspace session look identical.
    let records
    try {
      exec.signal?.throwIfAborted()
      records = await ctx.sessionQuery.filterSessions(
        [
          { kind: 'id', values: [targetSessionId] },
          { kind: 'cwd', values: [callerCwd] },
        ],
        exec.signal,
      )
    } catch (error) {
      try {
        exec.signal?.throwIfAborted()
      } catch {
        return err('delivery_failed', 'session_send was cancelled.')
      }
      return err('delivery_failed', `target session could not be inspected: ${String(error?.message ?? error)}`)
    }
    if (!Array.isArray(records) || records.length !== 1) {
      return err('unauthorized', 'session target is outside the caller workspace.')
    }
    const header = records[0]?.header
    if (header?.id !== targetSessionId || header?.cwd !== callerCwd) {
      return err('unauthorized', 'session target is outside the caller workspace.')
    }
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) {
      return err('subagent_session', 'target session is owned by subagent routing; use subagent delivery.')
    }
  }

  const requestId = `send-${randomUUID()}`
  try {
    exec.signal?.throwIfAborted()
    const result = await ctx.sessionController.prompt(
      {
        requestId,
        sessionId: targetSessionId,
        mode,
        content: [{ type: 'text', text }],
      },
      exec.signal,
    )
    if (result?.accepted === true) return { accepted: true, targetSessionId }
    return err('delivery_failed', 'target session did not accept the message.')
  } catch (error) {
    try {
      exec.signal?.throwIfAborted()
    } catch {
      return err('delivery_failed', 'session_send was cancelled.')
    }
    const message = error?.message ?? String(error)
    if (typeof message === 'string' && message.includes('archived')) {
      return err('target_archived', message)
    }
    return err('delivery_failed', message)
  }
}
