<h1 align="center">Jevusher</h1>
<p align="center"><b>The doorman for your context window.</b></p>

Jevusher uses TypeSafe's JEV model to rank and select text before an expensive
model reads it. It provides a TypeScript library and a Claude Code plugin.

**Status: preview.** The library makes admission decisions; your agent must apply
them. The current Claude Code adapter adds selected memories, capability hints,
and optional screening warnings. It does not automatically replace tool results,
change models, or replace Claude's compaction.

```text
candidate text → JEV judgments → deterministic policy → selected context
                     ↓                   ↓
               uncertainty          budgets / fallback
```

## Try it from source

Node.js 20 or newer for the runtime; use a current Node 22 or 24 release to develop.
A TypeSafe API key is required for live judgments. No key is needed for unit tests.

```bash
git clone https://github.com/cvsgireesh/jevusher.git
cd jevusher
npm ci
npm run check
export JEV_API_KEY='your-typesafe-key'
node bin/jevusher.mjs doctor
```

For Claude Code, load the built checkout as a plugin:

```bash
claude --plugin-dir /absolute/path/to/jevusher
```

Or install settings hooks in the project where you want them:

```bash
node /absolute/path/to/jevusher/bin/jevusher.mjs install
# Undo with the same executable:
node /absolute/path/to/jevusher/bin/jevusher.mjs uninstall
```

Choose one installation method to avoid duplicate hook execution. Settings hooks
use the installed local executable, with no package download at each turn.
Keep the checkout at that path. See [Claude Code setup](docs/claude-code.md).

**Data boundary:** configured memories, capabilities, and the prompt are sent to
TypeSafe when the prompt hook runs. Tool-output screening is off by default.
Enabling it sends selected external tool text to TypeSafe. This is a cloud model,
not local inference. Read [data handling](docs/privacy.md) before enabling it on
private work.

## Library

After building, a local application can install the checkout with
`npm install /absolute/path/to/jevusher` and import the package:

```ts
import { Jevusher } from "jevusher";

const usher = new Jevusher({ prices: { jev: 0.042, target: 5 } });
const result = await usher.usher.admit({
  goal: "Find the widget service retry limit",
  candidates: [
    { id: "config", text: "Widget retries failed requests at most three times." },
    { id: "picnic", text: "The office picnic is on Sunday." },
  ],
  budget: 2000,
});

// Your agent passes result.admitted to its model and retains original sources.
console.log(result.admitted, result.verdicts);
```

| Component | Library behavior | Shipped Claude Code behavior |
|---|---|---|
| Router | Selects a configured model tier | Advisory hint only |
| Gate | Shortlists capabilities, then selects | Adds a hint; does not remove Claude's skill catalog |
| Usher | Selects supplied memory within a budget | Injects from an explicitly configured JSONL store |
| Filter | Screens and selects tool-output chunks | Library only |
| Compactor | Keeps, shortens, or drops text blocks | Library only |
| StopGate | Recommends ending or continuing a loop | Optional completion check; not installed by default |
| Screen | Flags possible injected instructions | Opt-in warning; original result remains visible |

The plugin does not read Claude's private databases, discover your memories,
override `CLAUDE.md`, or alter tool permissions. Current Claude Code supports
output replacement through `PostToolUse`; that adapter is not implemented here.
See the [integration contract](docs/claude-code.md).

## Failure behavior

- Memory admission keeps uncertain material **within the configured budget**.
  A hard budget can still exclude useful material, including during outages.
- Capability selection surfaces nothing when uncertain by default. Routing uses
  the configured fallback tier.
- Compaction retains uncertain blocks verbatim, even over `keepBudget`. Certain
  blocks may be shortened or dropped. This is **lossy**, despite preserving the
  characters that survive. `keepBudget` is not a total context limit.
- Screening returns `unavailable` for missing or invalid answers. A `pass` means
  nothing detected; it is not a security guarantee.
- Hooks do not block prompts on failure. Their network work has a 15-second
  deadline, with no retries and a maximum of 5 seconds per request.

## Limits and measurement

JEV returns `Choice`, `Score`, and `Noul` judgments, not generated text. The client
pins `jev-1.13.0`; change the version deliberately when revalidating thresholds.
TypeSafe documents a 64k-token request limit and a 32k-token limit for state plus
the longest question. Jevusher uses smaller conservative byte limits, bounded
batches, and at most four concurrent requests per batch runner. Oversized inputs
fall back rather than being silently truncated.

JEV can misclassify adversarial text and loses accuracy with irrelevant context.
Confidence is not proof that a decision is correct. Start with reversible
selection, retain source material, and evaluate on representative tasks.
[TypeSafe model limits](https://docs.typesafe.ai/models) ·
[Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

`report` estimates selected token volume and JEV cost. Hook context is recorded
as added context, not invented catalog savings. Library figures assume the caller
uses the selection. Neither figure proves a lower bill or unchanged task quality;
cache reads, retries, output tokens, and completion quality also matter.

```bash
npm run check                    # deterministic, offline tests and build
npm pack                         # validates and builds the distributable
# Optional paid API evaluation, synthetic fixtures only:
npm run eval:live -- --live --out /tmp/jevusher-evaluation.json
```

Live evaluation results belong outside the repository. These component checks do
not establish Claude task-quality parity or production readiness.

[Reference](docs/reference.md) · [Architecture](docs/architecture.md) ·
[Claude Code](docs/claude-code.md) · [Privacy](docs/privacy.md) ·
[Contributing](CONTRIBUTING.md)

Independent project. Not affiliated with or endorsed by TypeSafe or Anthropic.
Jev is TypeSafe's model name. MIT licensed.
