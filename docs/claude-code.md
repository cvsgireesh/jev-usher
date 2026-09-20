# Claude Code integration

The adapter uses documented command hooks: JSON arrives on stdin and a JSON
object is written to stdout. Diagnostics go to stderr. It does not depend on
reverse-engineered private APIs or generated function-hook declarations.

## Install and remove

Build first with `npm ci && npm run check`. Load the checkout with:

```bash
claude --plugin-dir /absolute/path/to/jevusher
```

The plugin manifest is `.claude-plugin/plugin.json`; hooks are in
`hooks/hooks.json`. The runtime is built to `dist/`. A raw Git checkout without a
build is not an installable runtime. For a packaged copy, `dist/` is included.

Alternatively run `node /absolute/path/to/jevusher/bin/jevusher.mjs install` from
the target project. Add `--global` for user settings. `uninstall` with the same
scope removes only Jevusher handlers. Do not enable both the plugin and settings
hooks. Settings installation supports macOS/Linux and writes quoted absolute
paths, so reinstall after moving the executable.

Installation preserves unrelated settings and hooks, backs up an existing file,
rejects malformed settings, and writes atomically. Backups use the suffix
`.jevusher-backup-<id>` beside the settings file. No credential is written there.

## Configure explicit inputs

```text
~/.claude/jevusher/memory.jsonl
~/.claude/jevusher/catalog.jsonl
~/.claude/jevusher/ledger.jsonl
```

Example memory line:

```json
{"id":"runtime","text":"The widget service must retain Node 20 support."}
```

Example capability line:

```json
{"id":"git","name":"git","summary":"Inspect commits, history, branches, and diffs."}
```

IDs must be unique. Set `JEV_API_KEY` or `TYPESAFE_API_KEY` in the environment
inherited by Claude. Optional paths: `JEVUSHER_HOME`, `JEVUSHER_MEMORY`,
`JEVUSHER_CATALOG`, `JEVUSHER_LEDGER`. `JEVUSHER_MODEL` overrides the pinned JEV
version for hooks. Stores above 8 MB must be reduced or rotated.

The adapter does not discover or modify Claude's auto memory, `CLAUDE.md`, rules,
installed skill files, or third-party memory databases. Its own memory file is a
separate input. Claude loads project instructions and memory through its own
lifecycle. Skill descriptions and invoked skill bodies likewise have different
loading behavior; adding a capability hint does not replace either.
[Memory reference](https://code.claude.com/docs/en/memory) ·
[Skills reference](https://code.claude.com/docs/en/skills)

Claude's MCP tool search defers tool definitions by default, subject to provider
and configuration support. Prompt caching also changes the cost of repeated
context. A Jevusher comparison must preserve those native features in the
baseline; a full-catalog replay is not equivalent to a normal Claude session.
[MCP tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search) ·
[Cost accounting](https://code.claude.com/docs/en/costs)

## Hook contract

| Event | Input used | Output and effect |
|---|---|---|
| `UserPromptSubmit` | `prompt`, configured stores | `hookSpecificOutput.additionalContext`: selected memory and advisory hints |
| `PostToolUse` | `tool_name`, text in `tool_response` | Optional warning in `additionalContext`; no replacement |
| `Stop` | `last_assistant_message`, `stop_hook_active`, configured goal | May return `decision: block` to request continuation; not installed |

No prompt evaluation runs if both stores are empty. It does not automatically
switch Claude's model or hide existing skill/tool schemas. `Stop` evaluates the
last response, not independent execution evidence; it is unsuitable as a release
approval mechanism. It stands down when already active or when the judgment says
the agent should stop. An optional installation must set `JEVUSHER_GOAL`.

### External screening

Screening is off by default. To send web output for screening:

```bash
export JEVUSHER_SCREEN=1
```

MCP tools require an additional exact-name, comma-separated allowlist:

```bash
export JEVUSHER_MCP_TOOLS='mcp__docs__search,mcp__docs__fetch'
```

MCP syntax is `mcp__<server>__<tool>`. Wildcards in this environment variable do
not match. Only recognized text fields and MCP text blocks are extracted; image
or binary blocks are not sent. Outputs over 24,000 UTF-8 bytes get an unavailable
warning rather than a truncated screening pass. Short outputs are screened too:
a short injection can still matter. A classifier warning does not undo a tool
call, hide its output, or enforce a permission decision.

### Platform capabilities versus this implementation

Current Claude Code documents `PostToolUse.hookSpecificOutput.updatedToolOutput`
for replacing a result before the next model reads it. Replacements must match
the tool's output shape; invalid built-in tool replacements are ignored. The
older `updatedMCPToolOutput` field is MCP-specific. This repository does **not**
yet emit either replacement field. The tool has already executed, and telemetry
may already contain its original output.

`PreToolUse` can deny or modify a call before execution. `PreCompact` can veto
compaction but does not document a replacement-history field. `Stop` runs after
Claude finishes responding; blocking it requests more work, not early termination.
The project makes no compatibility claim for undocumented function-hook APIs.
[Authoritative hooks contract](https://code.claude.com/docs/en/hooks)

## Failure and verification

Hook input is capped at 2 MB. Provider failures do not block user prompts. Network
work has a 15-second shared deadline and 5-second per-request limit without
retries; installed hook timeouts are 20 seconds. Ledger-write errors cannot
suppress a successful memory result or screening warning.

`doctor` makes a tiny synthetic provider call and exits nonzero on failure.
`report` reads local counts only. Offline tests verify stdin/stdout behavior,
installation, and failure cases; plugin validation checks packaging. These checks
do not prove that a particular Claude build consumes every emitted field, nor
that the plugin improves completed-task cost or quality. Test an isolated real
Claude session before adopting it in ongoing work.
