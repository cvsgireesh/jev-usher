# Jevusher

**The doorman for your context window.**

An usher does not decide the show. It decides who gets through the door and where they sit.

Jevusher uses [Jev](https://docs.typesafe.ai) — a System One model that returns calibrated typed
judgments instead of text — to read candidate material cheaply and decide which of it is worth
sending to an expensive model.

```
Jev input:    $0.042 / Mtok   (output free)
Opus input:  ~$15    / Mtok
```

Roughly **350x cheaper to read**. So let the cheap model read everything, and let the expensive
model read only what earned its place.

> [!NOTE]
> Jevusher is an independent project. It is not affiliated with or endorsed by TypeSafe.
> "Jev" is TypeSafe's model name.

## The gap this fills

[JevRouter](https://github.com/BillionsBobby/JevRouter) already routes **decisions** — which model,
which tool, which subagent. That is the dispatch half, and it is solved.

Nothing yet governs the **admission** half:

| | decides | owned by |
|---|---|---|
| Dispatch | what the agent *does* | JevRouter |
| **Admission** | what the agent *reads* | **Jevusher** |

For a coding agent the admission half is usually the larger bill. A routing decision costs a few
hundred tokens. A 40k-token system prompt re-read every turn, a memory digest injected wholesale,
and an unfiltered `grep` dump do not.

## Install

```bash
npm install jevusher
```

```bash
export JEV_API_KEY=...   # or TYPESAFE_API_KEY
```

## Use

```ts
import { Usher } from "jevusher";

const usher = new Usher();

const { admitted, verdicts, tokensOffered, tokensAdmitted } = await usher.admit({
  goal: "Why does the login redirect loop on Safari?",
  candidates: [
    { id: "mem:1", text: "Session cookie SameSite was changed to Strict in March." },
    { id: "mem:2", text: "We use Tailwind for styling." },
    { id: "mem:3", text: "Safari blocks third-party cookies by default." },
  ],
  budget: 4000,
});

console.log(admitted.map((c) => c.id));      // [ 'mem:1', 'mem:3' ]
console.log(tokensOffered, "->", tokensAdmitted);
```

Every candidate comes back with a verdict, so you can log and tune:

```ts
for (const v of verdicts) {
  console.log(v.id, v.score?.toFixed(2), v.confidence?.toFixed(2), v.reason);
}
// mem:1  2.00  0.91  admitted
// mem:3  1.84  0.88  admitted
// mem:2  0.11  0.94  below-threshold
```

## How it works

One request. `state` carries the goal and every candidate; the candidates are ingested **once** and
all questions are evaluated against them in parallel.

- One **Score** per candidate: *irrelevant → background → directly needed*.
- One **Noul**: *does this goal need any of this material at all?* When the answer is a clear no,
  everyone is turned away and the model answers from its own knowledge.
- Your code does the packing. Candidates sort by score and fill the token budget; the rest are
  turned away with a reason.

Sets larger than `batchSize` (default 64) are split into parallel requests automatically.

## Options

| option | default | meaning |
|---|---|---|
| `goal` | — | what the expensive model is trying to do; relevance is judged against this |
| `candidates` | — | `{ id, text, tokens?, meta? }[]` |
| `budget` | `4000` | ceiling on admitted tokens |
| `threshold` | `1.5` | minimum score on the levels scale |
| `minConfidence` | `0.55` | below this, the score is not trusted |
| `failOpen` | `true` | what to do with unsure verdicts and provider failures |
| `checkNeed` | `true` | also ask whether the goal needs context at all |
| `needThreshold` | `0.15` | turn everyone away below this need probability |
| `levels` | 3 defaults | override the relevance rubric |
| `batchSize` | `64` | candidates per request |

## Fail open, always

`failOpen: true` is the default and should usually stay that way.

Dropping material the model needed costs a wrong answer and a retry — a whole extra turn on an
expensive model. Admitting material it did not need costs a few hundred tokens. The asymmetry is
enormous, so uncertainty resolves toward admission, and a provider outage degrades to *no usher
installed* rather than to an empty context.

## Verdict reasons

| reason | meaning |
|---|---|
| `admitted` | scored above threshold with trusted confidence |
| `low-confidence-admitted` | Jev was unsure; fail-open let it in |
| `below-threshold` | confidently judged not needed |
| `low-confidence-turned-away` | unsure, and `failOpen` was off |
| `over-budget` | earned a place but did not fit |
| `goal-needs-no-context` | the need check said the goal is self-contained |
| `provider-error-admitted` | Jev was unreachable; admitted without judgment |

## Roadmap

Jevusher starts with memory recall because it is self-contained and measurable. The same admission
primitive generalizes:

- [x] **Memory / retrieval rerank** — score recalled items, admit the top under budget
- [ ] **Tool-result filtering** — grep hits, page fetches, log dumps, scored before they land
- [ ] **Compaction survivors** — score transcript blocks `drop | summarize | keep`
- [ ] **Stop gate** — *has the goal been met?* Ending a loop one turn early beats every token saving
- [ ] **Injection screening** — hostile instructions in fetched content, caught on the way in
- [ ] Adapters: Claude Code hook, MCP server, `claude-mem` store

## Measure it

The number that matters is **tokens-into-the-expensive-model per turn**, and **$ per completed
task** — not how many Jev calls you made. `admit()` returns `tokensOffered`, `tokensAdmitted` and
`jevUsage` so you can log both sides from day one.

Be skeptical of savings claims, including this project's. Measure on your own workload.

## License

MIT
