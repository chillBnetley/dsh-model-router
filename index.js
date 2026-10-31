/**
 * Question-type-aware model routing for DeepSeek Harness.
 *
 * The router sits on the `llm/stream` waterfall — the seam the harness itself
 * documents as the place provider/model routing is replaced — and re-dispatches
 * a request to the model its classifier and policy pick. It never mutates the
 * incoming request: loop-built requests are deep-frozen and their content is a
 * pure function of the session log, so a new envelope is built instead.
 *
 * If no candidate qualifies, the request is left exactly as it was rather than
 * guessed at, unless a fallback route is configured and live.
 *
 * @module dsh-model-router
 */
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { classify, estimateTokens } from './lib/classify.mjs'
import { decide, makeCooldowns, isRateLimitFailure, isFree, isRetired } from './lib/policy.mjs'
import { installChitchatStyle, STYLE_SECTION } from './lib/chitchat-style.mjs'
import { MODE_EVENT, modeOf, sessionEvents } from './lib/session-events.mjs'

/**
 * Diagnostic sink. The harness does not persist plugin logs, so this is the only
 * way to prove from outside whether the bundle loaded and what it decided.
 * Appends must never be able to break a turn.
 */
const DIAGNOSTICS = new URL('./data/diagnostics.log', import.meta.url)
function note(line) {
  try { appendFileSync(DIAGNOSTICS, `${new Date().toISOString()} ${line}\n`) } catch { /* never fatal */ }
}

/** Logging must never be able to abort a plugin's boot. */
function log(ctx, level, ...args) {
  try { ctx?.logger?.[level]?.(...args) } catch { /* never fatal */ }
}

export const name = 'dsh-model-router'

/** Wait for the LLM and system-prompt services; without the former there is
 * nothing to route, and the latter is what tone control registers against. */
export const inject = ['llm', 'systemPrompt']

/** How long a live candidate list is reused before re-enumerating. */
const CANDIDATE_TTL_MS = 60_000

/**
 * The plugin's own durable copy of the per-session mode.
 *
 * The state file is the source the router trusts: resolving the live session at
 * route time can silently miss, which is exactly how the first cut of this
 * feature ended up never leaving `work` while its diagnostics still looked
 * healthy. The /mode command no longer appends a `model-router/mode` session
 * event: a downstream event type outside the harness vocabulary must carry the
 * envelope's `ignorable` marker to be readable, and a live append cannot set
 * that marker, so such an event made the whole session log unreadable after a
 * restart.
 */
const MODES_FILE = new URL('./data/modes.json', import.meta.url)

/** Where the mode map lives: `stateFile` (tests) or the plugin's own data dir. */
function modesStorePath(config) {
  const custom = config?.stateFile
  return typeof custom === 'string' && custom.length > 0 ? custom : MODES_FILE
}

/** Load the persisted mode map; a missing or corrupt file yields an empty one. */
function loadModes(path) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    return new Map(Object.entries(doc).filter(([, mode]) => mode === 'chat' || mode === 'work'))
  } catch {
    return new Map()
  }
}

/** Persist the mode map. Failure is never fatal: the live map still applies. */
function saveModes(path, modes) {
  try { writeFileSync(path, JSON.stringify(Object.fromEntries(modes), null, 2)) } catch { /* never fatal */ }
}

/**
 * Read the bundled capability matrix, with lifecycle merged in.
 *
 * The lifecycle file is separate on purpose: retirement is a human judgement
 * recorded against a note in the matrix, not something derivable from it, and
 * merging it here keeps `isRetired` a one-field check inside the policy.
 *
 * @returns `{ index, generated }`, or `{ error }` when the matrix is unreadable.
 */
function loadCapabilities() {
  try {
    const raw = readFileSync(new URL('./data/capabilities.json', import.meta.url), 'utf8')
    const doc = JSON.parse(raw)
    let lifecycle = {}
    try {
      lifecycle = JSON.parse(readFileSync(new URL('./data/lifecycle.json', import.meta.url), 'utf8')).models ?? {}
    } catch (error) {
      // Degrades to "nothing is retired", which is the pre-existing behaviour
      // rather than a routing failure.
      note(`LIFECYCLE MISSING ${error?.message ?? error}`)
    }
    const index = new Map()
    for (const model of doc.models ?? []) {
      const status = lifecycle[model.id]
      index.set(model.id, status ? { ...model, lifecycle: status } : model)
    }
    return { index, generated: doc.generated ?? null, retired: Object.keys(lifecycle).length }
  } catch (error) {
    return { error }
  }
}

/**
 * Rolling record of what routing actually did.
 *
 * The plugin claims quality-first for research and free-first for small talk,
 * and never measured whether either was true. One number here matters most:
 * `lowConfidence` — the share of turns decided on a `low`-evidence signal or a
 * keyword guess, which is the honest measure of how much of the routing is a bet.
 */
function createTelemetry() {
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
  return {
    total: 0,
    byType: new Map(),
    byModel: new Map(),
    byKind: new Map(),
    fallback: 0,
    kept: 0,
    lowConfidence: 0,
    unverified: 0,
    record(verdict, outcome) {
      this.total += 1
      bump(this.byType, verdict.type)
      bump(this.byKind, outcome.kind)
      if (outcome.pick) bump(this.byModel, `${outcome.pick.provider}/${outcome.pick.id}`)
      if (outcome.kind === 'unknown-fallback') this.fallback += 1
      if (verdict.confidence === 'low') this.lowConfidence += 1
      // A pick we have never successfully called is the other half of "a bet".
      if (outcome.pick && outcome.pick.cap?.measured?.reachable !== true) this.unverified += 1
    },
    summary() {
      const pct = n => (this.total === 0 ? '0%' : `${Math.round((n / this.total) * 100)}%`)
      const top = map => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([k, v]) => `${k} ${v}`).join(', ') || '(none)'
      return [
        `decisions      : ${this.total}`,
        `kept original  : ${this.kept} (${pct(this.kept)})`,
        `fell back      : ${this.fallback} (${pct(this.fallback)})`,
        `LOW confidence : ${this.lowConfidence} (${pct(this.lowConfidence)}) — decided on a keyword guess`,
        `never probed   : ${this.unverified} (${pct(this.unverified)}) — routed to a model this deployment never called`,
        `by type        : ${top(this.byType)}`,
        `by model       : ${top(this.byModel)}`,
        `by decision    : ${top(this.byKind)}`,
      ].join('\n')
    },
  }
}

/** Validate the config once so a bad value fails loudly at mount, not per turn. */
export function resolveConfig(config = {}) {
  const enabled = config.enabled !== false
  const dryRun = config.dryRun === true
  const cap = config.chitchatMaxTokens
  if (cap !== undefined && cap !== null && (!Number.isSafeInteger(cap) || cap <= 0)) {
    throw new Error('dsh-model-router: chitchatMaxTokens must be a positive integer or null')
  }
  const fallback = config.fallback
  if (fallback !== undefined
    && (typeof fallback?.provider !== 'string' || typeof fallback?.model !== 'string')) {
    throw new Error('dsh-model-router: fallback must name both provider and model')
  }
  if (config.respectModels !== undefined && !Array.isArray(config.respectModels)) {
    throw new Error('dsh-model-router: respectModels must be an array of "provider/model" strings')
  }
  const defaultMode = config.defaultMode ?? 'work'
  if (defaultMode !== 'work' && defaultMode !== 'chat') {
    throw new Error('dsh-model-router: defaultMode must be "work" or "chat"')
  }
  // A mis-typed numeric knob would otherwise be silently ignored at decision
  // time — `Number.isFinite("0.5")` is false, so the default would win and the
  // configuration would appear to do nothing. Failing at mount makes that loud.
  const numeric = { preferBonus: [0, 5], reasoningBonus: [0, 5], contextHeadroom: [1, 4], maxMatrixAgeDays: [1, 3650] }
  for (const [key, [min, max]] of Object.entries(numeric)) {
    const value = config[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`dsh-model-router: ${key} must be a number between ${min} and ${max}`)
    }
  }
  for (const bucket of ['research', 'casual', 'balanced']) {
    const floor = config[bucket]?.minScore
    if (floor === undefined || floor === null) continue
    if (typeof floor !== 'number' || !Number.isFinite(floor)) {
      throw new Error(`dsh-model-router: ${bucket}.minScore must be a number or null`)
    }
  }
  return {
    ...config,
    enabled,
    dryRun,
    chitchatMaxTokens: cap ?? null,
    defaultMode,
    reflectModel: config.reflectModel !== false,
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  note(`BOOT enabled=${config.enabled} dryRun=${config.dryRun} fallback=${config.fallback?.provider ?? '-'}/${config.fallback?.model ?? '-'}`)
  if (!config.enabled) {
    ctx.logger.info('[model-router] disabled by config; leaving requests untouched')
    return
  }

  const loaded = loadCapabilities()
  const degraded = loaded instanceof Map ? null : loaded.error
  const index = loaded instanceof Map ? loaded : loaded.index
  const matrixGenerated = loaded instanceof Map ? null : loaded.generated
  note(`CAPABILITIES ${degraded ? 'FAILED ' + degraded.message : `${index.size} records, ${loaded.retired} retired`}`)

  // A capability matrix is a snapshot of a market that moves weekly, and nothing
  // here notices when it goes stale — the route simply keeps answering decisions
  // from last month's understanding of which models exist.
  const maxMatrixAgeDays = config.maxMatrixAgeDays ?? 45
  const matrixAgeDays = matrixGenerated
    ? Math.floor((Date.now() - Date.parse(`${matrixGenerated}T00:00:00Z`)) / 86_400_000)
    : null
  const matrixStale = matrixAgeDays !== null && matrixAgeDays > maxMatrixAgeDays
  if (matrixStale) {
    note(`MATRIX STALE age=${matrixAgeDays}d limit=${maxMatrixAgeDays}d (rebuild with tools/build-capabilities.mjs + tools/probe-catalog.mjs)`)
    log(ctx, 'warn',
      '[model-router] capability matrix is %s days old (limit %s); re-run tools/build-capabilities.mjs and tools/probe-catalog.mjs',
      matrixAgeDays, maxMatrixAgeDays)
  }

  const cooldowns = makeCooldowns({
    ttlMs: config.cooldownMs ?? 120_000,
    providerTtlMs: config.providerCooldownMs ?? 60_000,
    maxTtlMs: config.maxCooldownMs ?? 600_000,
  })
  // The system prompt and the tool schemas are not in `messages`, yet on an agentic
  // turn they are typically larger than the conversation. They are identical for
  // every candidate in a turn, so they cannot change the ranking — they only
  // decide absolute feasibility, which is exactly what the context gate is for.
  const promptOverhead = config.promptOverheadTokens ?? 8_000
  const stats = createTelemetry()
  const routed = new WeakSet()
  let candidates = []
  let enumeratedAt = 0
  let last = null

  // ---- 工作 / 闲聊 mode resolution ----
  // Three sources, each covering the others' failure mode:
  //  * `modeBySession` — the trusted live map the /mode command writes and the
  //    router reads first, so a toggle takes effect on the very next turn;
  //  * `data/modes.json` — the same map persisted, so a toggle survives a restart
  //    without depending on a session lookup at route time;
  //  * legacy `model-router/mode` session events from older versions are still
  //    read as a fallback; they are never written again (see MODES_FILE).
  const modesPath = modesStorePath(config)
  const modeBySession = loadModes(modesPath)
  const services = { sessions: null, agents: null }
  const modeLogged = new Set()

  /**
   * Reach a service by name, tolerating both resolution styles.
   *
   * The inject callbacks above populate `services`, but cordis may run them after
   * apply() returns, and a service can also be reachable straight off this
   * context. `ctx.get(name)` returns undefined for an absent service rather than
   * throwing, so it is safe to call on every turn.
   */
  function reach(name) {
    const injected = services[name]
    if (injected !== null && injected !== undefined) return injected
    try { return ctx.get(name) ?? null } catch { return null }
  }

  /** Find a live session through whichever service this composition exposes. */
  function lookupSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    for (const service of [reach('sessions'), reach('agents')]) {
      try {
        const found = service?.get?.(sessionId)
        if (found === undefined || found === null) continue
        // `sessions.get(id)` yields the Session; `agents.get(id)` yields the Agent.
        return found.session ?? found
      } catch { /* try the next service */ }
    }
    return undefined
  }

  /**
   * The mode in force for one turn: the live map first, then the session event,
   * then the configured default. The session-log result is used but NOT persisted
   * — only an explicit /mode choice is written to the durable map, so a bad read
   * can never become sticky.
   */
  function currentMode(sessionId) {
    const cached = typeof sessionId === 'string' ? modeBySession.get(sessionId) : undefined
    if (cached === 'chat' || cached === 'work') return cached
    const session = lookupSession(sessionId)
    const mode = modeOf(session, config.defaultMode)
    if (typeof sessionId === 'string' && !modeLogged.has(sessionId)) {
      modeLogged.add(sessionId)
      note(`MODE READ session=${sessionId} sessions=${reach('sessions') ? 'ok' : 'NULL'} agents=${reach('agents') ? 'ok' : 'NULL'} found=${session === undefined ? 'no' : 'yes'} events=${sessionEvents(session).length} mode=${mode}`)
    }
    return mode
  }

  /** Enumerate the live routes the harness can actually dispatch to. */
  async function refresh(force = false) {
    if (!force && Date.now() - enumeratedAt < CANDIDATE_TTL_MS && candidates.length > 0) return
    const out = []
    for (const provider of ctx.llm.listProviders()) {
      let models = []
      try { models = await ctx.llm.listModels(provider.id) } catch { models = [] }
      for (const model of models) out.push({ provider: provider.id, id: model.id, name: model.name })
    }
    candidates = out
    enumeratedAt = Date.now()
  }

  /** Whether a target advertises one reasoning effort, via the adapter's own metadata. */
  const effortCache = new Map()
  async function targetSupportsEffort(provider, model, effort) {
    const key = `${provider}/${model}`
    let efforts = effortCache.get(key)
    if (efforts === undefined) {
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model)
        efforts = (info?.reasoning?.efforts ?? []).map(e => e.id)
      } catch {
        efforts = null // unknown → treated as unsupported, so the effort is dropped
      }
      effortCache.set(key, efforts)
    }
    return Array.isArray(efforts) ? efforts.includes(effort) : false
  }

  /**
   * Live context windows, one `provider/model` -> number lookup each.
   *
   * `resolveModelInfo` is async and is the provider's own answer, which is the only
   * authoritative one: gateway `/models` endpoints routinely omit `context_length`
   * or report the family's maximum rather than the ceiling of the deployment
   * serving the request. Resolving all candidates keeps `decide` synchronous and
   * dependency-free — the policy only ever reads a number out of this map — and
   * the cache means it costs one round of lookups per provider/model, not per turn.
   *
   * A throw is normal here, not exceptional: a self-hosted `baseURL` may not be a
   * provider this build recognises at all. That resolves to `null`, which the
   * policy treats as unknown rather than as a window.
   */
  const windowCache = new Map()
  async function contextWindowsFor(list) {
    const out = new Map()
    await Promise.all(list.map(async candidate => {
      const key = `${candidate.provider}/${candidate.id}`
      if (windowCache.has(key)) { out.set(key, windowCache.get(key)); return }
      let resolved = null
      try {
        const info = await ctx.llm.resolveModelInfo(candidate.provider, candidate.id)
        const window = info?.context?.contextWindow
        if (typeof window === 'number' && Number.isFinite(window) && window > 0) resolved = window
      } catch { resolved = null }
      windowCache.set(key, resolved)
      out.set(key, resolved)
    }))
    return out
  }

  /**
   * Prompt size, preferring the harness's own meter.
   *
   * `tokenMeter` is fetched per call rather than captured at mount: it is NOT in
   * this plugin's `inject`, on purpose. Declaring it there would make cordis wait
   * for a service another profile may not install, and the router would then never
   * load at all — a missing optional dependency must not take the plugin down.
   * `ctx.get` returns undefined for an absent service instead of throwing.
   */
  function promptTokensFor(messages) {
    let meter = null
    try { meter = ctx.get('tokenMeter') ?? null } catch { meter = null }
    if (typeof meter?.estimateMessage === 'function') {
      let total = 0
      for (const message of messages) total += meter.estimateMessage(message)
      return total + promptOverhead
    }
    return estimateTokens(messages, promptOverhead)
  }

  ctx.on('llm/stream', (options, next) => route(options, next), { global: true, prepend: true })
  note('LISTENER registered')

  // ---- optional subsystems, each contained ----
  // The router's core is registered above. Tone control and the introspection
  // command are enhancements: if either throws at boot it must not take routing
  // down with it, which is exactly what an uncontained registration would do.
  let styleDisposer
  try {
    styleDisposer = installChitchatStyle(ctx, config)
    note(`STYLE ${styleDisposer === undefined ? 'unavailable (no systemPrompt service)' : 'registered'}`)
  } catch (error) {
    note(`STYLE FAILED ${error?.message ?? error}`)
  }
  try {
    ctx.effect(() => styleDisposer ?? (() => {}), 'model-router chitchat style')
  } catch (error) {
    note(`EFFECT FAILED ${error?.message ?? error}`)
  }
  try {
    ctx.inject(['commands'], commandCtx => {
      commandCtx.commands.register({
        name: 'route',
        description: 'Show the last routing decision, the candidate pool, and any active cooldowns',
        handler: () => {
          if (last === null) return { kind: 'success', text: 'model-router: no routing decision yet this session.' }
          const lines = [
            `question type : ${last.type} (${last.confidence} confidence, ${last.difficulty})`,
            `needs tools   : ${last.needsTools}`,
            `mode          : ${last.mode ?? 'work'}`,
            `requested     : ${last.requested}`,
            `chosen        : ${last.chosen ?? '(kept)'}`,
            `decision      : ${last.kind}`,
            `reason        : ${last.reason}`,
            `prompt tokens : ~${last.promptTokens ?? 0} estimated`,
            `candidates    : ${candidates.length} live route/model pairs`,
            `cooldowns     : ${cooldowns.size()} active`,
            `matrix        : generated ${matrixGenerated ?? 'unknown'}`
              + ` (${matrixAgeDays ?? '?'}d old)${matrixStale ? ' — STALE, rebuild required' : ''}`
              + `, ${loaded.retired ?? 0} retired`,
            `routing so far: ${stats.total} decisions this session`,
          ]
          return { kind: 'success', text: lines.join('\n') }
        },
      })
      commandCtx.commands.register({
        name: 'route-stats',
        description: 'Aggregate routing behaviour: share of turns decided on a guess, on an unprobed model, or falling back',
        handler: () => {
          if (stats.total === 0) return { kind: 'success', text: 'model-router: no routing decisions recorded yet.' }
          return { kind: 'success', text: `model-router routing stats\n${stats.summary()}` }
        },
      })
      commandCtx.commands.register({
        name: 'mode',
        description: 'Set model-router mode: work (unchanged) or chat (free models first)',
        input: { hint: '<work|chat>' },
        handler: ({ agent, rawInput }) => {
          const sessionId = agent?.session?.id
          const mode = String(rawInput ?? '').trim().toLowerCase()
          if (mode === '') {
            return { kind: 'success', text: `model-router mode: ${currentMode(sessionId)}` }
          }
          if (mode !== 'work' && mode !== 'chat') {
            return { kind: 'error', text: `unknown mode "${mode}" (use work or chat)` }
          }
          // The live map is what routing reads, and the file makes it survive a
          // restart; nothing else has to be recorded.
          if (typeof sessionId === 'string') { modeBySession.set(sessionId, mode); saveModes(modesPath, modeBySession) }
          // Do NOT append a custom session event here: the read path refuses a
          // log containing an unknown event type unless the envelope carries
          // `ignorable`, and a live append cannot set that marker, so the event
          // would make the session unreadable after a restart.
          note(`MODE set ${mode} session=${sessionId ?? '-'} cached=true`)
          return { kind: 'success', text: `model-router mode: ${mode}` }
        },
      })
      note('COMMANDS registered')
    })
  } catch (error) {
    note(`COMMANDS FAILED ${error?.message ?? error}`)
  }
  // The session/agent services are resolved through inject callbacks, which
  // cordis may run AFTER apply() returns — so the diagnostic belongs INSIDE the
  // callback. An outside-the-callback note only proves the request was made.
  try {
    ctx.inject(['sessions'], (scope) => {
      services.sessions = scope.sessions ?? scope.get('sessions') ?? null
      note(`SESSIONS inject fired: ${services.sessions ? 'resolved' : 'MISS'}`)
    })
    note('SESSIONS inject scheduled')
  } catch (error) {
    note(`SESSIONS FAILED ${error?.message ?? error}`)
  }
  try {
    ctx.inject(['agents'], (scope) => {
      services.agents = scope.agents ?? scope.get('agents') ?? null
      note(`AGENTS inject fired: ${services.agents ? 'resolved' : 'MISS'}`)
    })
  } catch (error) {
    note(`AGENTS FAILED ${error?.message ?? error}`)
  }
  try {
    // Keep the pool honest when plugins add or remove routes.
    ctx.on('llm/adapters-updated', () => { enumeratedAt = 0 }, { global: true })
  } catch (error) {
    note(`TOPOLOGY HOOK FAILED ${error?.message ?? error}`)
  }

  try {
    ctx.effect(() => () => cooldowns.clear(), 'model-router lifecycle')
  } catch (error) {
    note(`LIFECYCLE HOOK FAILED ${error?.message ?? error}`)
  }
  note('READY')
  log(ctx, 'info', '[model-router] ready — %s capability records, fallback %s/%s%s',
    index.size,
    config.fallback?.provider ?? '(none)', config.fallback?.model ?? '',
    config.dryRun ? ', DRY RUN' : '', matrixStale ? `, MATRIX STALE (${matrixAgeDays}d)` : '')

  /** The waterfall body. Must return an AsyncIterable synchronously. */
  function route(options, next) {
    note(`ROUTE ${options.provider}/${options.model} purpose=${options.purpose ?? '-'} frozen=${Object.isFrozen(options)}`)
    if (routed.has(options)) return next()
    // Auxiliary calls carry a purpose (session title, compaction). Their output
    // format is contractual, so they keep the model the harness chose for them.
    if (config.respectPurpose !== false && options.purpose !== undefined) {
      note(`SKIP purpose=${options.purpose} ${options.provider}/${options.model}`)
      return next()
    }
    // Escape hatch for a model pinned by configuration — a subagent's
    // agentOptions, say — which routing must not silently override.
    if ((config.respectModels ?? []).includes(`${options.provider}/${options.model}`)) {
      note(`SKIP respectModels ${options.provider}/${options.model}`)
      return next()
    }
    return (async function* routedStream() {
      let verdict
      try {
        await refresh()
        const verdictOf = classify({ messages: options.messages })
        // The context gate needs a size; the fallback estimator is incremental, so
        // a tool loop pays only for messages appended since the last turn.
        verdictOf.promptTokens = promptTokensFor(options.messages)
        const contextWindows = await contextWindowsFor(candidates)
        verdict = verdictOf
        const mode = currentMode(options.sessionId)
        const outcome = decide({
          candidates,
          index,
          classification: verdictOf,
          config: mode === 'chat' ? { ...config, mode } : config,
          cooldowns,
          now: Date.now(),
          contextWindows,
        })
        const pick = outcome.pick
        last = {
          at: new Date().toISOString(),
          sessionId: options.sessionId ?? null,
          type: verdictOf.type,
          confidence: verdictOf.confidence,
          difficulty: verdictOf.difficulty,
          needsTools: verdictOf.needsTools,
          mode,
          requested: `${options.provider}/${options.model}`,
          chosen: pick ? `${pick.provider}/${pick.id}` : null,
          reason: outcome.reason,
          kind: outcome.kind,
          promptTokens: verdictOf.promptTokens ?? 0,
          cooldowns: cooldowns.size(),
        }
        note(`DECIDE type=${verdictOf.type} conf=${verdictOf.confidence} tools=${verdictOf.needsTools} mode=${mode} cands=${candidates.length} from=${options.provider}/${options.model} to=${last.chosen ?? '(none)'} kind=${outcome.kind} — ${outcome.reason}`)
        stats.record(verdictOf, outcome)

        if (!pick) {
          stats.kept += 1
          ctx.logger.info('[model-router] %s -> keep %s/%s (%s)', verdictOf.type, options.provider, options.model, outcome.reason)
          yield* next()
          return
        }
        const same = pick.provider === options.provider && pick.id === options.model
        if (same) {
          stats.kept += 1
          ctx.logger.info('[model-router] %s -> keep %s/%s (%s)', verdictOf.type, options.provider, options.model, outcome.reason)
          yield* next()
          return
        }
        if (config.dryRun) {
          stats.kept += 1
          ctx.logger.info('[model-router] DRY RUN %s: would use %s/%s instead of %s/%s — %s',
            verdictOf.type, pick.provider, pick.id, options.provider, options.model, outcome.reason)
          yield* next()
          return
        }

        ctx.logger.info('[model-router] %s (%s, %s) %s/%s -> %s/%s — %s',
          verdictOf.type, verdictOf.confidence, verdictOf.difficulty,
          options.provider, options.model, pick.provider, pick.id, outcome.reason)

        const envelope = { ...options, provider: pick.provider, model: pick.id }
        // The session's reasoning effort was chosen for the session's own model.
        // The target may not speak that effort, and the harness rejects it hard,
        // so remap it against the target's own advertised efforts before dispatch.
        if (envelope.reasoningEffort !== undefined) {
          const supported = await targetSupportsEffort(pick.provider, pick.id, envelope.reasoningEffort)
          if (!supported) {
            note(`DROP effort=${envelope.reasoningEffort} for ${pick.provider}/${pick.id} (unsupported)`)
            delete envelope.reasoningEffort
          }
        }
        if (config.chitchatMaxTokens && config.casual?.types?.includes(verdictOf.type)) {
          const capped = Math.min(config.chitchatMaxTokens, options.maxTokens ?? config.chitchatMaxTokens)
          if (capped !== options.maxTokens) envelope.maxTokens = capped
        }
        // Reflect the routed model back into the session's durable model
        // selection so the composer's model seat switches to it (req 1) and the
        // user can see what actually served the turn. Never fatal to the stream.
        if (config.reflectModel && options.sessionId) {
          const session = lookupSession(options.sessionId)
          if (session === undefined) {
            note(`REFLECT SKIPPED ${pick.provider}/${pick.id}: session ${options.sessionId} not resolvable (sessions=${reach('sessions') ? 'ok' : 'NULL'} agents=${reach('agents') ? 'ok' : 'NULL'})`)
          } else {
            try {
              session.append('model/selection', {
                provider: pick.provider,
                model: pick.id,
                ...(envelope.reasoningEffort !== undefined ? { reasoningEffort: String(envelope.reasoningEffort) } : {}),
              })
              note(`REFLECT ${pick.provider}/${pick.id} -> session ${options.sessionId}`)
            } catch (error) {
              note(`REFLECT FAILED ${error?.message ?? error}`)
            }
          }
        }
        routed.add(envelope)
        yield* observe(ctx.llm.stream(envelope), pick)
      } catch (error) {
        // A router fault must never break the conversation: fall back to the
        // request exactly as the caller built it.
        note(`ERROR ${error?.message ?? error}`)
        log(ctx, 'warn', '[model-router] routing failed (%s); using the original request', error?.message ?? error)
        yield* next()
      }
    })()
  }

  /** Watch the routed stream so a rate-limited route costs one turn, not many. */
  async function* observe(stream, pick) {
    const key = `${pick.provider}/${pick.id}`
    for await (const chunk of stream) {
      if (chunk?.type === 'finish' && chunk.reason?.failure) {
        const kind = isRateLimitFailure(chunk.reason.failure)
        if (kind !== false) {
          // The provider is what is actually limited: five free models sharing one
          // gateway key each holding only a model-scoped cooldown just took turns
          // hitting the same wall. The provider-level streak is what makes the
          // window grow while a throttle persists — but only for a real rate
          // limit. An exhausted quota resets on a schedule, so escalating it walks
          // the gateway out of service for the rest of the day.
          const until = cooldowns.mark(key, pick.provider, Date.now(), kind)
          const state = cooldowns.entries().providers.get(pick.provider)
          note(`COOLDOWN ${key} provider=${pick.provider} kind=${kind} streak=${state?.streak ?? 0} until=${new Date(until).toISOString()}`)
          log(ctx, 'warn', '[model-router] %s is %s (provider streak %s); cooling down until %s',
            key, kind === 'exhausted' ? 'out of credit' : kind === 'quota' ? 'out of quota' : 'rate-limited',
            state?.streak ?? 0, new Date(until).toISOString())
        }
      } else if (chunk?.type === 'finish' && !chunk.reason?.failure) {
        // A turn that completed proves the provider is serving again.
        cooldowns.succeed(key)
      }
      yield chunk
    }
  }
}

export { classify } from './lib/classify.mjs'
export { decide, isFree } from './lib/policy.mjs'
