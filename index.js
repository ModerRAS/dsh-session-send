/**
 * Cross-session direct messaging for DeepSeek Harness.
 *
 * Registers one model-facing tool `session_send` that delivers a text message
 * to another Session's inbox through `ctx.sessionController.prompt()`.
 *
 * v1.2.0 resolves the target through the Host session surfaces the runtime
 * always has:
 * - a live Agent (`ctx.agents`) when the target is open in this process;
 * - otherwise the durable header from `ctx.sessionPersistence.stat()`, which
 *   covers Sessions created before this process started.
 *
 * The previous release authorized cold targets through `ctx.sessionQuery`,
 * which is unavailable in this profile (session search fails with
 * SESSION_QUERY_PERSISTENCE_FAILED) and made every old Session look
 * unauthorized. The query seam is no longer a dependency.
 *
 * No top-level `@deepseek-ai/*` imports on purpose: on desktop profiles those
 * peers are not installed and a bare import fails the whole entry. Everything
 * below uses only `ctx` services and `node:crypto`.
 *
 * @module @local/dsh-session-send
 */

import { randomUUID } from 'node:crypto'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'session-send'

/**
 * Required Host services. `agents`, `sessionPersistence` and
 * `workspaceRegistry` are read through `ctx.get` so a composition without one
 * still loads the tool.
 */
export const inject = ['tools', 'systemPrompt', 'sessionController', 'sessions']

const AUTHORIZATION_TEXT =
  'Only send a cross-session message at the user\'s explicit request. '
  + 'session_send delivers immediately to another Session in this profile and wakes it. '
  + 'Never use it for replies inside the current session.'

/** Numeric prompt order between TOOL_SESSION_QUERY (2300) and TOOL_GOAL (2400). */
const SECTION_ORDER = 2350

const SEND_ERRORS = [
  'invalid_text',
  'invalid_target',
  'unauthorized',
  'target_archived',
  'target_not_found',
  'target_ambiguous',
  'target_busy',
  'target_conflict',
  'target_unmigrated',
  'session_index_unavailable',
  'delivery_failed',
  'subagent_session',
  'internal_error',
]

// NOTE: ctx.tools.register() takes already-compiled RAW JSON schemas
// (it calls assertSupportedJsonSchema directly). It does NOT compile the
// author DSL the way defineTool() does, so per-property `required: true`
// is rejected here. Required fields must be lifted to an object-level
// `required: [...]` array.
const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    target_session_id: {
      type: 'string',
      description: 'Exact target session id (from a list call or the sidebar). Any ordinary Session in this profile is allowed; self-send is refused.',
    },
    target: {
      type: 'string',
      description: 'Target by id, by session title substring, or "latest" for the most recently active Session other than this one. Use list:true when the id is unknown.',
    },
    list: {
      type: 'boolean',
      description: 'Return candidate Sessions (id, title, cwd, last update) instead of sending. Use it first when the target id is unknown.',
    },
    text: {
      type: 'string',
      description: 'Message text delivered to the target session. Non-empty after trimming, at most 8000 characters. Required unless list is true.',
    },
    mode: {
      type: 'string',
      enum: ['queue', 'steer'],
      description: 'steer (default) injects the message at the target next step boundary and starts a turn when it is idle; queue waits until its current turn finishes. Omit for steer.',
    },
  },
}

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        accepted: { type: 'boolean', const: true },
        targetSessionId: { type: 'string' },
        targetCwd: { type: 'string' },
        resumed: { type: 'boolean' },
        mode: { type: 'string', enum: ['queue', 'steer'] },
      },
      required: ['accepted', 'targetSessionId'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              cwd: { type: 'string' },
              updatedAt: { type: 'number' },
              running: { type: 'boolean' },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
      },
      required: ['sessions'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        code: { type: 'string', enum: SEND_ERRORS },
        message: { type: 'string' },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
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

/** Resolve the caller's working directory, if it has one. */
function callerCwdOf(agent) {
  try {
    return agent?.session?.header?.cwd
  } catch {
    return undefined
  }
}

/**
 * Resolve one target Session from the surfaces available to this Host.
 * @param ctx - the plugin context.
 * @param sessionId - target Session id.
 * @param signal - cancellation for the persistence read.
 * @returns the delivery facts, or a refusal.
 */
async function resolveTarget(ctx, sessionId, signal) {
  const live = ctx.get('agents')?.get(sessionId)
  if (live !== undefined) {
    const header = live.session.header
    return {
      live: true,
      cwd: header.cwd,
      origin: header.origin,
      formatStatus: undefined,
    }
  }

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    return { error: err('session_index_unavailable', 'This deployment composes no session persistence, so a cold Session cannot be resolved.') }
  }
  let snapshot
  try {
    snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
  } catch (error) {
    try {
      signal?.throwIfAborted()
    } catch {
      return { error: err('delivery_failed', 'session_send was cancelled.') }
    }
    return { error: err('session_index_unavailable', `Session storage could not be read: ${String(error?.message ?? error)}`) }
  }
  if (snapshot === undefined) {
    return { error: err('target_not_found', `No Session ${sessionId} exists in this profile.`) }
  }
  const header = snapshot.header
  return {
    live: false,
    cwd: header.cwd,
    origin: header.origin,
    formatStatus: snapshot.formatStatus,
  }
}

/**
 * List candidate Sessions so a caller that does not know the target id can
 * address one by title (or by `latest`). Prefers the Host's own list surface —
 * the same one the sidebar reads, which carries titled projection summaries —
 * and falls back to the persistence header listing when that surface refuses a
 * Host-side call.
 * @param ctx - the plugin context.
 * @param signal - cancellation for the listing.
 * @returns rows ordered as the list surface returns them (most recent first).
 */
async function listCandidateSessions(ctx, signal) {
  const abortSignal = signal ?? new AbortController().signal
  const controller = ctx.sessionController
  if (typeof controller?.list === 'function') {
    try {
      const value = await controller.list({}, abortSignal)
      if (Array.isArray(value?.items)) {
        return value.items.map((item) => ({
          id: String(item.sessionId),
          title: typeof item.projections?.values?.title === 'string' ? item.projections.values.title : '',
          cwd: typeof item.cwd === 'string' ? item.cwd : '',
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
          running: item.running === true,
        }))
      }
    } catch {
      // Fall through to the persistence listing.
    }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.list !== 'function') return []
  let records
  try {
    records = await persistence.list({ signal: abortSignal })
  } catch {
    return []
  }
  return records
    .map((record) => ({
      id: String(record.header.id),
      title: '',
      cwd: typeof record.header.cwd === 'string' ? record.header.cwd : '',
      updatedAt: Number.isFinite(record.header.createdAt) ? record.header.createdAt : 0,
      running: false,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/** Whether one string names a session id rather than a title. */
function looksLikeSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/**
 * Resolve the tool's target argument to one Session id.
 * @param ctx - the plugin context.
 * @param spec - exact id, title substring, or `latest`.
 * @param signal - cancellation for the listing.
 * @param selfId - the caller's own id, never a candidate.
 * @returns the resolved id or a refusal (ambiguity carries candidates).
 */
async function resolveTargetSpec(ctx, spec, signal, selfId) {
  if (spec.length === 0) {
    return { error: err('invalid_target', 'Pass target_session_id (or target), or list:true to find one.') }
  }
  if (spec === 'latest') {
    const rows = (await listCandidateSessions(ctx, signal)).filter((row) => row.id !== selfId)
    const pick = rows[0]
    if (pick === undefined) return { error: err('target_not_found', 'No other Session exists in this profile.') }
    return { id: pick.id }
  }
  if (looksLikeSessionId(spec)) return { id: spec }

  const rows = (await listCandidateSessions(ctx, signal)).filter((row) => row.id !== selfId)
  const needle = spec.toLowerCase()
  const hits = rows.filter((row) =>
    (row.title !== '' && row.title.toLowerCase().includes(needle))
    || row.id.toLowerCase().startsWith(needle))
  if (hits.length === 1) return { id: hits[0].id }
  if (hits.length === 0) {
    return {
      error: err(
        'target_not_found',
        `No Session matches "${spec}". Call session_send with list:true to see candidate ids and titles.`,
      ),
    }
  }
  return {
    error: {
      code: 'target_ambiguous',
      message: `${hits.length} Sessions match "${spec}"; retry with target_session_id.`,
      candidates: hits.slice(0, 10).map((row) => ({ id: row.id, title: row.title })),
    },
  }
}

/**
 * Map a target-Agent resolution failure onto this tool's vocabulary.
 * @param error - the `session/…` error returned by `resolveAgent`, or a throw.
 * @returns the refusal payload.
 */
function mapResolveFailure(error) {
  const message = String(error?.message ?? error ?? 'target session could not be resolved')
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code.includes('not-found')) return err('target_not_found', message)
  if (code.includes('writer-held')) return err('target_busy', `The target Session is written by another process: ${message}`)
  if (code.includes('agent-busy')) {
    return err(message.includes('subagent') ? 'subagent_session' : 'target_busy', message)
  }
  if (message.includes('archived')) return err('target_archived', message)
  return err('delivery_failed', message)
}

/** Register `session_send` and its guidance in the mounting scope. */
export function apply(ctx, config) {
  const sameWorkspaceOnly = config?.sameWorkspaceOnly === true
  // `steer` is the default delivery mode: an idle driver starts a turn, a busy
  // one sees the message at its next step boundary. A row config can flip the
  // default back without touching code.
  const defaultMode = config?.defaultMode === 'queue' ? 'queue' : 'steer'

  ctx.systemPrompt.section({
    name: 'tool:session-send',
    order: SECTION_ORDER,
    text: ({ scope }) =>
      ctx.tools.get('session_send', scope) !== undefined ? AUTHORIZATION_TEXT : '',
  })

  ctx.tools.register({
    name: 'session_send',
    description:
      'Send a text message to another Session in this profile. '
      + 'It arrives as an agent relay — a foldable "agent message" row attributed to the sending Session, not a human prompt — and wakes the target, '
      + 'including a Session that is not open in this process (it is resumed). '
      + 'Address the target by exact id, by a session title substring, or with "latest"; pass list:true first when the id is unknown. '
      + 'Delivery defaults to steer: an idle target starts a turn, a busy target sees the message at its next step boundary. '
      + 'Attachments are not supported.',
    parameters: PARAMETERS_SCHEMA,
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    execute: (args, exec) => runSend(ctx, { sameWorkspaceOnly, defaultMode }, args, exec),
    presentCall: (args) => ({
      card: 'generic',
      title: 'Send session message',
      kind: 'other',
      rawInput: args?.text,
    }),
  })
}

async function runSend(ctx, options, args, exec) {
  const agent = exec?.agent
  if (agent === undefined) return err('internal_error', 'session_send requires an agent-bound caller.')
  let depth
  try {
    depth = depthOf(agent)
  } catch {
    return err('internal_error', 'session_send requires an agent-bound caller.')
  }

  // Listing is read-only, so a delegated subagent may use it to discover ids;
  // only delivery stays limited to top-level agents.
  if (args?.list === true) {
    try {
      const rows = await listCandidateSessions(ctx, exec.signal)
      return {
        sessions: rows.slice(0, 30).map((row) => ({
          id: row.id,
          title: row.title,
          cwd: row.cwd,
          updatedAt: row.updatedAt,
          running: row.running,
        })),
      }
    } catch (error) {
      return err('delivery_failed', `Session listing failed: ${String(error?.message ?? error)}`)
    }
  }

  if (depth > 0) {
    return err('subagent_session', 'A delegated subagent cannot send cross-session messages.')
  }

  const text = typeof args?.text === 'string' ? args.text.trim() : ''
  if (text.length === 0) return err('invalid_text', 'text must be non-empty after trimming (omit it only with list:true).')
  if (text.length > 8000) return err('invalid_text', 'text must be at most 8000 characters.')

  const rawSpec = typeof args?.target_session_id === 'string' && args.target_session_id.trim().length > 0
    ? args.target_session_id.trim()
    : (typeof args?.target === 'string' ? args.target.trim() : '')
  const resolvedTarget = await resolveTargetSpec(ctx, rawSpec, exec.signal, agent.session.id)
  if (resolvedTarget.error !== undefined) return resolvedTarget.error
  const targetSessionId = resolvedTarget.id
  if (targetSessionId === agent.session.id) {
    return err('invalid_target', 'target_session_id must name a different session, not the caller itself.')
  }

  const mode = args?.mode ?? options.defaultMode
  if (mode !== 'queue' && mode !== 'steer') {
    return err('invalid_target', 'mode must be "queue" or "steer".')
  }

  const callerCwd = callerCwdOf(agent)
  if (callerCwd === undefined) {
    return err('unauthorized', 'cross-session send is unavailable because the caller session has no workspace.')
  }

  // Archived targets are refused up front: prompt would admit the message but
  // the archived gate ends the turn as blocked without running it.
  try {
    const archived = ctx.get('workspaceRegistry')?.archivedSessionIds
    if (Array.isArray(archived) && archived.includes(targetSessionId)) {
      return err('target_archived', `target session "${targetSessionId}" is archived.`)
    }
  } catch {
    // Workspace registry is optional; a lookup failure falls through.
  }

  const target = await resolveTarget(ctx, targetSessionId, exec.signal)
  if (target.error !== undefined) return target.error

  if (target.origin === 'subagent') {
    return err('subagent_session', 'target session is owned by subagent routing; use subagent delivery.')
  }
  if (target.formatStatus === 'migration-required') {
    return err('target_unmigrated', `target session "${targetSessionId}" needs a format migration before it can be resumed.`)
  }
  if (target.cwd === undefined) {
    return err('target_not_found', `target session "${targetSessionId}" has no workspace and cannot be resumed.`)
  }
  if (options.sameWorkspaceOnly && target.cwd !== callerCwd) {
    return err('unauthorized', `target session is outside the caller workspace (${target.cwd}).`)
  }

  // Deliver as an Agent relay, not as a human prompt: the durable source
  // `{ kind: 'agent-message', form: 'relay' }` is what the Chat transcript
  // renders as a foldable "agent message" trigger row, the same shape the
  // subagent and teammate transports use. A plain prompt would show up as if
  // the human had typed it.
  const senderSessionId = agent.session.id
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [
      { type: 'text', text: `Session ${senderSessionId} sent a message: ` },
      { type: 'text', text },
    ],
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  }

  try {
    exec.signal?.throwIfAborted()
    const found = await ctx.sessionController.resolveAgent(targetSessionId)
    if (found?.agent === undefined) return mapResolveFailure(found?.error)
    const targetAgent = found.agent
    if (mode === 'steer') targetAgent.steer(message)
    else targetAgent.followup(message)
    if (typeof ctx.sessions?.flush === 'function') {
      const flushed = await ctx.sessions.flush(targetAgent.session)
      if (flushed === false) return err('delivery_failed', 'Session persistence did not acknowledge the message.')
    }
    return {
      accepted: true,
      targetSessionId,
      targetCwd: target.cwd,
      resumed: target.live !== true,
      mode,
    }
  } catch (error) {
    try {
      exec.signal?.throwIfAborted()
    } catch {
      return err('delivery_failed', 'session_send was cancelled.')
    }
    return mapResolveFailure(error)
  }
}
