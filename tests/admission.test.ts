import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from 'node:crypto';
import { filterText } from "../src/admission.js";
import { Jevusher } from "../src/pipeline.js";
import { onPostToolUse, onPreToolUse, onUserPromptSubmit, type HookInput } from "../src/hook.js";
import { isRecoveryPath, recallPrompt, rememberPrompt, saveOriginal } from "../src/recovery.js";
import type { Answer, Candidate } from "../src/types.js";
import { stub } from "./helpers.js";

const paragraph = (label: string): string => `${Array.from({ length: 10 }, (_, i) => `${label} entry ${i}: ${"detail ".repeat(20)}`).join("\n")}\n\n`;
const noise = paragraph("UNRELATED cafeteria menu");
const relevant = paragraph("RELEVANT refund exception: receipt JA-2049");
const text = noise + relevant + noise;
const judgement = (value: number, confidence = 0.99): Answer => ({
  type: "score", score: value, confidence, legend: { "0": "irrelevant", "1": "possible", "2": "needed" },
  probabilities: value === 0 ? { "0": 1, "1": 0, "2": 0 } : { "0": 0, "1": 0, "2": 1 },
});
const provider = () => stub(request => Object.fromEntries((request.state as { candidates: Candidate[] }).candidates.map((c, i) => [`c${i}`, judgement(c.text.includes("RELEVANT refund") ? 2 : 0)])));

describe("conservative tool text admission", () => {
  it("keeps exact source lines in one contiguous window for Read", async () => {
    const result = await filterText({ text, goal: "Find the refund exception", provider: provider(), contiguous: true });
    expect(result.changed).toBe(true);
    expect(result.text).toBe(relevant);
    expect(result.startLine).toBe(noise.split("\n").length);
    expect(result.chunks.map(c => c.text).join("")).toBe(text);
    expect(result.usage.input_tokens).toBe(100);
  });

  it("never erases an entire result even if every chunk is scored irrelevant", async () => {
    const result = await filterText({ text, goal: "An ambiguous task", provider: stub(r => Object.fromEntries(Object.keys(r.questions).map(k => [k, judgement(0)]))) });
    expect(result.text).toBe(text);
    expect(result.changed).toBe(false);
  });

  it("preserves internal unrelated sections for line-correct contiguous results", async () => {
    const result = await filterText({ text: noise + relevant + noise + relevant + noise, goal: "refund exceptions", provider: provider(), contiguous: true });
    expect(result.text).toBe(relevant + noise + relevant);
  });

  it("marks omitted source ranges in noncontiguous results", async () => {
    const result = await filterText({ text: relevant + noise + noise + relevant, goal: "refund exceptions", provider: provider() });
    expect(result.changed).toBe(true);
    expect(result.text).toContain("source lines 12-33 omitted");
    expect(result.text).not.toContain("cafeteria");
  });

  it("keeps uncertain, missing, and failed evaluations unchanged", async () => {
    for (const p of [stub(r => Object.fromEntries(Object.keys(r.questions).map(k => [k, judgement(0, 0.5)]))), stub(() => ({})), stub(() => ({}), { failWith: new Error("offline") })]) {
      const result = await filterText({ text, goal: "refund exception", provider: p });
      expect(result.text).toBe(text);
      expect(result.changed).toBe(false);
    }
    expect((await filterText({ text, goal: "refund", provider: stub(() => ({}), { failWith: new Error("offline") }) })).reason).toBe("unavailable");
  });

  it("does not evaluate tiny/huge text, oversized lines, or oversized goals", async () => {
    const p = provider();
    for (const value of ["tiny", "x".repeat(120_001), "x".repeat(8_001) + "\n" + relevant]) {
      expect((await filterText({ text: value, goal: "refund", provider: p })).changed).toBe(false);
    }
    expect((await filterText({ text, goal: "x".repeat(8_001), provider: p })).changed).toBe(false);
    expect(p.requests).toHaveLength(0);
  });

  it("preserves CRLF and non-ASCII source content", async () => {
    const input = (noise + relevant.replace("JA-2049", "JA-2049 ✅ café") + noise).replaceAll("\n", "\r\n");
    const result = await filterText({ text: input, goal: "refund", provider: provider(), contiguous: true });
    expect(result.changed).toBe(true);
    expect(input).toContain(result.text);
    expect(result.text).toContain("✅ café");
    expect(result.text).toContain("\r\n");
  });
});

describe("recoverable Claude tool hook", () => {
  let directory: string;
  let home: string;
  const saved = { ...process.env };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "jevusher-admission-"));
    home = join(directory, "private");
    process.env.JEVUSHER_HOME = home;
    process.env.JEVUSHER_LEDGER = join(home, "ledger.jsonl");
    process.env.JEVUSHER_FILTER = "1";
    delete process.env.JEVUSHER_SCREEN;
    delete process.env.JEVUSHER_FILTER_TOOLS;
  });
  afterEach(async () => { process.env = { ...saved }; await rm(directory, { recursive: true, force: true }); });

  const event = (directory: string): HookInput => ({
    session_id: "session-one", cwd: directory, hook_event_name: "PostToolUse", tool_name: "Read",
    tool_input: { file_path: join(directory, "evidence.txt") },
    tool_response: { type: "text", file: { filePath: join(directory, "evidence.txt"), content: text, startLine: 11, numLines: text.split("\n").length, totalLines: 200 } },
  });
  async function prompt() { await onUserPromptSubmit({ session_id: "session-one", cwd: directory, prompt: "Find the refund exception" }); }

  it("captures a prompt without a memory/catalog store and replaces a real Read shape", async () => {
    await prompt();
    const output = await onPostToolUse(event(directory), new Jevusher({ provider: provider() }));
    const replacement = output.hookSpecificOutput?.updatedToolOutput as { file: { content: string; startLine: number; numLines: number; totalLines: number } };
    expect(replacement.file.content).toBe(relevant.slice(0, -1));
    expect(replacement.file.startLine).toBe(22);
    expect(replacement.file.numLines).toBe(relevant.split("\n").length - 1);
    expect(replacement.file.totalLines).toBe(200);
    const originalLines = text.split('\n');
    replacement.file.content.split('\n').forEach((line, index) => {
      expect(line).toBe(originalLines[replacement.file.startLine - 11 + index]);
    });
    const sessions = await readdir(join(home, "recovery"));
    const paths = await readdir(join(home, "recovery", sessions[0]!));
    const archive = join(home, "recovery", sessions[0]!, paths[0]!);
    expect(await readFile(archive, "utf8")).toBe(text);
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect(output.hookSpecificOutput?.additionalContext).toContain(JSON.stringify(archive));
    const ledger = JSON.parse((await readFile(join(home, "ledger.jsonl"), "utf8")).trim());
    expect(ledger.lens).toBe("hook-filter");
    expect(ledger.admitted).toBeLessThan(ledger.offered);
  });

  it("requires filter opt-in, scoped prompt, matching cwd, main agent, and successful event", async () => {
    const p = provider();
    const pipeline = new Jevusher({ provider: p });
    expect(await onPostToolUse(event(directory), pipeline)).toEqual({});
    await prompt();
    delete process.env.JEVUSHER_FILTER;
    expect(await onPostToolUse(event(directory), pipeline)).toEqual({});
    process.env.JEVUSHER_FILTER = "1";
    for (const patch of [{ cwd: "/different" }, { agent_id: "a-subagent" }, { hook_event_name: "PostToolUseFailure" }, { session_id: "different" }]) {
      expect(await onPostToolUse({ ...event(directory), ...patch }, pipeline)).toEqual({});
    }
    expect(p.requests).toHaveLength(0);
  });

  it("leaves code, instructions, errors, nontext and unknown schemas untouched", async () => {
    await prompt();
    const p = provider();
    const pipeline = new Jevusher({ provider: p });
    for (const name of ["image.png", "CLAUDE.md", "AGENTS.md", "SKILL.md", "MEMORY.md", ".claude/rules/project.md"]) {
      const input = event(directory);
      const path = join(directory, name);
      input.tool_input = { file_path: path };
      (input.tool_response as { file: { filePath: string } }).file.filePath = path;
      expect(await onPostToolUse(input, pipeline)).toEqual({});
    }
    for (const response of [{ isError: true }, { type: "image", file: {} }, { content: text }, { ...event(directory).tool_response as object, error: "failed" }]) {
      expect(await onPostToolUse({ ...event(directory), tool_response: response }, pipeline)).toEqual({});
    }
    expect(p.requests).toHaveLength(0);
  });

  it("requires separate exact MCP opt-in and preserves all other output metadata", async () => {
    await prompt();
    const p = provider();
    const pipeline = new Jevusher({ provider: p });
    const input = { ...event(directory), tool_name: "mcp__docs__search", tool_response: { content: [{ type: "text", text }], isError: false, _meta: { resource: "docs" } } };
    process.env.JEVUSHER_MCP_TOOLS = input.tool_name;
    expect(await onPostToolUse(input, pipeline)).toEqual({});
    process.env.JEVUSHER_FILTER_TOOLS = `${input.tool_name}Extra`;
    expect(await onPostToolUse(input, pipeline)).toEqual({});
    process.env.JEVUSHER_FILTER_TOOLS = input.tool_name;
    const output = await onPostToolUse(input, pipeline);
    expect(output.hookSpecificOutput?.updatedToolOutput).toMatchObject({ isError: false, _meta: { resource: "docs" } });
    expect(output.hookSpecificOutput?.updatedToolOutput).not.toEqual(input.tool_response);
  });

  it("does not filter MCP structured content, media, multiple blocks or errors", async () => {
    await prompt();
    process.env.JEVUSHER_FILTER_TOOLS = "mcp__docs__search";
    const p = provider();
    for (const response of [
      { content: [{ type: "text", text }], structuredContent: {} },
      { content: [{ type: "text", text }, { type: "image", data: "private" }] },
      { content: [{ type: "text", text, annotations: { audience: ["user"] } }] },
      { content: [{ type: "text", text }], isError: true },
      [{ type: "text", text }, { type: "image", data: "private" }],
      [{ type: "text", text, annotations: { audience: ["user"] } }],
    ]) expect(await onPostToolUse({ ...event(directory), tool_name: "mcp__docs__search", tool_response: response }, new Jevusher({ provider: p }))).toEqual({});
    expect(p.requests).toHaveLength(0);
  });

  it("preserves the native Claude MCP content-array shape when replacing text", async () => {
    await prompt();
    process.env.JEVUSHER_FILTER_TOOLS = "mcp__docs__search";
    const input = { ...event(directory), tool_name: "mcp__docs__search", tool_response: [{ type: "text", text }] };
    const result = await onPostToolUse(input, new Jevusher({ provider: provider() }));
    expect(result.hookSpecificOutput?.updatedToolOutput).toEqual([{ type: "text", text: expect.stringContaining("receipt JA-2049") }]);
    expect(JSON.stringify(result.hookSpecificOutput?.updatedToolOutput)).not.toContain("cafeteria");
    expect(result.hookSpecificOutput?.additionalContext).toContain("complete original");
  });

  it("marks provider-unavailable accounting as incomplete instead of reporting a free successful test", async () => {
    await prompt();
    const result = await onPostToolUse(event(directory), new Jevusher({ provider: stub(() => ({}), { failWith: new Error("offline") }) }));
    expect(result).toEqual({});
    const ledger = JSON.parse((await readFile(join(home, "ledger.jsonl"), "utf8")).trim());
    expect(ledger).toMatchObject({ lens: "hook-filter", filterUnavailable: true, usageIncomplete: true });
    expect(ledger.admitted).toBe(ledger.offered);
  });

  it("never recursively filters direct or aliased recovery reads", async () => {
    await prompt();
    const path = await saveOriginal("session-one", text);
    const alias = join(directory, "alias.txt");
    await symlink(path, alias);
    expect(await isRecoveryPath(path)).toBe(true);
    expect(await isRecoveryPath(alias)).toBe(true);
    const p = provider();
    for (const readPath of [path, alias]) {
      const input = event(directory);
      input.tool_input = { file_path: readPath };
      (input.tool_response as { file: { filePath: string } }).file.filePath = readPath;
      expect(await onPostToolUse(input, new Jevusher({ provider: p }))).toEqual({});
    }
    expect(p.requests).toHaveLength(0);
  });

  it("fails open if private recovery storage is unwritable or replaced with a symlink", async () => {
    await prompt();
    await symlink(directory, join(home, "recovery"));
    expect(await onPostToolUse(event(directory), new Jevusher({ provider: provider() }))).toEqual({});
  });

  it("retains prior user constraints and disables admission if prompt history overflows", async () => {
    await rememberPrompt("s", directory, "Keep receipt codes exact");
    await rememberPrompt("s", directory, "Find refund exceptions");
    expect(await recallPrompt("s", directory)).toContain("Keep receipt codes exact");
    await rememberPrompt("s", directory, "x".repeat(8_001));
    expect(await recallPrompt("s", directory)).toBeNull();
    await rememberPrompt("s", directory, "continue");
    expect(await recallPrompt("s", directory)).toBeNull();
  });

  it("never deletes a file through a symlinked prompt-storage directory", async () => {
    await prompt();
    const sessionDirectory = join(home, 'sessions');
    await rm(sessionDirectory, { recursive: true });
    const filename = createHash('sha256').update('outside-session').digest('hex') + '.json';
    const outsideFile = join(directory, filename);
    await writeFile(outsideFile, 'untouched outside storage');
    await symlink(directory, sessionDirectory);
    await expect(rememberPrompt('outside-session', directory, 'new request')).rejects.toThrow();
    expect(await readFile(outsideFile, 'utf8')).toBe('untouched outside storage');
  });

  it("expires saved goals after 24 hours", async () => {
    await prompt();
    const [name] = await readdir(join(home, "sessions"));
    const path = join(home, "sessions", name!);
    const value = JSON.parse(await readFile(path, "utf8"));
    value.at = Date.now() - 86_400_001;
    await writeFile(path, JSON.stringify(value));
    expect(await recallPrompt("session-one", directory)).toBeNull();
  });

  it("supports source/config Reads and guards native edits until the full original is recovered", async () => {
    await prompt();
    const source = join(directory, 'service.ts');
    await writeFile(source, text);
    const input = event(directory);
    input.tool_input = { file_path: source };
    (input.tool_response as { file: { filePath: string } }).file.filePath = source;
    const output = await onPostToolUse(input, new Jevusher({ provider: provider() }));
    expect(output.hookSpecificOutput?.updatedToolOutput).toBeDefined();
    const edit = { session_id: 'session-one', tool_name: 'Edit', tool_input: { file_path: source, old_string: 'old', new_string: 'new' } };
    const blocked = await onPreToolUse(edit);
    expect(blocked.hookSpecificOutput?.permissionDecision).toBe('deny');
    const archive = JSON.parse(blocked.hookSpecificOutput!.permissionDecisionReason!.match(/("[^"\n]+\.txt")/)![1]!);
    const recovered = { ...event(directory), tool_input: { file_path: archive }, tool_response: { type: 'text', file: { filePath: archive, content: text, startLine: 1, numLines: text.split('\n').length, totalLines: text.split('\n').length } } };
    expect(await onPostToolUse(recovered, new Jevusher({ provider: provider() }))).toEqual({});
    expect(await onPreToolUse(edit)).toEqual({});
    expect(await onPreToolUse({ ...edit, tool_name: 'Write' })).toEqual({});
  });

  it("does not release a guard for partial, altered, or wrong-session recovery", async () => {
    await prompt();
    const source = join(directory, 'configuration.json');
    await writeFile(source, text);
    const input = event(directory);
    input.tool_input = { file_path: source };
    (input.tool_response as { file: { filePath: string } }).file.filePath = source;
    await onPostToolUse(input, new Jevusher({ provider: provider() }));
    const edit = { session_id: 'session-one', tool_name: 'Write', tool_input: { file_path: source } };
    const blocked = await onPreToolUse(edit);
    const archive = JSON.parse(blocked.hookSpecificOutput!.permissionDecisionReason!.match(/("[^"\n]+\.txt")/)![1]!);
    for (const patch of [{ content: text.slice(0, 200), startLine: 1, session: 'session-one' }, { content: text, startLine: 2, session: 'session-one' }, { content: text, startLine: 1, session: 'other-session' }]) {
      await onPostToolUse({ session_id: patch.session, tool_name: 'Read', tool_response: { type: 'text', file: { filePath: archive, content: patch.content, startLine: patch.startLine } } });
      expect((await onPreToolUse(edit)).hookSpecificOutput?.permissionDecision).toBe('deny');
    }
    expect(await onPreToolUse({ ...edit, session_id: 'other-session' })).toEqual({});
    expect(await onPreToolUse({ ...edit, tool_input: { file_path: join(directory, 'unrelated.json') } })).toEqual({});
    expect(await onPreToolUse({ ...edit, tool_name: 'Bash', tool_input: { command: 'echo does-not-use-native-edit' } })).toEqual({});
  });

  it("applies edit protection through source symlinks and keeps guard state private", async () => {
    await prompt();
    const source = join(directory, 'real.py');
    const alias = join(directory, 'alias.py');
    await writeFile(source, text);
    await symlink(source, alias);
    const input = event(directory);
    input.tool_input = { file_path: alias };
    (input.tool_response as { file: { filePath: string } }).file.filePath = alias;
    await onPostToolUse(input, new Jevusher({ provider: provider() }));
    expect((await onPreToolUse({ session_id: 'session-one', tool_name: 'Edit', tool_input: { file_path: source } })).hookSpecificOutput?.permissionDecision).toBe('deny');
    const [session] = await readdir(join(home, 'read-guards'));
    const [name] = await readdir(join(home, 'read-guards', session!));
    expect((await stat(join(home, 'read-guards', session!, name!))).mode & 0o777).toBe(0o600);
  });

  it("keeps Read unmodified if guard storage cannot be saved", async () => {
    await prompt();
    await symlink(directory, join(home, 'read-guards'));
    expect(await onPostToolUse(event(directory), new Jevusher({ provider: provider() }))).toEqual({});
  });

  it("uses the native tool opt-in list and does not repeatedly filter an unrecovered source", async () => {
    await prompt();
    process.env.JEVUSHER_FILTER_NATIVE = 'Bash,Grep';
    const p = provider();
    expect(await onPostToolUse(event(directory), new Jevusher({ provider: p }))).toEqual({});
    expect(p.requests).toHaveLength(0);
    process.env.JEVUSHER_FILTER_NATIVE = 'Read';
    const pipeline = new Jevusher({ provider: p });
    expect((await onPostToolUse(event(directory), pipeline)).hookSpecificOutput?.updatedToolOutput).toBeDefined();
    const calls = p.requests.length;
    expect(await onPostToolUse(event(directory), pipeline)).toEqual({});
    expect(p.requests).toHaveLength(calls);
    delete process.env.JEVUSHER_FILTER;
    expect((await onPreToolUse({ session_id: 'session-one', tool_name: 'Edit', tool_input: { file_path: join(directory, 'evidence.txt') } })).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});
