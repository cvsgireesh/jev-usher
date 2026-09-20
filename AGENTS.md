# Working on jev-usher

jev-usher is a TypeScript library, Claude Code launcher and command-hook adapter,
and local test UI for model routing and context admission with TypeSafe JEV. Read [README.md](README.md) for
the supported behavior and [docs/architecture.md](docs/architecture.md) for the
provider, policy, and caller boundaries.

## Development

Use a current Node 22 or 24 release. Runtime support starts at Node 20.

```bash
npm ci
npm run check
npm run test:package
```

`check` typechecks source, tests, and examples; runs offline tests; then builds
`dist/`. Package smoke tests build a tarball and install it into an isolated
directory. Do not edit generated `dist/` files. Run `claude plugin validate .`
when changing plugin packaging, if the Claude CLI is available.

Live tests require an explicit user request and use paid JEV calls or Claude
subscription allowance. Use synthetic inputs by default. Never discover or
upload personal transcripts, memories, skill directories, or credentials as
test data. Save generated results outside the repository.

## Code map

- `src/client.ts`, `src/types.ts`, `src/validation.ts`: typed provider contract,
  HTTP transport, and validation.
- `src/usher.ts`, `src/filter.ts`, `src/gate.ts`, `src/route.ts`,
  `src/compact.ts`, `src/screen.ts`, `src/stop.ts`: decision policies.
- `src/pipeline.ts`, `src/ledger.ts`: composition and estimated accounting.
- `src/hook.ts`, `src/install.ts`, `src/cli.ts`, `hooks/`, `.claude-plugin/`:
  Claude integration and installation.
- `src/admission.ts`, `src/recovery.ts`, `src/read-guard.ts`: conservative
  tool-text selection, captured session goals, original-output storage, and
  recovery requirements before native edits.
- `src/launch.ts`: bounded model selection shared by the launcher and UI,
  explicit model overrides, and official Claude CLI startup.
- `src/ui-server.ts`, `src/lab.ts`, `src/claude-runner.ts`, `ui/`: local UI and
  isolated Claude comparisons. `src/lab-scenarios.ts` contains synthetic fixtures.
- `tests/`: offline regression and boundary tests.
- `scripts/`: reproducible package and synthetic live checks.
- `docs/reference.md`: public library API.

## Invariants

- JEV judges text. Deterministic code owns authorization, resource bounds,
  fallbacks, and execution. A confident answer is not proof of correctness.
- Keep the pinned JEV version unless a version change is explicitly in scope.
  Validate provider responses before applying decisions.
- Keep original tool output recoverable before replacing it. Unsupported
  formats, malformed decisions, or provider failures must leave the original
  result available.
- Do not bypass Claude permissions, read private authentication tokens, or
  depend on undocumented Claude internals. Command hooks must use the documented
  JSON contract and keep diagnostics off stdout.
- Launcher routing applies only to new sessions. Preserve explicit model choices
  and resumed conversations. Uncertain or unavailable routing must omit the model
  override so Claude retains its configured model. The UI keeps its selected
  baseline model when routing is uncertain or unavailable.
- Keep the local UI on loopback. Never return configured API keys to the browser
  or put them in URLs, logs, or browser storage. Do not add telemetry.
- Distinguish estimated text reduction, actual model usage, task correctness,
  API cost estimates, and subscription allowance. Do not label estimates as
  measured savings.
- Keep the legacy `JEVUSHER_*` environment variables and private storage paths
  compatible. Renaming the public package must not break recovery references.
- Keep API keys, run outputs, private notes, test transcripts, and development
  narratives out of Git. Commit executable tests and synthetic fixtures.

Use [CONTRIBUTING.md](CONTRIBUTING.md) for validation expectations and
[SECURITY.md](SECURITY.md) for vulnerability reporting.
