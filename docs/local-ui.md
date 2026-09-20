# Local test UI

The Jevusher UI compares model routing, context filtering, or both against a
fixed Claude baseline. Its synthetic scenarios cover document and source-code
reads, a fixed terminal command, native search results, filename lists, and a
direct question without tools. Use them to inspect behavior before sending
private project material to a provider.

## Start

Build the checkout with `npm ci` and `npm run check`, then run:

```bash
export JEV_API_KEY='your-typesafe-key'
node bin/jevusher.mjs ui
```

Open `http://127.0.0.1:4318`. Use `--port` to choose another local port:

```bash
node bin/jevusher.mjs ui --port 4320
```

The server binds only to loopback. Keep it local; it is not a hosted multi-user
application. Stop it with Ctrl+C. Starting the server does not call either model.
Claude comparisons require macOS or Linux and Claude Code 2.1.278 or newer.

A configured `JEV_API_KEY` or `TYPESAFE_API_KEY` is used on the server. You can also
enter a key in the UI for that server session. Entered keys go to the local server
and remain in process memory; the server does not return them to the page or save
them in browser storage. Restarting the process discards an entered key.

## Run a comparison

1. Choose a synthetic scenario and review the task and available context.
2. Choose a baseline model and whether to optimize context, model selection, or
   both. Run the JEV preview. Inspect which text survived, what was omitted, and the
   decision confidence. JEV requests spend provider credits; a short context-only
   preview may need no request.
3. Run a paired Claude comparison. Both runs receive the same task and use the
   required native tool against the same source, or answer the direct question without
   tools. Context-only comparisons keep the model fixed. Model-only comparisons
   keep the original context. Combined comparisons enable both optimizations.
   Applicable JEV decisions run afresh; preview decisions are not reused. Each
   Claude run consumes your subscription allowance.
4. Review both answers and their expected facts. Check correctness before using
   token reduction as evidence of a useful result. Download the JSON report if
   you want to retain it outside the repository.

The UI uses the official `claude` executable on your path. The baseline defaults
to Sonnet and can be changed; both runs use low effort. Automatic routing defaults
on in combined comparisons. Sign in through the CLI before testing:

```bash
claude auth login
```

Jevusher does not read or copy Claude's login tokens. Inherited API-key and OAuth
token environment overrides are removed from test subprocesses so the installed
CLI uses its own saved login. The UI cannot supply a Claude subscription or
bypass its limits. If Claude reports an exhausted allowance or an authentication
error, the comparison is incomplete; that is not a passing result.

## Read the results

Selection token counts estimate the size of supplied text. Claude-reported usage
measures a different layer: its requests can also include instructions, output,
and cache activity. Keep cache creation and cache reads visible when comparing
runs. Run order and a warm cache can affect the result.
Successive comparisons alternate which run goes first and report the order.
Admission counts describe the initial tool result, including any recovery notice;
the Claude usage totals include later reads and retries too. The report verifies
that both runs used the complete source and matches any proposed replacement to
its actual Claude tool-result ID. An incomplete source or unconfirmed replacement
does not establish a successful filtering comparison.

Fixture checks require the requested JSON fields and value types, compare exact
expected values, and reject duplicate or extra fields. These checks establish
the fixture's specific facts; they do not establish reliability on other tasks.
Read both answers as well as the check results.

The routing row shows its contribution to JEV usage. The total JEV figures include
both routing and context decisions. A failed provider batch can leave partial
usage unknown; the UI displays it as unavailable rather than zero.

An API-equivalent dollar figure does not measure a change in a subscription fee
or the amount of allowance left. A short synthetic comparison also does not
establish that a plugin helps every real coding task. Use representative tasks,
repeat comparisons, and count recovery requests and failed attempts.

## Data and storage

Only the supplied synthetic scenarios are used. The UI does not search your home
directory, import Claude memories, or crawl your repositories. Routing sends JEV
the task prompt; context checks send the prompt and synthetic source or tool text.
Claude receives its synthetic task input through the official CLI.

The comparison uses an isolated workspace, explicit test settings, a fixed system
prompt, and enforced fixture operations: full source or recovery reads, the exact
`cat fixture.log` command, or the stated native search. It disables normal settings sources, automatic
memory, slash commands, unrelated MCP servers, and session persistence. It does
not run inside your project or change your installed Claude settings.

The server retains at most 30 run records until it exits. Test workspaces and
recovery material are isolated temporary files and are removed after each run
completes or is cancelled. An abrupt machine or process crash can leave temporary files.
A downloaded report is saved by your browser where you choose; inspect it before
sharing. See [data handling](privacy.md) for the library and hook storage policy.

## Troubleshooting

- **Port in use:** stop the other server or choose a different `--port`.
- **JEV unavailable:** check the configured key, provider credits, and connectivity.
  Run `node bin/jevusher.mjs doctor` for a small paid connectivity check.
- **Claude not found:** install the official Claude Code CLI and ensure `claude`
  is available in the terminal that starts the UI.
- **Claude login or allowance error:** resolve it in the official CLI, then retry.
  A partially completed pair must not be counted as a successful comparison.
