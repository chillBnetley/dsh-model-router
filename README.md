# dsh-model-router

Question-type-aware model routing for DeepSeek Harness.

Instead of one model answering everything, the router classifies each turn and
re-dispatches it to the model that fits — correctness first for research work,
free models first for small talk.

## Install

```sh
git clone https://github.com/<you>/dsh-model-router.git
cp -r dsh-model-router ~/.dsh/plugins/
```

Then list `dsh-model-router` in `dsh.profile.bundles` in your profile's
`cordis.patch.yml`. The plugin contributes its own `config:` block — see
[cordis.patch.yml](cordis.patch.yml) for the annotated defaults.

**Start with `dryRun: true`.** The router then only logs what it *would* pick and
changes nothing, so you can watch it against your own catalogue before letting it
move real traffic.

## How it decides

| Task kind | Objective |
| --- | --- |
| `coding`, `math_reasoning`, `learning_tutor`, `knowledge_qa`, `agentic_tools` | **quality-first**: the highest-rated model wins outright; price only breaks ties among equally-rated candidates |
| `daily_chat` | **efficiency-first**: any model clearing the score floor is acceptable, and among those the free ones win |
| `writing_literature`, `translation`, `long_context` | near-best (within `maxScoreDrop` of the top), then cheapest |

Hard rules, independent of the above:

- **Grok is barred from every turn that executes a task.** On the configured
  gateway it never receives tool schemas, so it may only serve the types listed
  under `grok.allowedTypes` (default: small talk) and never a turn carrying tool
  activity or an action request.
- **Unknown is not a guess.** A model with no capability record, or whose tool
  support is unknown on a tool-executing turn, is excluded; if nothing
  qualifies the request is routed to `fallback` — or left untouched when no
  fallback is configured and live.
- **Rate-limited routes cool down** instead of being retried every turn.
- **Auxiliary calls are never routed.** Session-title and compaction requests
  carry a `purpose` and keep the model the harness chose, because their output
  format is contractual. `respectPurpose: false` disables this.
- **Pinned models can be exempted.** `respectModels: ["provider/model"]` makes
  routing leave those requests alone — the escape hatch for a subagent whose
  model is pinned by `agentOptions`.

## Small-talk tone

`maxTokens` bounds small-talk length at the wire level, but tone needs a prompt.
The plugin contributes one system-prompt section (`model-router:chitchat-style`)
that renders **only** on small-talk turns; on every other turn it renders empty
and is dropped, so those prompts are byte-identical to one assembled without
this plugin.

Turn correlation is exact rather than bookkeeping: the assembly hook's `scope`
is the Agent, and an Agent exposes `.session`, so the latest genuine user
message is read straight off the session (plugin-authored context and tool
results are skipped — they are user-role messages too).

⚠️ A section that toggles turn to turn changes the system-prompt prefix, which
is what a prompt cache keys on. Set `chitchatStyle.enabled: false` if cache
reuse matters more than tone.

## Subagents and agent teams

Both keep working: the router swaps which model serves a stream and nothing
else. Spawning, the team task board, messaging, tool exposure and the
subagent/teammate model *selection* are all untouched.

Every `llm/stream` call is routed, including a child agent's own turns — so a
subagent doing code gets a coding model. A child's selection is inherited from
its parent (or pinned by `agentOptions`); use `respectModels` to protect a pin.


## Mechanism

It hooks the `llm/stream` waterfall — the seam the harness documents as where
provider/model routing is replaced — and returns a **new request envelope**.
The incoming request is never mutated: loop-built requests are deep-frozen and
their content is a pure function of the session log.

## Configuration

Everything lives in the profile's `cordis.patch.yml` under this plugin's
`config:`. See [cordis.patch.yml](cordis.patch.yml) for the annotated defaults.

Useful switches:

- `dryRun: true` — log what it *would* pick and change nothing. Do this first.
- `enabled: false` — leave every request exactly as the caller built it.
- `chunk` limits: `chitchatMaxTokens` bounds small-talk output at the wire level.

## 工作 / 闲聊 mode

A user-selected override steers the whole turn, independent of the task type:

- `work` (default) — the type-based policy above, unchanged.
- `chat` — free models first: **Space Bunny Free** is preferred, then the rest of
  the free pool; a genuinely hard question (not a tool-executing turn) may
  escalate to **Grok** for reasoning.

Mode is per-session. The composer's ⚡ 工作 / 闲聊 toggle (in the model-selector
row) writes it; `/mode` (or `/mode work|chat`) shows or sets it. Two sources
keep it reliable, in precedence order:

1. **`data/modes.json`** — the plugin's own map, written by `/mode` and read by
   the router on every turn. This is the source routing trusts, so a switch
   applies on the very next turn and survives a restart.
2. **`defaultMode`** — the value a session uses before it has ever been toggled.

Older versions also appended a `model-router/mode` session event. That write is
gone: a downstream event type outside the harness vocabulary must carry the
envelope's `ignorable` marker to be readable, and a live append cannot set it, so
the event made the session log unreadable after a restart. Existing logs that
still contain the event are read as a fallback and never written again.

`stateFile` overrides where that map lives (the tests point it at a temp file),
and `chat.preferred.id` names the free model chat mode prefers first.

The state file exists because reading the mode back out of the session log at
route time is not dependable: resolving the live session for a turn can miss, and
a miss is **silent** — the mode simply stays at its default even though the write
itself succeeded. Routing therefore never depends on that read.

## Reflecting the routed model

When the router picks a different model, it writes that pick back into the
session's durable model selection, so the composer's model seat **switches to the
model that actually served the turn** — you can see what answered you.
`reflectModel: false` disables this and leaves the selection untouched.

## Inspecting a decision

`/route` prints the last decision: the classified kind, its confidence, whether
tools were required, the mode in effect, what the caller asked for, what was
chosen, and why.

## Data

`data/capabilities.json` is the capability matrix the policy reads: per model,
nine task ratings with their source URL and confidence, price, modality, and
measured facts (reachability, tool calling, time-to-first-token) from live
probing. `tools/` holds the probes that produced it; `tools/validate-profile.mjs`
checks a profile's provider section against the adapter's own schema.

Capability confidence is uneven by nature: vendor benchmark figures are `high`,
tier inference anchored on metadata is `low`, and unverifiable ids are `unknown`.
`translation` is almost entirely unmeasured and should not be routed on.

The matrix is a snapshot and ages; the router warns at boot past
`maxMatrixAgeDays`. To re-measure it against **your own** gateways, copy
`gateways.local.json.example` to `gateways.local.json` and list the endpoints you
want probed:

```json
[{ "route": "my-gateway", "base": "https://api.example.com/v1", "keyEnv": "MY_GATEWAY_API_KEY" }]
```

`keyEnv` names a key in `~/.dsh/.credentials.yaml`, so no credential is ever
written into this repository. Then `node tools/probe-catalog.mjs` and rebuild with
`node tools/build-capabilities.mjs`.

## What is deliberately not in this repository

The router writes and reads state that identifies *your* usage, and probing needs
to know *which* services you pay for. None of it is tracked:

| File | What it holds |
| --- | --- |
| `data/modes.json` | session ID → work/chat |
| `data/diagnostics.log` | every routing decision, timestamped |
| `data/probe-*.json`, `data/research-*.json` | raw gateway responses and catalogue dumps |
| `gateways.local.json` | your gateway endpoints and the credential each one uses |

All are covered by `.gitignore` and are created on demand at runtime.

## Tests

```sh
node --test test/*.test.mjs
```

Roughly 100 tests: classifier behaviour, every policy rule above, and an
integration suite that mounts the real plugin into a real cordis context and
asserts actual dispatch decisions. Two `mode-e2e` cases covering restore-from-
session-log are currently red — they fail on the author's machine too and are
unrelated to routing.
