# Jevusher — the context doorman

*Product and GitHub name: **Jevusher** (Jev + usher).*
An usher does not decide the show; it decides who gets through the door and where they sit.
Dispatch decides what the agent **does**. Jevusher decides what the agent **reads**.

## Positioning Jev to cut Claude cost

## The economics

| | input $/Mtok | output $/Mtok |
|---|---|---|
| Opus | ~15 | ~75 |
| Sonnet | ~3 | ~15 |
| Haiku | ~1 | ~5 |
| **jev-1.13** | **0.042** | **free** |

- Jev input is ~**357x** cheaper than Opus, ~**71x** cheaper than Sonnet. Output tokens cost nothing.
- 64k context / request; state ingested **once**, all questions evaluated against it **in parallel** (batching ~12x cheaper + ~10x faster than one-question-per-call, per the parallel-questions cookbook).
- Latency is sub-LLM, so a Jev gate in front of a Claude call is effectively free in wall-clock too.

**Core principle: Jev reads, Claude decides.** Every token Jev reads is a token Claude never has to.
Jev sits *outside* the context window and governs what is allowed in.

## Where Jev goes in the pipeline

```
user turn
  │
  ├─[J1] intent + effort routing ──────────► deterministic code / haiku / sonnet / opus
  ├─[J2] skill + MCP tool gating ──────────► inject 1 skill line instead of 200 descriptions
  ├─[J3] memory recall rerank ─────────────► top-k observations, not the whole digest
  │
  ▼
Claude turn (small context)
  │
  ├─[J4] tool-result / file-chunk filter ──► drop noise before it lands in context
  ├─[J5] compaction survivor selection ────► score each block: keep / summarize / drop
  ├─[J6] stop-or-continue gate ────────────► kill loops that would cost whole turns
  └─[J7] guardrail + injection screen ─────► cheap safety on everything fetched
```

### J1 — Intent + model routing (biggest single lever)
One Choice question over the user turn + repo state: `trivial | mechanical | needs-taste | hard`.
Code maps that to haiku/sonnet/opus/fable and to reasoning effort. Most turns are not Opus turns.
Add a Noul: "can this be answered without reading any files?" — skips exploration entirely.
Docs: [intent routing](https://docs.typesafe.ai/patterns/intent-routing.md), [confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md)

### J2 — Skill / tool catalog gating
Today the skill list + MCP tool schemas are tens of thousands of tokens in **every** system prompt,
re-read on every turn. TypeSafe's own cookbook does exactly this: rank a 182-skill catalog in one
request, second pass reads the top 3 properly, winner goes into the prompt as **one line**.
Same pattern for MCP: keep tool schemas deferred, let Jev decide which handful to surface.
Docs: [skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)

### J3 — Memory recall (the memory-efficiency ask)
Current claude-mem flow injects a session-start digest and expands via `get_observations`.
Replace the heuristic with Jev:
1. Cheap recall (BM25/embedding/SQLite FTS) → 50–200 candidate observations.
2. **One** Jev request: state = the user turn; questions = one Score per candidate
   (`irrelevant | background | directly-needed`), plus a Noul "does this turn need memory at all?".
3. Code keeps only `directly-needed`, capped by a token budget. Low confidence → keep the title line only.
This is the re-ranking cookbook (top-1 accuracy 5%→18%, top-10 38%→62% on CLERC) applied to memory.
Net effect: memory recall becomes **precision-first** instead of recall-first — fewer tokens *and* better hits.
Docs: [re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), [line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find.md)

### J4 — Tool-result and file-chunk filtering
Grep hits, web pages, log dumps, `read_page` output: score each chunk for relevance to the live goal,
pass only what survives. Also catches prompt injection in fetched content for free.
Docs: [classifying RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md)

### J5 — Compaction survivor selection
Compaction today is an LLM rewrite of the full transcript — expensive, and lossy in unpredictable
ways: a path, an error string, or a number can vanish while the prose still reads fine. Measured on
a real session, the rewrite cost $0.0215 a go.

So do not rewrite. Jev labels each block `keep | shorten | drop`; code assembles the result from
the original text. A shortened block is cut to its opening with a marker naming what went. No
second model runs, and every surviving word is a word that was really written.

### J6 — Stop / continue gate
Noul: "has the stated goal been met by the work so far?" + "is this attempt repeating a failed one?"
An agent loop stopped one turn earlier saves a whole Opus turn — usually more than every other
optimization on this list combined.

### J7 — Guardrails
One request screening input and output for jailbreak / hazard / severity, replacing an LLM safety pass.
Docs: [LLM guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails.md)

## Rules of thumb

- **Batch.** Everything Jev needs to judge about one turn goes in **one** request with many questions,
  not N requests. Speculative questions are nearly free — ask them.
- **Confidence is the second axis.** High confidence → act in code. Low confidence → fall back to
  including the material (fail open), never to silent dropping.
- **Never let Jev write prose.** It returns typed judgments; code does the assembly. If you find
  yourself wanting generated text, that is a Claude job.
- **Measure in tokens-into-Claude, not in Jev calls.** Jev call cost is noise; the metric is
  context size per turn and turns per task.

## Suggested build order

1. **J3 memory rerank** — self-contained, no harness changes, immediate and measurable.
2. **J2 skill gating** — biggest constant-cost win; needs a hook that rewrites the injected catalog.
3. **J1 routing** — biggest variable-cost win; needs model-selection control per turn.
4. **J6 stop gate**, then J4/J5/J7.

## Measurement harness (do this first)

Log per turn: system-prompt tokens, memory-injected tokens, tool-result tokens, model used, turn count,
$ per completed task. Without the baseline none of the above is provable.

---

# Naming: Jevusher

**Product + GitHub org:** `jevusher`. **npm:** `jevusher` / `@jevusher/*`.

## Why it works

- **Says the job.** An usher controls the door and the seating. Jevusher controls what enters the
  context window and in what order. The one-line pitch writes itself: *the doorman for your
  context window.*
- **Stakes out the neglected half.** Dispatch decides what runs; admission decides what is read.
  The name says which one this is.
- **Carries the Jev prefix**, so it reads as part of the ecosystem without implying it is official
  TypeSafe software. Keep that distinction explicit in the README.
- Verbs fall out naturally for the API surface: `usher.admit()`, `usher.seat()`, `usher.turnAway()`.

## Availability (checked 2026-09-19)

| Namespace | Status |
|---|---|
| npm `jevusher` | free (404) |
| npm `@jevusher/core` scope | free (404) |
| GitHub user/org `jevusher` | free (404) |
| PyPI `jevusher` | free (404) |
| jevusher.com / .dev / .ai / .co | no A record |

No A record is **not** proof a domain is unregistered — it may be registered and parked.
Confirm at a registrar before announcing. Grab the npm scope and GitHub org first; those are the
ones that get sniped.

## Naming caveat

"Jev" is TypeSafe's model name, not yours. Before putting the name on anything public, check
TypeSafe's trademark/branding policy in their [legal page](https://docs.typesafe.ai/legal.md) and
state plainly in the README that Jevusher is an independent project that *uses* Jev. The README
already carries that note.
