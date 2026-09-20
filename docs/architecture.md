# Architecture

jev-usher separates semantic judgments from deterministic actions. The TypeSafe
provider evaluates text; the lenses apply thresholds and budgets; the caller
controls the downstream model, tool execution, and transcript.

## Data flow

```text
caller-owned candidates
         │
         ▼
 validate IDs, text, budgets
         │
         ▼
 bounded candidate batches ───► TypeSafe POST /v1/systemone
         │                          │
         │                     typed responses
         │                          ▼
         └────────────────── validation + lens policy
                                    │
                                    ▼
                         selection + verdicts + usage
                                    │
                                    ▼
                          caller applies the result
```

`Provider` is the transport boundary. The HTTP client validates response types,
probability ranges, candidate choices, and usage. Custom providers must honor the
same contract. The lens helpers also reject missing and non-finite judgments.

`Usher` scores candidates and packs eligible material into a token budget.
Each batch gets its own need check; only unanimous low need can suppress the
whole set. `Gate` ranks a catalog before a second request chooses from a shortlist
or none. These stages cannot be collapsed because the shortlist depends on the
first response. Other independent requests can run concurrently.

## Resource bounds

Candidate batches have a count ceiling and a 20,000-byte serialized-item budget.
An individual oversized candidate remains whole. The HTTP client rejects state
plus its longest question above 32,000 UTF-8 bytes, or a full serialized request
above 64,000 bytes. These conservative byte caps are deliberately smaller than
TypeSafe's token-based allowances. They are not a JEV tokenizer.

Each batch runner uses at most four requests concurrently; independent pipeline
lenses can each have their own runner. The SDK client retries transient failures
with backoff and respects `Retry-After` within its timeout allowance. Hooks disable
retries and share a 15-second deadline across batches and stages.

Candidate `tokens` values supplied by the caller drive packing. Otherwise the
estimate is UTF-16 text length divided by four, rounded up. It may substantially
undercount code, emoji, or non-English text. A real model context ceiling needs
that model's tokenizer and room for instructions and output.

## Ownership and failure

The caller retains original sources and decides how selections enter the model
request. `Compactor.retained` preserves the order of surviving text blocks. The
compactor does not parse model message schemas, pair tool calls with results,
protect system instructions, or supply recovery storage. Do those in the harness
before enabling destructive transcript reduction.

Admission failure retains candidates in input order subject to `budget`.
Compaction failure retains every block. Uncertain compaction keeps exact text,
even over `keepBudget`. A confident reduction can lose relevant information;
byte-preserving excerpts are not lossless compression.

A screening verdict is advisory evidence. It never grants permission to execute
instructions embedded in data. The library filter can remove blocked chunks;
the Claude screening hook adds warnings. The separate opt-in admission hook can
replace supported tool results after archiving their exact original text. It
retains ambiguous material and bypasses unsupported formats, missing goals,
failed provider calls, and recovery failures. See [Claude Code](claude-code.md)
for the supported formats and recovery lifecycle. None of these classifiers is
a complete security boundary.

## Accounting

The pipeline ledger records offered and selected text estimates plus reported
JEV usage. Library savings are hypothetical until a harness applies the selection.
The Claude prompt adapter records all injected text as overhead because it does
not remove existing Claude context. Screening has cost and no claimed savings.
Tool admission compares the original result with the emitted replacement,
including its recovery notice. This measures selected text size; it cannot prove
that a particular Claude build consumed the replacement or completed the task.

The ledger is not an invoice. Failed batch groups can omit usage from successful
sibling calls; transport retries may also cost more than the final response shows.
Cross-check TypeSafe usage for billing. Do not sum overlapping lens estimates as
independent savings. Prompt caching, cache invalidation, target output, retries,
and task success require downstream telemetry or controlled task comparisons.
