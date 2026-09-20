# Reference

Every lens takes a plain object and returns typed verdicts with the score, the confidence, and the
reason — so you can log and tune rather than trust.

## `Usher.admit` — J3

| option | default | meaning |
|---|---|---|
| `goal` | — | what the expensive model is trying to do |
| `candidates` | — | `{ id, text, tokens?, meta? }[]` |
| `budget` | `4000` | ceiling on admitted tokens |
| `threshold` | `1.5` | minimum score on the levels scale |
| `minConfidence` | `0.55` | below this, the score is not trusted |
| `failOpen` | `true` | unsure verdicts and provider failures let material through |
| `checkNeed` | `true` | also ask whether the goal needs context at all |
| `needThreshold` | `0.15` | turn everyone away below this need probability |
| `levels` | 3 defaults | override the relevance rubric |
| `batchSize` | `64` | candidates per request |

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
| `keepBudget` | `8000` | ceiling for blocks kept verbatim; overflow becomes `summarize` |
| `minConfidence` | `0.55` | |
| `failOpen` | `true` | unsure → `summarize`, **never** `drop` |
| `batchSize` | `48` | |

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
new Jevusher({
  apiKey,          // default: JEV_API_KEY, then TYPESAFE_API_KEY
  baseUrl,         // default https://api.typesafe.ai/v1
  model,           // default jev-latest
  timeoutMs,       // default 30_000
  maxRetries,      // default 3 — retries 429 and 5xx with backoff
  provider,        // swap the whole transport, e.g. a stub in tests
  prices,          // { jev: 0.042, target: 15 } for the ledger
});
```

## CLI

```bash
jevusher install [--global]    wire the Claude Code hooks
jevusher doctor                key, connectivity, store contents
jevusher report                what the lenses have saved

jevusher hook <event>          user-prompt-submit | post-tool-use | stop
jevusher route|admit|gate|screen|stop|compact    JSON in, JSON out
```

```bash
echo '{"goal":"g","candidates":[{"id":"a","text":"..."}]}' | npx jevusher admit
echo '{"turn":"rename the getter"}' | npx jevusher route
```
