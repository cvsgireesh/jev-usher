# Contributing

Use a current Node 22 or 24 release and `npm ci`, then run `npm run check`.
Tests use fake providers and make no API calls. Examples are included in typechecks.

Keep regression tests for incorrect decisions, malformed inputs, failure behavior,
resource bounds, and install/uninstall behavior. Test package exports and the CLI
from an actual `npm pack` artifact before a release. Validate the plugin with
`claude plugin validate .` after building.

For optional live synthetic checks:

```bash
npm run eval:live -- --live --out /tmp/jevusher-evaluation.json
```

This uses a TypeSafe key from the environment and has an explicit request budget.
Do not add customer records, private transcripts, API keys, local test outputs,
scratch notes, or decision logs to the repository. Preserve reproducible test code
and synthetic fixtures here; keep generated evidence elsewhere.

A release needs a clean package install, supported-runtime checks, failure tests,
and a real Claude session confirming the advertised hook behavior. Claims about
cost savings also require comparable completed tasks, fixed model/configuration,
quality checks, retry counts, cache-aware usage, and latency. A green test suite
or a smaller context alone does not establish production readiness.
