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
npm install jevusher      # library
npx jevusher install      # wire the Claude Code hooks
```

```bash
export JEV_API_KEY=...    # or TYPESAFE_API_KEY
```

## The seven lenses

One posture throughout: **Jev reads cheaply so the expensive model does not have to.**

| | lens | decides | class |
|---|---|---|---|
| J1 | `Router` | which model and effort level this turn deserves | selection |
| J2 | `Gate` | which skills/tools/subagents to surface, out of hundreds | selection |
| J3 | `Usher` | which recalled memories earn a place in the window | admission |
| J4 | `Filter` | which chunks of tool output land in the transcript | admission |
| J5 | `Compactor` | which transcript blocks survive compaction, verbatim or summarized | admission |
| J6 | `StopGate` | whether the loop should still be running | control |
| J7 | `Screen` | whether fetched content is trying to issue instructions | safety |

Use one, or wire the lot together with `Jevusher`.

### Everything at once

```ts
import { Jevusher } from "jevusher";

const jevusher = new Jevusher();

// J1 + J2 + J3, concurrently, for one incoming turn.
const before = await jevusher.beforeTurn({ turn, memory, catalog });
before.route.tier.id;   // 'hard'
before.skills;          // [ { id: 'browser', ... } ]
before.admitted;        // only the memories this turn actually needs

// J4 + J7 on what a tool just returned.
const filtered = await jevusher.filterToolResult({ goal: turn, chunks, source: "web" });
filtered.blocked;       // chunks caught issuing instructions to the agent
filtered.admitted;      // what is worth putting in the transcript

// J6 before the next expensive turn.
const { shouldStop, reason } = await jevusher.shouldStop({ goal, work, nextAction });

// J5 instead of paying a big model to read the whole transcript.
const { keep, summarize, drop } = await jevusher.beforeCompact({ goal, blocks });

jevusher.report();      // tokens offered vs sent, per lens, priced
```

Live run of exactly that, against `api.typesafe.ai` — see [`examples/end-to-end.ts`](examples/end-to-end.ts):

```
turn: Users report the login page redirects in a loop, but only on Safari. Find and fix it.

J1 route    : hard (conf 0.95, needsFiles 0.88, needsTools 0.76)
J2 gate     : browser [selected]                    <- out of git/browser/xlsx/pdf/slides
J3 memory   : mem:redirect, mem:safari, mem:cookie  <- dropped tailwind, standup
J7 screen   : doc:evil injection=0.98 jailbreak=0.99 harm=2.00 -> block
J4 filter   : admitted doc:itp                      <- dropped the sourdough recipe
J6 stop     : shouldStop=true reason=looping (looping 0.96)
J5 compact  : keep=[t6] summarize=[t1,t3,t4,t5] drop=[t2]
```

### Individually

```ts
import { Usher, Router, Gate, Filter, Compactor, StopGate, Screen } from "jevusher";

const { admitted, verdicts } = await new Usher().admit({
  goal: "Why does the login redirect loop on Safari?",
  candidates: [
    { id: "mem:1", text: "Session cookie SameSite was changed to Strict in March." },
    { id: "mem:2", text: "We use Tailwind for styling." },
  ],
  budget: 4000,
});
```

Every lens returns per-item verdicts with the score, the confidence and the reason, so you can log
and tune rather than trust:

```
mem:1  2.00  0.91  admitted
mem:2  0.11  0.94  below-threshold
```

## Fail open, except when you shouldn't

**Admission lenses fail open.** Dropping material the model needed costs a wrong answer and a
retry — a whole extra expensive turn. Admitting material it did not need costs a few hundred
tokens. The asymmetry is enormous, so uncertainty resolves toward admission, and a provider
outage degrades to *no lens installed* rather than to an empty context.

**Selection lenses fail closed.** Surfacing the wrong tool is not free: it pollutes the prompt and
invites a wrong call. When `Gate` is unsure it surfaces nothing, which is a valid answer.

**`Compactor` never drops on an unsure verdict** — it demotes to `summarize`, the safe middle rung.

**`Screen` reports `unavailable`, never `pass`,** when it could not run. And `pass` means
*nothing detected*, never *safe to obey*. Fetched content is still data after it passes.

## Claude Code

```bash
npx jevusher install          # project   .claude/settings.json
npx jevusher install --global # user      ~/.claude/settings.json
npx jevusher doctor           # key, connectivity, store contents
npx jevusher report           # what the lenses have actually saved
```

| hook | lens | what it does |
|---|---|---|
| `UserPromptSubmit` | J1 J2 J3 | injects the routing hint, the one relevant capability, and the memories that earned a place, as `additionalContext`. Never blocks a prompt. |
| `PostToolUse` | J7 | warns Claude when web/MCP output is issuing instructions. Matcher `WebFetch\|WebSearch\|mcp__.*`. |
| `Stop` | J6 | not installed by default — see below. |

Feed it:

```bash
~/.claude/jevusher/memory.jsonl    {"id":"...","text":"..."}
~/.claude/jevusher/catalog.jsonl   {"id":"...","name":"...","summary":"...","detail":"..."}
```

### What the hooks genuinely cannot do

Worth stating plainly, because the honest limits are the useful part:

- **`Stop` cannot stop early.** Claude Code's Stop hook can only *refuse to let a turn end*. So J6
  runs inverted there — it blocks stopping when the goal is clearly unmet. Real early stopping
  needs SDK-level control of the loop. It is off by default because it fights the agent more often
  than it helps.
- **`PreCompact` cannot steer compaction.** It can block it, nothing more. `Compactor` is for
  custom agents and SDK loops, not for the Claude Code hook.
- **`PostToolUse` fires after the tool ran**, so it cannot keep output out of the transcript. It
  can only annotate. J4's real value is in agents you control, where you filter before appending.
- **J1 is advisory in a hook.** It injects a suggestion; it does not switch the model for you.

## Measure it — including this project's claims

The number that matters is **tokens-into-the-expensive-model per turn** and **$ per completed
task**, not how many Jev calls you made.

```bash
npx jevusher report
```

```
  offered to model : 261 tok
  actually sent    : 118 tok
  kept out         : 143 tok
  jev read         : 6,866 tok in 7 requests
  net              : $0.00186
```

That example is a toy, and its numbers are close to noise: Jev read 6,866 tokens to keep 143 out.
**On small inputs these lenses lose money.** They pay off where the inputs are actually big — a
200-skill catalog is ~20k tokens in every system prompt, an unfiltered `grep` or page fetch is
routinely 10k+, and a retry turn on Opus dwarfs all of it. Run `report` on your own workload
before believing any of it, this README included.

## Reference

### `admit(options)`

| option | default | meaning |
|---|---|---|
| `goal` | — | what the expensive model is trying to do |
| `candidates` | — | `{ id, text, tokens?, meta? }[]` |
| `budget` | `4000` | ceiling on admitted tokens |
| `threshold` | `1.5` | minimum score on the levels scale |
| `minConfidence` | `0.55` | below this, the score is not trusted |
| `failOpen` | `true` | what to do with unsure verdicts and provider failures |
| `checkNeed` | `true` | also ask whether the goal needs context at all |
| `batchSize` | `64` | candidates per request |

Verdict reasons: `admitted`, `low-confidence-admitted`, `below-threshold`,
`low-confidence-turned-away`, `over-budget`, `goal-needs-no-context`, `provider-error-admitted`.

### CLI

Every lens is scriptable — JSON on stdin, JSON on stdout:

```bash
echo '{"goal":"g","candidates":[{"id":"a","text":"..."}]}' | npx jevusher admit
echo '{"turn":"rename the getter"}' | npx jevusher route
```

`route` · `admit` · `gate` · `screen` · `stop` · `compact` · `report` · `doctor` · `install`

## Design notes

[`docs/architecture.md`](docs/architecture.md) — the seven insertion points, the economics, and
an analysis of [JevRouter](https://github.com/BillionsBobby/JevRouter), which solves the dispatch
half and which Jevusher is deliberately complementary to.

## License

MIT
