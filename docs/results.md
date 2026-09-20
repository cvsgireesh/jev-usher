# Measured results

On September 20, 2026, all **26 live paired comparisons** passed their fixture
checks at [preview revision 6617f06](https://github.com/cvsgireesh/jev-usher/commit/6617f06e7abc4e49246b7e65fb12f39c9006aa51). The suite tested 13 synthetic tasks once with context filtering and once
with routing plus filtering. Each pair ran Claude without and with jev-usher;
all 52 answers passed the expected-field and exact-value checks. Passing these
checks establishes task correctness for the fixtures, not an optimization benefit.

## Whole-run tokens and elapsed time

| Mode | Claude tokens, without → with | Tokens: lower / unchanged / higher | Total elapsed time, without → with | Pairs: slower / faster |
|---|---|---|---|---|
| Filtering | 105,067 → 101,792 (3.1% fewer) | 4 / 7 / 2 | 49.834 → 60.333 s (21.1% longer) | 11 / 2 |
| Routing + filtering | 105,098 → 102,650 (2.3% fewer) | 6 / 5 / 2 | 51.283 → 67.838 s (32.3% longer) | 13 / 0 |

These totals add Claude's input, output, cache-read, and cache-creation tokens
across each complete run. They include recovery reads. They are not the smaller
text estimates produced by the admission policy, and they do not establish a
subscription-dollar saving. The median token change was **zero** in both modes.

Elapsed time measures each Claude process from startup to completion, including
hooks and recovery reads. For combined mode, the routing duration is added once
to the with-jev-usher run. Filtering time already occurs inside the Claude run
and is not added again. The table sums the 13 runs on each side; it does not
report the average task duration.

No elapsed-time result was unchanged. Median added time was 0.502 seconds for
filtering and 0.852 seconds for combined mode. **No pair reduced both tokens and
time.** This suite does not demonstrate a speed win: combined mode was slower
on every task, and filtering's two faster runs used the same number of tokens.

## Token counts by task

Each cell below shows **without → with** tokens. The totals include every row,
including increases.

| Task | Filtering | Routing + filtering |
|---|---:|---:|
| Find an important rule | 8,305 → 5,116 | 8,305 → 5,087 |
| Understand why a task failed | 8,300 → 5,107 | 8,288 → 5,096 |
| Find details across a long document | 7,957 → 7,957 | 7,969 → 7,969 |
| Check an updated rule | 8,093 → 5,162 | 8,087 → 5,154 |
| Copy names exactly | 8,056 → 11,841 | 8,056 → 4,849 |
| Read a short note | 4,319 → 4,319 | 4,319 → 4,319 |
| Find what stopped a task | 8,163 → 13,418 | 8,192 → 13,447 |
| Review all the rules | 6,169 → 6,169 | 6,184 → 6,164 |
| Check how code behaves | 8,544 → 5,542 | 8,538 → 13,447 |
| Find details in an activity log | 16,847 → 16,847 | 16,847 → 16,847 |
| Find a detail in search results | 11,386 → 11,386 | 11,382 → 11,382 |
| Find the right file | 8,264 → 8,264 | 8,266 → 8,266 |
| Answer a simple question | 664 → 664 | 665 → 623 |

## What the comparison establishes

Filtering used Sonnet on both sides. Combined mode also started from a Sonnet
baseline: JEV confidently selected Haiku for the simple question and retained
Sonnet for the other 12 tasks. The reported models were `claude-sonnet-5` and
`claude-haiku-4-5-20251001`; the model aliases can resolve differently over time.

All four pairs with higher usage read an archived original after receiving
filtered text. Recovery preserved the needed information but consumed extra
tokens. Bash, Grep, and Glob outputs were retained in these runs, so this suite
does not demonstrate savings for those tools. Small output-length differences
also contribute to totals; every reduction cannot be attributed to filtering.

The runs used Claude Code 2.1.278, JEV `jev-1.13.0`, low Claude effort, isolated
synthetic workspaces, and alternating run order. Checks verified the requested
facts and observed tool results, including whether a proposed replacement
actually reached Claude. These checks cover the supplied fixtures. One pass
does not establish reliability on a real repository, editing tasks, long
conversations, or adversarial inputs. Cache state and model variability affect
repeat measurements.

## Reproduce

Build the checkout, configure a JEV API key, and sign in to the official Claude
CLI as described in the [local UI guide](local-ui.md). These commands spend JEV
credits and Claude subscription allowance: each suite makes 26 Claude runs.

```bash
npm run eval:claude -- --live --optimization context --baseline-model sonnet --out /tmp/jev-usher-context.json
npm run eval:claude -- --live --optimization combined --baseline-model sonnet --out /tmp/jev-usher-combined.json
```

Use `--repeat 2` to repeat each scenario or `--scenarios release,incident` for a
smaller selection. Keep generated reports outside the repository. The
[evaluation script](../scripts/evaluate-claude.mjs) and
[synthetic scenarios](../src/lab-scenarios.ts) define the checks. For an individual
task, the local UI shows the answers side by side with whole-run usage and time.
