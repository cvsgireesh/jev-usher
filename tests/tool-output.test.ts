import { afterEach, describe, expect, it } from 'vitest';
import { eligibleShellCommand, toolOutput } from '../src/tool-output.js';

afterEach(() => { delete process.env.JEVUSHER_FILTER_NATIVE; });
describe('native output adapters', () => {
  it('keeps compound, unknown, and credential-reading shell commands out of admission', () => {
    for (const command of ['npm install', 'rm file', 'cat .env', 'cat ".env"', "cat 'CLAUDE.md'", 'cat ~/.ssh/id_rsa', 'cat ~/.claude/CLAUDE.md', 'cat AGENTS.md', 'git diff --output=file', 'cat log | tail', 'cat $(whoami)', 'node script.mjs', 'rg --pre script value']) expect(eligibleShellCommand(command), command).toBe(false);
    for (const command of ['cat build.log', 'npm test -- --run', 'git diff --stat', 'rg widget src', 'pytest -q', 'go test ./...']) expect(eligibleShellCommand(command), command).toBe(true);
  });

  it('preserves Bash metadata and bypasses diagnostic failures or possible secrets', () => {
    const response = { stdout: 'All tasks completed.', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
    const input = { tool_name: 'Bash', tool_input: { command: 'cat build.log' }, tool_response: response };
    expect(toolOutput(input)?.replace('shorter', 1)).toEqual({ ...response, stdout: 'shorter' });
    for (const patch of [{ stderr: 'warning' }, { stdout: 'ERROR unexpected state' }, { stdout: 'api_key=private' }, { exitCode: 1 }, { isImage: true }]) expect(toolOutput({ ...input, tool_response: { ...response, ...patch } })).toBeNull();
  });

  it('preserves grep totals and source line labels, and leaves aggregate count mode alone', () => {
    const response = { mode: 'content', numFiles: 0, filenames: [], content: 'src/a.ts:5:yes\nsrc/b.ts:7:no', numLines: 2, totalLines: 2 };
    const output = toolOutput({ tool_name: 'Grep', tool_response: response });
    expect(output?.replace('src/a.ts:5:yes', 1)).toEqual({ ...response, content: 'src/a.ts:5:yes', numLines: 1 });
    expect(toolOutput({ tool_name: 'Grep', tool_response: { mode: 'count', numMatches: 19 } })).toBeNull();
    expect(toolOutput({ tool_name: 'Grep', tool_input: { path: '.' }, tool_response: { ...response, content: 'AGENTS.md:5:Keep these instructions' } })).toBeNull();
    expect(toolOutput({ tool_name: 'Grep', tool_response: { ...response, numFiles: 1, filenames: [42] } })).toBeNull();
    expect(toolOutput({ tool_name: 'Grep', tool_response: { ...response, totalLines: '2' } })).toBeNull();
  });

  it('never inserts marker strings into returned file paths', () => {
    const response = { filenames: ['a.ts', 'b.ts', 'c.ts'], numFiles: 3, truncated: false, totalMatches: 3, countIsComplete: true, durationMs: 1 };
    const output = toolOutput({ tool_name: 'Glob', tool_response: response });
    expect(output?.replace('a.ts\n[jevusher: omitted]\nc.ts', 1)).toEqual({ ...response, filenames: ['a.ts', 'c.ts'], numFiles: 2, truncated: true });
    expect(toolOutput({ tool_name: 'Glob', tool_response: { ...response, filenames: ['a\nb'] } })).toBeNull();
  });

  it('honors a native tool allowlist independently of MCP permission', () => {
    process.env.JEVUSHER_FILTER_NATIVE = 'Read';
    expect(toolOutput({ tool_name: 'Glob', tool_response: { filenames: ['a'], numFiles: 1 } })).toBeNull();
  });
});
