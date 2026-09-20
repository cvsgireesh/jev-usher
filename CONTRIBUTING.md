# Contributing

Use a current Node 22 or 24 release:

```bash
npm ci
npm run check
npm run test:package
```

Tests use fake providers and make no API calls. Examples are included in typechecks.
See [AGENTS.md](AGENTS.md) for the code map and implementation boundaries.

## Report a problem or propose a change

Use [GitHub issues](https://github.com/cvsgireesh/jev-usher/issues) for reproducible
bugs and concrete use cases. Include jev-usher, Node, and Claude versions when
relevant. A small synthetic input with expected and actual behavior is more useful
than a private transcript. Use [SECURITY.md](SECURITY.md) for sensitive reports.

Keep pull requests focused on one user-visible behavior. Explain the change and
the checks you ran; include a regression test when fixing an incorrect decision
or failure path. Update the relevant user documentation when configuration or
behavior changes. Treat contributors respectfully, discuss technical evidence,
and keep personal information out of public discussions.

## Validation

Keep regression tests for incorrect decisions, malformed inputs, failure behavior,
resource bounds, and install/uninstall behavior. Test package exports and the CLI
from an actual `npm pack` artifact before a release. Validate the plugin with
`claude plugin validate .` after building.

For optional live synthetic checks:

```bash
npm run eval:live -- --live --out /tmp/jev-usher-evaluation.json
npm run eval:claude -- --live --out /tmp/jev-usher-claude.json
```

This uses a TypeSafe key from the environment and has an explicit request budget.
`eval:claude` additionally runs paired tasks through the locally authenticated
Claude CLI. Use `--optimization context|routing|combined`, `--baseline-model`,
`--scenarios`, and `--repeat` to isolate interventions and repeat fixtures. The
script alternates run order and records actual tool-stream replacements and
cache-aware usage. Outputs must be saved outside the checkout.
Do not add customer records, private transcripts, API keys, local test outputs,
scratch notes, or decision logs to the repository. Preserve reproducible test code
and synthetic fixtures here; keep generated evidence elsewhere.

A release needs a clean package install, supported-runtime checks, failure tests,
and a real Claude session confirming the advertised hook behavior. Claims about
cost savings also require comparable completed tasks, fixed model/configuration,
quality checks, retry counts, cache-aware usage, and latency. A green test suite
or a smaller context alone does not establish production readiness. A live
evaluation can consume Claude subscription allowance as well as JEV credits;
run it only with the account owner's authorization.
