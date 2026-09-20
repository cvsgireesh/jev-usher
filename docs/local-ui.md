# Local test UI

The jev-usher UI runs the same task with and without jev-usher so you can compare
both answers. Choose a task and a baseline Claude model, then run the comparison.
All tasks use made-up documents and data; the UI does not inspect your projects.

## Start

Build the checkout with `npm ci` and `npm run check`, then run:

```bash
export JEV_API_KEY='your-typesafe-key'
node bin/jev-usher.mjs ui
```

Open `http://127.0.0.1:4318`. Use `--port` to choose another local port:

```bash
node bin/jev-usher.mjs ui --port 4320
```

The server binds only to loopback. Keep it local; it is not a hosted multi-user
application. Stop it with Ctrl+C. Starting the server does not call either model.
Claude comparisons require macOS or Linux and Claude Code 2.1.278 or newer.

A configured `JEV_API_KEY` or `TYPESAFE_API_KEY` is used on the server. You can also
enter a key under **Connection setup** for that server session. Entered keys go to
the local server and remain in process memory; the server does not return them to the page or save
them in browser storage. Restarting the process discards an entered key.

## Run a comparison

1. Choose a task, such as finding an important rule or understanding a failure.
2. Choose the baseline Claude model. Sonnet is selected by default.
3. Click **Run comparison**. **Without jev-usher** uses the baseline model and
   complete context. **With jev-usher** enables automatic model routing and
   context filtering for the same task. If routing is uncertain or unavailable,
   it keeps your selected baseline model.
4. Read both answers side by side, then compare the measurements below them.
   Check the answers before treating fewer tokens as an improvement.

Each comparison makes two Claude runs and may make JEV calls. Open **Technical
details** to inspect the task, decisions, source checks, and detailed usage, or
download the JSON report. Connection setup and technical details are collapsed
so the main screen stays focused on the two answers.

The UI uses the official `claude` executable on your path. Both runs use low
effort. Sign in through the CLI before testing:

```bash
claude auth login
```

jev-usher does not read or copy Claude's login tokens. Inherited API-key and OAuth
token environment overrides are removed from test subprocesses so the installed
CLI uses its own saved login. The UI cannot supply a Claude subscription or
bypass its limits. If Claude reports an exhausted allowance or an authentication
error, the comparison is incomplete; that is not a passing result.

## Read the results

**Total Claude tokens** includes input, output, cache reads, and cache creation
across the whole run, including later reads and retries. **Elapsed time** includes
startup and, for the jev-usher run, routing and filtering time. A run can use more
tokens or take longer; the comparison shows increases as well as reductions.

**Estimated JEV cost** covers reported JEV usage for routing and context decisions.
If provider usage is incomplete, it stays unknown rather than being shown as zero.
The UI does not turn Claude token counts into a subscription-dollar saving.
Your subscription fee and remaining allowance are different measurements.

Cache activity and run order can affect comparisons. Successive comparisons
alternate which run goes first. The detailed report shows the order, cache
counts, and the actual models used. Source-selection counts are rough estimates
of text size; use whole-run Claude usage to compare the completed runs.

Fixture checks require the requested JSON fields and value types, compare exact
expected values, and reject duplicate or extra fields. These checks establish
the fixture's specific facts; they do not establish reliability on other tasks.
Read both answers as well as the check results.

Technical details verify that both runs used the complete source and match each
proposed replacement to its actual Claude tool result. An incomplete source or
unconfirmed replacement does not establish a successful filtering comparison.
A short synthetic comparison does not establish that jev-usher helps every real
coding task. Repeat comparisons and count recovery requests and failed attempts.

The underlying API still supports JEV previews. The evaluation script can run
separate routing or filtering tests. The main UI uses one combined comparison;
it has no preview step or optimization-mode selector.

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
  Run `node bin/jev-usher.mjs doctor` for a small paid connectivity check.
- **Claude not found:** install the official Claude Code CLI and ensure `claude`
  is available in the terminal that starts the UI.
- **Claude login or allowance error:** resolve it in the official CLI, then retry.
  A partially completed pair must not be counted as a successful comparison.
