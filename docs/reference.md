# Reference

Every lens takes a plain object and returns typed decisions. Scores, probabilities,
confidence, and fallback reasons are available where relevant to the lens. They
support inspection and evaluation; none proves that a decision is correct.

## `Usher.admit` — J3

| option | default | meaning |
|---|---|---|
| `goal` | — | what the expensive model is trying to do |
| `candidates` | — | `{ id, text, tokens?, meta? }[]` |
| `budget` | `4000` | ceiling on admitted tokens |
| `threshold` | `1.5` | minimum score on the levels scale |
| `minConfidence` | `0.55` | below this, the score is not trusted |
| `failOpen` | `true` | unsure verdicts and provider failures let material through, subject to `budget` |
| `checkNeed` | `true` | also ask whether the goal needs context at all |
| `needThreshold` | `0.15` | turn everyone away below this need probability |
| `levels` | 3 defaults | override the relevance rubric |
| `batchSize` | `64` | maximum candidates per request; byte limits may split earlier |

Verdict reasons: `admitted` · `low-confidence-admitted` · `below-threshold` ·
`low-confidence-turned-away` · `over-budget` · `goal-needs-no-context` · `provider-error-admitted`

## `Router.route` — J1

| option | default | meaning |
|---|---|---|
| `turn` | — | the user's turn, verbatim |
| `context` | — | repo facts, open files, recent errors |
| `tiers` | `DEFAULT_TIERS` | `{ id, description, meta? }[]` — the description *is* the rubric |
| `fallback` | last tier | used when confidence is below the floor |
| `minConfidence` | `0.55` | |
| `probeWork` | `true` | also return `needsFiles` and `needsTools` |

`DEFAULT_TIERS`: `trivial` (haiku) · `mechanical` (sonnet) · `judgement` (opus) · `hard` (opus, high effort).
Replace the descriptions with your own boundary cases — that is where routing accuracy comes from.

## `Gate.select` — J2

| option | default | meaning |
|---|---|---|
| `turn` | — | |
| `catalog` | — | `{ id, name, summary, detail? }[]` |
| `maxSelected` | `1` | how many to surface |
| `shortlist` | `3` | how many stage two reads properly; `0` skips stage two |
| `minConfidence` | `0.55` | |
| `failOpen` | `false` | **fails closed** — unsure surfaces nothing |
| `checkNeed` | `true` | |
| `batchSize` | `96` | |

Reasons: `selected` · `none-needed` · `low-confidence` · `empty-catalog` · `provider-error`

## `Filter.apply` — J4

Everything `admit` takes, plus:

| option | default | meaning |
|---|---|---|
| `chunks` | — | tool output, split into pieces |
| `source` | — | `file` · `shell` · `web` · `mcp` · anything |
| `screen` | on for `web`/`mcp` | run J7 before judging relevance |
| `dropBlocked` | `true` | remove blocked chunks rather than passing them flagged |

## `Compactor.triage` — J5

| option | default | meaning |
|---|---|---|
| `goal` | — | what the session is still trying to accomplish |
| `blocks` | — | transcript blocks, oldest first |
| `keepBudget` | `8000` | soft ceiling for trusted verbatim blocks; overflow becomes `shorten` |
| `minConfidence` | `0.55` | |
| `failOpen` | `true` | unsure → keep verbatim, including over budget |
| `batchSize` | `48` | |

`retained` combines surviving blocks in original order. `keep`, `shortened`, and
`drop` are separate groups for inspection. `headChars` defaults to 300. Shortened
blocks carry updated token estimates; untouched blocks retain caller token counts.
`keepBudget` does not cap total returned context. Protect required instructions
and tool call/result pairs in your harness; this API handles plain text blocks.

## `StopGate.check` — J6

| option | default | meaning |
|---|---|---|
| `goal` | — | what the agent set out to do |
| `work` | — | what it has done so far |
| `nextAction` | — | sharpens the repetition check |
| `metThreshold` | `0.8` | |
| `loopThreshold` | `0.75` | |

Reasons: `goal-met` · `looping` · `needs-user` · `continue` · `unavailable`

## `Screen.check` — J7

| option | default | meaning |
|---|---|---|
| `items` | — | content to screen |
| `source` | — | where it came from |
| `blockThreshold` | `0.8` | |
| `reviewThreshold` | `0.45` | |
| `batchSize` | `32` | |

Verdicts: `pass` · `review` · `block` · `unavailable`

## Client

```ts
new JevUsher({
  apiKey,          // default: JEV_API_KEY, then TYPESAFE_API_KEY
  baseUrl,         // default https://api.typesafe.ai/v1
  model,           // default jev-1.13.0
  timeoutMs,       // default 30_000
  maxRetries,      // default 3 — retries selected transient statuses with backoff
  provider,        // swap the whole transport, e.g. a stub in tests
  prices,          // { jev: 0.042, target: 15 } for the ledger
});
```

## CLI

```bash
jev-usher install [--global]    wire the Claude Code hooks
jev-usher uninstall [--global]  remove only jev-usher hooks
jev-usher doctor                key, connectivity, store contents
jev-usher report                estimated selected volume and JEV usage
jev-usher ui [--port 4318]       local test UI on 127.0.0.1
jev-usher claude [--no-route] [--model MODEL] "prompt" [-- Claude options]

jev-usher hook <event>          user-prompt-submit | pre-tool-use | post-tool-use | stop
jev-usher route|admit|gate|screen|stop|compact    JSON in, JSON out
```

```bash
echo '{"goal":"g","candidates":[{"id":"a","text":"..."}]}' | node bin/jev-usher.mjs admit
echo '{"turn":"rename the getter"}' | node bin/jev-usher.mjs route
```

The examples above run from a built checkout. See [local UI](local-ui.md) and
[Claude Code setup](claude-code.md) for configuration and privacy boundaries.

The canonical package and command are `jev-usher`; the main TypeScript class is
`JevUsher`. The `jevusher` command and earlier `Jevusher`, `JevusherConfig`, and
`JevusherError` exports remain compatibility aliases. Existing `JEVUSHER_*`
environment variables and the `~/.claude/jevusher` storage directory retain
their names so saved recovery references continue to work.

## Optional decision cache

```ts
import { DecisionCache, JevClient, JevUsher } from "jev-usher";
const provider = new DecisionCache(new JevClient(), { maxEntries: 128, ttlMs: 60_000 });
const usher = new JevUsher({ provider });
```

The in-memory cache requires a pinned model such as `jev-1.13.0`. Its key hashes
the entire serialized request, including state, IDs, numbers, instructions,
criteria, and model. Reordering object keys can cause a miss; it never removes
fields or performs fuzzy matching. Scope each instance to one caller/tenant.
It expires decisions and evicts least-recently-used entries. Failed or malformed
responses are not cached. The instance retains decisions in memory, not raw state
or credentials in files. `clear()` removes entries; `stats()` exposes hits, misses,
evictions, and entry count. Hits report zero incremental provider usage.

This is opt-in for long-lived applications. It does not improve hit rate across
separate command-hook processes and does not coalesce simultaneous misses.
Ledger request counts are logical evaluations; use cache stats and provider
billing when distinguishing cache hits from actual requests. Replay verifies
application behavior; detecting model drift requires fresh model calls on a
fixed evaluation set.
