// Offline check of the session_send delivery + addressing paths.
import { apply } from './index.js'

const deliveries = []
const flushes = []

const CALLER_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_ID = '22222222-2222-4222-8222-222222222222'

function makeCtx(overrides = {}) {
  const registered = {}
  const targetAgent = {
    session: { id: overrides.targetId ?? TARGET_ID, header: { cwd: '/work' } },
    steer(message) { deliveries.push({ how: 'steer', message }) },
    followup(message) { deliveries.push({ how: 'followup', message }) },
  }
  const ctx = {
    tools: { register(definition) { registered[definition.name] = definition }, get() { return {} } },
    systemPrompt: { section() {} },
    sessionController: {
      async resolveAgent() { return overrides.resolve ? overrides.resolve() : { agent: targetAgent } },
      ...(overrides.list === undefined ? {} : { async list() { return overrides.list } }),
    },
    sessions: { async flush(session) { flushes.push(session.id); return overrides.flush === undefined ? true : overrides.flush } },
    get(name) {
      if (name === 'agents') return overrides.agents
      if (name === 'sessionPersistence') return overrides.persistence
      if (name === 'workspaceRegistry') return overrides.workspaceRegistry
      return undefined
    },
  }
  apply(ctx, overrides.config ?? {})
  return { tool: registered.session_send }
}

const caller = { session: { id: CALLER_ID, header: { cwd: '/work', delegationDepth: 0 } }, options: {} }
const persistenceWith = (snapshot) => ({ async stat() { return snapshot } })
const coldSnapshot = { header: { id: TARGET_ID, cwd: '/other' }, formatStatus: 'current' }
const listed = {
  items: [
    { sessionId: TARGET_ID, updatedAt: 2000, cwd: '/other', running: false, projections: { values: { title: 'Release checklist' } } },
    { sessionId: '33333333-3333-4333-8333-333333333333', updatedAt: 1000, cwd: '/work', running: true, projections: { values: { title: 'Project notes' } } },
  ],
}

async function run(label, ctxOptions, args) {
  deliveries.length = 0
  flushes.length = 0
  const { tool } = makeCtx(ctxOptions)
  const result = await tool.execute(args, { agent: caller, signal: undefined })
  const delivery = deliveries[0]
  console.log(label, '→', JSON.stringify(result))
  if (delivery) {
    console.log('   how:', delivery.how, '| source:', JSON.stringify(delivery.message.source), '| flushed:', flushes.length)
  }
}

await run('list candidates', { list: listed }, { list: true })
await run('resolve by title substring', { list: listed, persistence: persistenceWith(coldSnapshot) }, { target: 'checklist', text: 'ping' })
await run('resolve "latest" skips caller', { list: listed, persistence: persistenceWith(coldSnapshot) }, { target: 'latest', text: 'ping' })
await run('ambiguous title', { list: { items: [
  { sessionId: TARGET_ID, updatedAt: 2, cwd: '/a', projections: { values: { title: '报告 A' } } },
  { sessionId: '44444444-4444-4444-8444-444444444444', updatedAt: 1, cwd: '/b', projections: { values: { title: '报告 B' } } },
] } }, { target: '报告', text: 'ping' })
await run('unknown title', { list: listed }, { target: '不存在', text: 'ping' })
await run('exact id (default steer)', { persistence: persistenceWith(coldSnapshot) }, { target_session_id: TARGET_ID, text: 'ping' })
await run('explicit queue', { persistence: persistenceWith(coldSnapshot) }, { target_session_id: TARGET_ID, text: 'ping', mode: 'queue' })
await run('missing target', { persistence: persistenceWith(coldSnapshot) }, { text: 'ping' })
await run('resolve writer-held', { persistence: persistenceWith(coldSnapshot), resolve: () => ({ error: { code: 'session/writer-held', message: 'held' } }) }, { target_session_id: TARGET_ID, text: 'ping' })
await run('flush false', { persistence: persistenceWith(coldSnapshot), flush: false }, { target_session_id: TARGET_ID, text: 'ping' })
await run('self send', { persistence: persistenceWith(coldSnapshot) }, { target_session_id: CALLER_ID, text: 'ping' })
