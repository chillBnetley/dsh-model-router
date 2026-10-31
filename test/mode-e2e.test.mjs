// End-to-end reproduction of the reported bug: switching to 闲聊 mode must change
// what actually gets dispatched. It mounts the REAL plugin, a REAL SessionStore
// and a REAL LlmRuntime, drives the /mode command the composer toggle sends, then
// routes a small-talk turn and asserts the model that reaches the adapter.
//
// The original failure was silent: the mode was written but never read, so both
// modes dispatched the same model. Asserting the DISPATCH (not the config) is what
// makes this test able to catch that class of bug.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

const HOME = process.env.USERPROFILE.replace(/\\/g, '/')
const NM = `${HOME}/.dsh/profiles/node_modules`
const { Context, Service } = await import(pathToFileURL(`${NM}/@deepseek-ai/cordis/lib/index.js`).href)
const { LlmRuntime, LlmAdapter } = await import(pathToFileURL(`${NM}/@deepseek-ai/dsh-llm/lib/index.js`).href)
const { SessionStore } = await import(pathToFileURL(`${NM}/@deepseek-ai/dsh-session/lib/index.js`).href)

/** Captures every slash command the plugin registers. */
const registrations = new Map()
class FakeCommands extends Service {
  constructor(ctx) { super(ctx, 'commands') }
  register(definition) {
    registrations.set(definition.name, definition)
    return () => registrations.delete(definition.name)
  }
}

/** Adapter exposing one model per provider, recording what it is asked to serve. */
const served = []
class Recorder extends LlmAdapter {
  providerInfo(p) { return { id: p, name: p } }
  async listModels(p) {
    return {
      custom: [{ provider: p, id: 'agnes-3.0-flash', name: 'agnes-3.0-flash' }],
      opencode: [{ provider: p, id: 'space-bunny-free', name: 'space-bunny-free' }],
      open: [{ provider: p, id: 'gpt-6.1-sol', name: 'gpt-6.1-sol' }],
      grok: [{ provider: p, id: 'grok-420-thinking', name: 'grok-420-thinking' }],
    }[p] ?? []
  }
  async resolveModel(p, m) { return { provider: p, id: m, name: m, context: { contextWindow: 1000000 } } }
  async *stream(options) {
    served.push(`${options.provider}/${options.model}`)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const BASE_CONFIG = {
  enabled: true,
  dryRun: false,
  fallback: { provider: 'deepseek-account', model: 'deepseek-flash' },
  research: { types: ['learning_tutor', 'coding', 'math_reasoning', 'knowledge_qa', 'agentic_tools'] },
  casual: { types: ['daily_chat'], minScore: 3, preferFree: true },
  balanced: { types: ['writing_literature', 'translation', 'long_context'], maxScoreDrop: 1 },
  grok: { enabled: true, allowedTypes: ['daily_chat'] },
  chat: { preferred: { id: 'space-bunny-free' } },
  defaultMode: 'work',
  reflectModel: true,
  chitchatMaxTokens: 700,
  respectModalities: true,
}

const text = t => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: t }] }]
const ask = (runtime, sessionId) =>
  runtime.stream({ provider: 'custom', model: 'agnes-3.0-flash', sessionId, messages: text('你好') })
async function drain(stream) { for await (const _ of stream) { /* consume */ } }

/** A state file per test, so no test can inherit another's toggles. */
const freshState = () => join(mkdtempSync(join(tmpdir(), 'router-modes-')), 'modes.json')

/**
 * Boot the whole seam: a live session, the slash-command registry, the plugin and
 * the LLM runtime. `seed` rehydrates a session as a restart would.
 */
async function boot({ stateFile = freshState(), sessionId, seed } = {}) {
  const ctx = new Context()
  await ctx.plugin(FakeCommands)
  await ctx.plugin(SessionStore)
  try { await ctx.plugin(LlmRuntime) } catch { /* resolved below */ }
  const runtime = ctx.get('llm') ?? new LlmRuntime(ctx)
  runtime.registerAdapter(['custom', 'opencode', 'open', 'grok'], new Recorder())
  apply(ctx, { ...BASE_CONFIG, stateFile })
  // The plugin reaches its services through inject callbacks, which cordis may
  // resolve on a later tick — give them one before driving the command.
  await new Promise(resolve => setTimeout(resolve, 10))
  const sessions = ctx.get('sessions')
  const session = sessionId === undefined
    ? sessions.create(`session-${Math.random().toString(36).slice(2)}`, { meta: { cwd: process.cwd() } })
    : sessions.create(sessionId, {
        meta: { cwd: process.cwd() },
        ...(seed === undefined ? {} : { seed: seed.map(e => ({ ...e, data: structuredClone(e.data) })) }),
      })
  return { ctx, runtime, session }
}

/** Drive the command exactly as the composer toggle does. */
function toggle(session, mode) {
  const command = registrations.get('mode')
  assert.ok(command, 'the plugin must register a /mode command')
  const result = command.handler({ agent: { session }, rawInput: mode })
  assert.equal(result.kind, 'success', `toggle failed: ${JSON.stringify(result)}`)
}

test('chat mode dispatches small talk to Space Bunny Free', async () => {
  const { runtime, session } = await boot()
  toggle(session, 'chat')
  served.length = 0
  await drain(ask(runtime, session.id))
  assert.deepEqual(served, ['opencode/space-bunny-free'],
    `chat mode must lead with Space Bunny Free, got ${JSON.stringify(served)}`)
})

test('work mode keeps the pre-existing free-pool choice for the same turn', async () => {
  const { runtime, session } = await boot()
  served.length = 0
  await drain(ask(runtime, session.id))
  assert.deepEqual(served, ['custom/agnes-3.0-flash'],
    `work mode must be unchanged, got ${JSON.stringify(served)}`)
})

test('the two modes genuinely diverge on the SAME turn', async () => {
  const work = await boot()
  served.length = 0
  await drain(ask(work.runtime, work.session.id))
  const workPick = served.at(-1)

  const chat = await boot()
  toggle(chat.session, 'chat')
  served.length = 0
  await drain(ask(chat.runtime, chat.session.id))
  const chatPick = served.at(-1)

  assert.notEqual(chatPick, workPick, `chat mode must change the dispatch: both served ${chatPick}`)
  assert.equal(chatPick, 'opencode/space-bunny-free')
})

test('toggling back to work restores the previous behaviour', async () => {
  const { runtime, session } = await boot()
  toggle(session, 'chat')
  toggle(session, 'work')
  served.length = 0
  await drain(ask(runtime, session.id))
  assert.deepEqual(served, ['custom/agnes-3.0-flash'])
})

test('the toggle is written where a restart can find it', async () => {
  const stateFile = freshState()
  const { session } = await boot({ stateFile })
  toggle(session, 'chat')
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(saved[session.id], 'chat', 'the toggle must write the durable state file')
  assert.equal(session.events.some(e => e.type === 'model-router/mode'), false,
    'the toggle must not append a non-ignorable session event')
})

test('a restart restores the mode from the plugin state file alone', async () => {
  const stateFile = freshState()
  const first = await boot({ stateFile })
  toggle(first.session, 'chat')

  const second = await boot({ stateFile, sessionId: first.session.id })
  served.length = 0
  await drain(ask(second.runtime, second.session.id))
  assert.deepEqual(served, ['opencode/space-bunny-free'],
    `the state file must restore the mode, got ${JSON.stringify(served)}`)
})

test('a session log from an older writer still restores the mode', async () => {
  const first = await boot()
  // Simulate an older version, which appended the event itself.
  first.session.append('model-router/mode', { mode: 'chat' })

  const second = await boot({ stateFile: freshState(), sessionId: first.session.id, seed: first.session.events })
  served.length = 0
  await drain(ask(second.runtime, second.session.id))
  assert.deepEqual(served, ['opencode/space-bunny-free'],
    `the legacy session event must still restore the mode, got ${JSON.stringify(served)}`)
})
