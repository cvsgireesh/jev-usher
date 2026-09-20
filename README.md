# Jevusher — model routing and context admission for Claude Code

**The doorman for your context window.**

Jevusher uses TypeSafe's JEV model to choose a Claude model for a new session and
select useful tool output before Claude reads it. It provides a Claude Code
launcher and plugin, a TypeScript library, and a local test UI for comparing
model selection, context filtering, or both.

Use it when tools return more text than a task needs. JEV scores relevance;
Jevusher applies budgets and failure rules. Keep the original available, then
measure whether the smaller input still lets Claude complete the task.

```text
original tool output → JEV judgments → deterministic policy → selected context
         │                                    │
         └──────── original kept for recovery ┘
```

**Status: preview.** The launcher enables routing and recoverable filtering;
direct plugin and settings installations require filtering to be enabled
separately. Filtering supports specific output formats and can omit useful
information. Inspect decisions and compare answers in the UI before using it in
ongoing work. Token reduction alone does not prove lower cost or unchanged quality.

## Quickstart: local test UI

Requirements: Node.js 20 or newer, a [TypeSafe API key](https://docs.typesafe.ai/),
and Claude Code 2.1.278 or newer signed in to your subscription for paired tests.
Use a current Node 22 or 24 release to develop. Offline tests need no API key.

```bash
git clone https://github.com/cvsgireesh/jevusher.git
cd jevusher
npm ci
npm run check
export JEV_API_KEY='your-typesafe-key'
node bin/jevusher.mjs ui
```

Open `http://127.0.0.1:4318`. Choose a synthetic scenario and baseline Claude model,
then compare context filtering, model routing, or both. The default compares
Sonnet against combined routing and filtering. Inspect the JEV preview before
running the paired Claude test.
The UI starts no model calls until you run a test. JEV calls spend TypeSafe
credits; paired Claude tests consume your subscription allowance.

The UI runs on your computer. JEV judgments still use TypeSafe's hosted API, and
Claude requests use Anthropic's service. Read the [local UI guide](docs/local-ui.md)
and [data handling](docs/privacy.md) for the exact boundary.

## Claude Code setup

Start a new Claude session with automatic model routing and recoverable filtering:

```bash
node /absolute/path/to/jevusher/bin/jevusher.mjs claude "Find the cause of the retry failure"
```

JEV judges the launch prompt and selects Haiku, Sonnet, or Opus when confident.
Uncertain or unavailable routing keeps Claude's configured model. Explicit
`--model` arguments and `ANTHROPIC_MODEL` take precedence;
`--no-route` keeps Claude's configured model. Resumed conversations keep their
model selection. Routing applies at session start and does not change models
between turns. Pass Claude options after `--`:

```bash
node /absolute/path/to/jevusher/bin/jevusher.mjs claude "Continue the investigation" -- --continue
```

Set `JEVUSHER_FILTER=0` to keep launcher routing while disabling output filtering.

To use Claude directly, load the checkout as a plugin:

```bash
claude --plugin-dir /absolute/path/to/jevusher
```

Or install settings hooks in the project where you want them:

```bash
node /absolute/path/to/jevusher/bin/jevusher.mjs install
node /absolute/path/to/jevusher/bin/jevusher.mjs doctor
```

Choose one method to avoid duplicate hooks. Settings hooks use the installed local
executable; keep the checkout at that path. Run the same command with `uninstall`
to remove them. Installation alone does not enable output filtering or screening.
See [Claude Code configuration](docs/claude-code.md) for supported tools, explicit
memory inputs, filtering, and recovery.

## TypeScript example

After building, install the checkout into your application with
`npm install /absolute/path/to/jevusher`:

```ts
import { Jevusher } from "jevusher";

const usher = new Jevusher();
const result = await usher.usher.admit({
  goal: "Find the widget service retry limit",
  candidates: [
    { id: "config", text: "Widget retries failed requests at most three times." },
    { id: "picnic", text: "The office picnic is on Sunday." },
  ],
  budget: 2000,
});

// Pass the selected text to your model; retain the originals for recovery.
console.log(result.admitted, result.verdicts);
```

| Component | Library behavior | Claude Code integration |
|---|---|---|
| Filter | Screens and selects tool-output chunks | Recoverable Read, diagnostic Bash, Grep, Glob, and allowlisted MCP output filtering |
| Usher | Selects supplied memory within a budget | Injects from an explicitly configured JSONL store |
| Gate | Shortlists capabilities, then selects | Adds a hint; does not remove Claude's skill catalog |
| Router | Selects a configured model tier | Launcher selects the session model; prompt-hook hints remain advisory |
| Compactor | Keeps, shortens, or drops text blocks | Library only; does not replace native compaction |
| Screen | Flags possible injected instructions | Opt-in warning; not a permission system |
| StopGate | Recommends ending or continuing a loop | Optional completion check; not installed by default |

See the [API reference](docs/reference.md) for thresholds, budgets, and result types.
The plugin does not discover private memories or override `CLAUDE.md` or configured
permissions. After a filtered source read, it requires recovery of the original
before a native Edit or Write. All admitted memory and capability records are explicit inputs.

## Limits and failure behavior

JEV returns typed `Choice`, `Score`, and `Noul` judgments, not generated summaries.
The client pins `jev-1.13.0`. JEV can misclassify adversarial text, and irrelevant
context can reduce accuracy. Confidence is not proof that a decision is correct.
[TypeSafe model limits](https://docs.typesafe.ai/models) ·
[Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

- Hook failures leave the original tool result available. Unsupported formats
  pass through. Recovery must succeed before any result is replaced.
- Library memory admission keeps uncertain material within its hard budget;
  even an outage fallback can exclude useful material when the budget is small.
- Library compaction preserves uncertain blocks verbatim, even over `keepBudget`.
  Confident reductions are lossy; the caller owns transcript integrity and recovery.
- Screening returns `unavailable` for missing or invalid answers. A `pass` means
  nothing detected, not that text is safe to execute.
- Requests and concurrency are bounded. Oversized inputs fall back instead of
  receiving a misleading judgment on a silently truncated sample.

Read [architecture and accounting](docs/architecture.md) for resource bounds and
which figures are estimates.

## Common questions

**Will this reduce my Claude subscription bill?** A fixed subscription fee does
not decrease when a prompt shrinks. Smaller inputs may help usage allowance, but
retries, output, prompt caching, and task quality also matter. Compare completed
tasks; API dollar estimates are not subscription savings.

**Does everything stay local?** No. The UI and hooks run locally, but text chosen
for evaluation is sent to TypeSafe. Claude tests also send their synthetic task
inputs to Anthropic. No API key is needed for offline tests.

**Does it replace Claude's memory, tool search, or prompt cache?** No. It works
with explicit inputs and supported tool outputs. Comparisons should preserve
Claude's native features in both runs.

**Can I use it without Claude Code?** Yes. The TypeScript library accepts
caller-owned candidates and returns decisions. Your application decides how to
use the selected text.

## Development and support

```bash
npm run check          # offline tests, typecheck, and build
npm run test:package   # install and exercise a packed artifact
# Optional paid evaluation with synthetic fixtures:
npm run eval:live -- --live --out /tmp/jevusher-evaluation.json
npm run eval:claude -- --live --out /tmp/jevusher-claude.json
```

Read [Contributing](CONTRIBUTING.md) or [agent instructions](AGENTS.md) to work on
the repository. Report a reproducible problem through
[GitHub issues](https://github.com/cvsgireesh/jevusher/issues). Keep credentials,
private transcripts, and generated test reports out of issues and commits.

[Local UI](docs/local-ui.md) · [Claude Code](docs/claude-code.md) ·
[API reference](docs/reference.md) · [Privacy](docs/privacy.md) ·
[Security](SECURITY.md) · [Documentation index for agents](llms.txt)

Independent project; not affiliated with or endorsed by TypeSafe or Anthropic.
JEV is TypeSafe's model. [MIT licensed](LICENSE).
