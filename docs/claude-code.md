# Claude Code integration

The adapter uses documented command hooks: JSON arrives on stdin and a JSON
object is written to stdout. Diagnostics go to stderr. It does not depend on
reverse-engineered private APIs or generated function-hook declarations.

Use Claude Code 2.1.278 or newer. The local comparison UI checks this minimum;
older clients may ignore replacement output. Rerun comparisons after upgrading.

## Start with automatic routing

```bash
node /absolute/path/to/jevusher/bin/jevusher.mjs claude "Investigate the retry failure"
node /absolute/path/to/jevusher/bin/jevusher.mjs claude --model sonnet "Explain this module"
node /absolute/path/to/jevusher/bin/jevusher.mjs claude --no-route "Continue the investigation"
node /absolute/path/to/jevusher/bin/jevusher.mjs claude "Check the next failure" -- --continue
```

The launcher sends the initial prompt to JEV and selects a Claude model through
the official `--model` option. Confident simple tasks use Haiku, bounded mechanical
work uses Sonnet, and difficult work uses Opus. Both confidence and selected-class
probability must reach 0.9 for routing to be trusted. If JEV is uncertain or
unavailable, the launcher omits the model override so Claude uses its configured
model. Missing keys, timeouts, and oversized routing prompts follow the same rule.

Explicit model arguments, `ANTHROPIC_MODEL`, and resumed conversations retain
their model selection. Use `--no-route` to opt out of routing. Options after `--`
are forwarded to Claude. Authentication, permissions, and settings remain owned
by the official CLI. The launcher enables filtering for its child process unless
`JEVUSHER_FILTER=0` is set; it does not write global settings.

The launcher checks for existing Jevusher hooks before adding its local plugin.
Older settings installations without the recovery guard or current tool matchers
must be updated with `install`, or removed with `uninstall`. When using an
installed plugin, keep that plugin updated as well as the launcher checkout.

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
| `UserPromptSubmit` | `prompt`, configured stores | Optional selected memory and advisory hints; captures session goals when filtering is enabled |
| `PreToolUse` | Native `Edit`/`Write` target and outstanding Read archives | Denies editing from a filtered Read until its complete original has been read |
| `PostToolUse` | `tool_name`, supported `tool_response` | Opt-in result replacement with recovery, or optional screening warning |
| `Stop` | `last_assistant_message`, `stop_hook_active`, configured goal | May return `decision: block` to request continuation; not installed |

No prompt evaluation runs if both stores are empty. Filtering may still capture
the prompt locally for later tool-result relevance checks. Prompt hooks do not
switch Claude's model or hide existing skill/tool schemas. The launcher controls
the model only at startup. `Stop` evaluates the
last response, not independent execution evidence; it is unsuitable as a release
approval mechanism. It stands down when already active or when the judgment says
the agent should stop. An optional installation must set `JEVUSHER_GOAL`.

### Recoverable tool-output filtering

The launcher enables filtering. For a directly loaded plugin or settings hooks,
enable it in the environment inherited by Claude:

```bash
export JEVUSHER_FILTER=1
claude --plugin-dir /absolute/path/to/jevusher
```

The adapter filters supported text `Read` results, including documents, source
code, and configuration files such as `.ts`, `.js`, `.py`, `.go`, `.rs`, `.json`,
`.yaml`, and `.toml`.
It excludes instruction, memory, and skill files, `.claude`, `.agents`, and
`.codex` paths, and its own recovery files, including symlink aliases. Error,
binary, and unknown output shapes pass through.

Supported native outputs also include:

- `Bash`: stdout from recognized simple diagnostic commands, such as `cat`,
  `rg`, Git inspection, and test commands. Compound or unknown commands, stderr,
  error/warning signals, images, and recognized credential output pass through.
  This operates after execution; it does not authorize commands or make scripts
  read-only.
- `Grep`: text matches with source locations or filename results. Aggregate count
  output passes through. Returned totals and other metadata remain intact.
- `Glob`: filename lists. Omitted paths remain in the recovery copy; returned
  lists are marked truncated and contain only actual paths.

Limit native filtering with `JEVUSHER_FILTER_NATIVE`, a comma-separated list.
The default is `Read,Bash,Grep,Glob`. For example,
`JEVUSHER_FILTER_NATIVE=Read,Grep` leaves Bash and Glob unchanged. An empty value
disables native filtering. MCP tools use their separate allowlist.

To also permit specific read-only MCP tools, use their exact names:

```bash
export JEVUSHER_FILTER_TOOLS='mcp__docs__fetch'
```

Only MCP responses containing a single text block and no structured or media
content are eligible. Choose tools whose output is safe to shorten. The allowlist
does not make a tool read-only or undo its side effects.

The hook uses prompts captured from `UserPromptSubmit` in the same session and
working directory. It accumulates up to 8 KB of user goals, valid for 24 hours
after the last captured prompt, and passes through when the goal is missing,
expired, or too large. Subagent calls are not filtered. Start a fresh session
after enabling filtering so the first
prompt can establish its goal.

Only outputs between 4 KB and 120 KB are considered, in at most 64 whole-line
chunks. A chunk is eligible for omission only with relevance score at most 0.1,
confidence at least 0.9, and probability of unrelated text at least 0.95.
Ambiguous chunks remain. A `Read` replacement retains one contiguous source
window with its line numbers and source metadata. Replacement requires a
reduction of at least 20% and 1 KB, including the recovery notice.

Before replacing any output, the hook saves the original text under:

```text
~/.claude/jevusher/recovery/<session-hash>/<id>.txt
```

`JEVUSHER_HOME` changes that root. The result includes the absolute recovery path
and tells Claude to read it if omitted information is needed, or before edits and
complete summaries. Recovery files bypass filtering. You can read the path
yourself to inspect the complete original. If saving fails, the original result
passes through unchanged.

After a filtered Read, Jevusher records a recovery requirement for that source.
Native `Edit` and `Write` calls are denied until Claude reads the complete,
byte-identical archived original from its beginning. Partial archive reads do
not clear the requirement. Repeated source reads pass through while a recovery
requirement is outstanding. This guard does not intercept edits performed by
shell commands or external tools. Excerpts are for inspection; recover before
making changes or drawing conclusions about an entire file.

Session and recovery directories must be real owner-only directories (mode
`0700`); otherwise filtering passes through. Newly created originals use mode
`0600`.

These files are private local copies of tool output. They remain until you delete
them so recovery references keep working. Do not remove a recovery file while an
active conversation may need it. See [data handling](privacy.md) before filtering
private material.

This is relevance selection, not a security filter. A confidently wrong omission
can still remove a necessary fact. Evaluate representative tasks with and without
filtering, including tasks that require recovery.

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
older `updatedMCPToolOutput` field is MCP-specific. Jevusher emits replacements
only for the narrow formats described above. The tool has already executed, and
telemetry may already contain its original output.

`PreToolUse` can deny or modify a call before execution. `PreCompact` can veto
compaction but does not document a replacement-history field. `Stop` runs after
Claude finishes responding; blocking it requests more work, not early termination.
The project makes no compatibility claim for undocumented function-hook APIs.
[Authoritative hooks contract](https://code.claude.com/docs/en/hooks)

Jevusher leaves native compaction, prompt caching, skill loading, MCP tool search,
and effort settings under Claude's control. It does not rewrite the system prompt,
route subagents, or change the main model between turns. The library's compaction
and capability decisions require an application that owns those inputs.

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
