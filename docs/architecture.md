# Jevusher — the context doorman

*Working title for the product and GitHub org: **Jevusher** (Jev + usher).*
An usher does not decide the show; it decides who gets through the door and where they sit.
That is exactly the role: **JevRouter decides what the agent does, Jevusher decides what the agent reads.**

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
Compaction today is an LLM summarization pass over the full transcript — expensive, lossy in
unpredictable ways. Instead: Jev scores each transcript block (`drop | summarize | keep verbatim`),
code assembles the new context. The summarizing LLM then only sees the `summarize` bucket.

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

# Prior art: JevRouter (jevrouter.co)

`BillionsBobby/JevRouter` — MIT, TypeScript, ~2.7k LOC src, 87 stars, active (pushed 2026-09-19).
`npx --yes github:BillionsBobby/JevRouter agent start --agent claude`

## What it already does — J1 and J2

A local **decision/dispatch** layer between the agent host and Jev:
normalizes candidates (models, MCP tools, skills, plugins, subagents) into capability manifests,
builds Choice questions, preserves raw probabilities/confidence, applies local policy + permission +
risk + confidence gates, does multi-step plans with beam search and diversity-penalty reranking over
candidates, caches by provider+state+candidate snapshot, and returns a decision handoff.
Default mode is `decision_only` — it never executes side effects itself.

**Verdict: adopt, don't rebuild.** J1 (model routing) and J2 (tool/skill/MCP gating) are done,
and done reasonably — policy gates and confidence handling are the parts that are tedious to get right.

## What it does NOT do — J3 through J7

Confirmed by reading the source tree: no memory layer, no retrieval reranking, no context
pruning, no compaction control, no tool-result filtering, no stop gate, no guardrails.
Its only "rerank" is diversity-penalty reranking of *capability candidates*, not of retrieved content.

**JevRouter decides what the agent should DO. Nothing yet decides what the agent should READ.**

That second half is where the Claude bill actually lives:

| Layer | Who owns it | Token impact |
|---|---|---|
| J1 model routing | JevRouter | picks a cheaper model per turn |
| J2 tool/skill gating | JevRouter | catalog size in system prompt |
| **J3 memory recall rerank** | **unclaimed** | injected memory per session |
| **J4 tool-result filtering** | **unclaimed** | usually the largest single sink |
| **J5 compaction survivors** | **unclaimed** | whole-transcript LLM pass |
| **J6 stop/continue gate** | **unclaimed** | whole turns, not tokens |
| J7 guardrails | unclaimed (TypeSafe cookbook exists) | replaces an LLM safety pass |

## Read their numbers carefully

- **"Save 99.97% of your tokens"** — their own method note says this is a *directional estimate*
  for the **decision-layer** workflow when Jev replaces GPT-6 as the router. It is savings on the
  cost of *making the routing decision*, not on your agent's context. Routing decisions were never
  the expensive part. Do not quote this figure as agent-cost savings.
- **Toolathlon benchmark, 10 tasks, first five tool calls:** Jev serial 38% position-wise vs
  DeepSeek V4.1 Flash 24%; prefix LCP 0.9 vs 0.5; 5.5x faster (1.58s vs 8.65s); 7x cheaper
  ($0.0058 vs ~$0.0407 per task).
- 38% absolute is low. It beats the baseline, but it means **confidence gating is mandatory, not
  optional** — a wrong route costs a whole wasted Opus turn, which dwarfs the routing saving.
  n=10 tasks is not a benchmark you should plan capacity against.

## Revised position

1. **Take JevRouter for J1/J2.** Wire it up, keep `decision_only`, tune the confidence floor high.
2. **Build the context layer (J3–J6) as the differentiator.** Same Jev primitives, different target:
   not "which capability", but "which tokens deserve to enter the window."
   Start with J3 (memory rerank over claude-mem's store) — self-contained, no harness changes.
3. **Instrument both.** Their 38%/99.97% numbers are not transferable to your workload.
   Log tokens-into-Claude per turn and $/completed-task before and after.

A context layer is also complementary rather than competing: it can ship as a JevRouter-adjacent
package, or upstream into it, since it consumes the same provider config and API key.


---

# Naming: Jevusher

**Product + GitHub org:** `jevusher`. **npm:** `jevusher` / `@jevusher/*`.

## Why it works

- **Says the job.** An usher controls the door and the seating. Jevusher controls what enters the
  context window and in what order. The one-line pitch writes itself: *the doorman for your
  context window.*
- **Stakes out the unclaimed half.** JevRouter = dispatch. Jevusher = admission. Complementary
  names, no collision, obvious co-existence story ("route with JevRouter, admit with Jevusher").
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
state plainly in the README that Jevusher is an independent project that *uses* Jev. JevRouter
has the same exposure and has not been challenged, which is weak evidence but not permission.
