# Claude Code

```bash
npx jevusher install            # project  .claude/settings.json
npx jevusher install --global   # user     ~/.claude/settings.json
npx jevusher doctor             # key, connectivity, store contents
npx jevusher report             # what the lenses have actually saved
```

## What gets wired

```
  UserPromptSubmit ──▶ J1 route + J2 gate + J3 memory ──▶ additionalContext
  PostToolUse      ──▶ J7 screen (WebFetch|WebSearch|mcp__.*) ──▶ warning
  Stop             ──▶ J6, inverted, off by default
```

| hook | lens | behaviour |
|---|---|---|
| `UserPromptSubmit` | J1 J2 J3 | Injects the routing hint, the one relevant capability, and the memories that earned a place. **Never blocks a prompt** — a hook that eats prompts when a network call wobbles is worse than no hook. |
| `PostToolUse` | J7 | Warns Claude when web or MCP output is issuing instructions to it. |
| `Stop` | J6 | Not installed by default. See below. |

## Feed it

```
  ~/.claude/jevusher/memory.jsonl     {"id":"mem:1","text":"..."}
  ~/.claude/jevusher/catalog.jsonl    {"id":"git","name":"git","summary":"...","detail":"..."}
  ~/.claude/jevusher/ledger.jsonl     written for you; read by `jevusher report`
```

Override with `JEVUSHER_HOME`, `JEVUSHER_MEMORY`, `JEVUSHER_CATALOG`, `JEVUSHER_LEDGER`.

## What the hooks genuinely cannot do

The honest limits are the useful part.

**`Stop` cannot stop early.** Claude Code's Stop hook can only *refuse to let a turn end*, never
end one. So J6 runs inverted there: it blocks stopping when the goal is clearly unmet. Real early
stopping needs SDK-level control of the loop. Off by default because it fights the agent more
often than it helps. Enable it with `JEVUSHER_GOAL` set and:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "npx --yes jevusher hook stop" }] }] } }
```

**`PreCompact` cannot steer compaction.** It can block it, nothing more. `Compactor` is for custom
agents and SDK loops, not for this hook.

**`PostToolUse` fires after the tool ran**, so it cannot keep output out of the transcript — only
annotate it. J4's real value is in agents you control, where you filter before appending.

**J1 is advisory in a hook.** It injects a suggestion; it does not switch the model for you.

## Timeouts

`UserPromptSubmit` command hooks default to 30s in Claude Code, and a hook that times out has its
output discarded — the prompt still reaches Claude, just without the context. Jev is fast enough
that this is rarely the binding constraint, but a large catalog plus a large memory store means
more batched requests. Watch `jevusher report`'s request counts if turns start feeling slow.
