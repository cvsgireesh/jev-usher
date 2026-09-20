import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LAB_SCENARIOS, type LabScenario } from '../src/lab-scenarios.js';
import { inspectLabTool, labToolAllowed, parseClaudeStream, prepareLabFiles, runLab, type LabToolCall } from '../src/lab.js';

const mocks = vi.hoisted(() => ({ runProcess: vi.fn(), selectModel: vi.fn(), filterText: vi.fn() }));
vi.mock('../src/claude-runner.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/claude-runner.js')>(), runProcess: mocks.runProcess }));
vi.mock('../src/launch.js', () => ({ selectModel: mocks.selectModel }));
vi.mock('../src/admission.js', () => ({ filterText: mocks.filterText }));
const directories: string[] = [];
const scenario = (id: string) => LAB_SCENARIOS.find(item => item.id === id)!;
const correctAnswer = (value: LabScenario) => JSON.stringify(Object.fromEntries(value.checks.map(check => [check.field, check.expected])));
const readResult = (path: string, content: string, startLine = 1) => ({ type: 'text', file: { filePath: path, content, startLine, numLines: content.split('\n').length, totalLines: content.split('\n').length } });
const call = (id: string, result: unknown, name = 'Read'): LabToolCall => ({ id, name, input: {}, result });
const final = (value: LabScenario) => ({ type: 'result', is_error: false, result: correctAnswer(value), usage: { input_tokens: 4, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 120 }, modelUsage: { 'actual-claude-model': {} } });
const lines = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');
const post = (id: string, original: unknown, replacement?: unknown) => ({ variant: 'filtered', latencyMs: 7,
  input: { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: id, tool_response: original },
  output: replacement ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: replacement } } : {},
});

beforeEach(() => { vi.clearAllMocks(); mocks.selectModel.mockResolvedValue({ selectedModel: 'haiku', tier: 'trivial', confidence: 0.97, trusted: true, requests: 1, inputTokens: 200, costUsd: 0.0000084, latencyMs: 20, reason: 'Simple extraction.', status: 'available' }); });
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'jevusher-lab-test-')); directories.push(path); return path; }

describe('matching native tool evidence', () => {
  it('matches stream tool results to their own tool use, retaining unresolved requests', () => {
    const value = scenario('small');
    const result = parseClaudeStream(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'first', name: 'Read', input: { file_path: '/tmp/one' } }, { type: 'tool_use', id: 'second', name: 'Read', input: { file_path: '/tmp/two' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'second', content: 'second file' }] }, tool_use_result: { content: 'second file' } }, final(value)), value);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]!.result).toBeUndefined();
    expect(result.toolCalls[1]!.input.file_path).toBe('/tmp/two');
    expect(result.toolCalls[1]!.result).toEqual({ content: 'second file' });
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 120 });
    expect(result.models).toEqual(['actual-claude-model']);
  });

  it('does not accept a later matching excerpt as proof for an earlier rejected replacement', () => {
    const value = { ...scenario('small'), source: 'one\ntwo\nthree\n' };
    const original = readResult('/fixture/fixture.md', value.source);
    const replacement = { ...original, file: { ...original.file, content: 'two', startLine: 2, numLines: 1 } };
    const rejected = inspectLabTool(value, '/fixture', [post('first', original, replacement)], [call('baseline', original)], [call('first', original), call('second', replacement)]);
    expect(rejected.proposed).toBe(true);
    expect(rejected.accepted).toBe(false);
    expect(rejected.observed).toBe(false);
    const accepted = inspectLabTool(value, '/fixture', [post('first', original, replacement)], [call('baseline', original)], [call('first', replacement)]);
    expect(accepted.accepted).toBe(true);
    expect(accepted.completeSource).toBe(true);
    expect(accepted.candidates.map(item => item.text)).toEqual(['one\n', 'two', 'three\n']);
  });

  it('requires the same complete original source in both runs', () => {
    const value = { ...scenario('small'), source: 'one\ntwo\nthree\n' };
    const original = readResult('/fixture/fixture.md', value.source);
    const partial = readResult('/fixture/fixture.md', 'two\n', 2);
    const result = inspectLabTool(value, '/fixture', [post('first', partial)], [call('baseline', original)], [call('first', partial)]);
    expect(result.observed).toBe(true);
    expect(result.completeSource).toBe(false);
  });

  it('rejects mismatched replacement schema metadata even if its text matches', () => {
    const value = scenario('small'), original = readResult('/fixture/fixture.md', value.source);
    const proposed = { ...original, file: { ...original.file, content: 'short', startLine: 2, numLines: 1 } };
    const received = { ...proposed, file: { ...proposed.file, startLine: 1 } };
    expect(inspectLabTool(value, '/fixture', [post('first', original, proposed)], [call('baseline', original)], [call('first', received)]).accepted).toBe(false);
  });

  it('does not treat unsuccessful or ambiguous tool results as successful executions', () => {
    const value = scenario('small');
    const result = parseClaudeStream(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'Read', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', is_error: true }] }, tool_use_result: { file: {} } }, final(value)), value);
    expect(result.toolCalls[0]!.result).toBeUndefined();
    const noTools = scenario('inline-knowledge');
    expect(inspectLabTool(noTools, '/fixture', [], result.toolCalls, []).observed).toBe(false);
  });

  it('requires a valid final result and never exposes arbitrary CLI error text', () => {
    const value = scenario('small');
    expect(() => parseClaudeStream('not JSON', value)).toThrow('JSON stream');
    expect(() => parseClaudeStream('{}', value)).toThrow('final result');
    expect(() => parseClaudeStream(lines({ ...final(value), is_error: true, result: 'Account detail secret@example.invalid' }), value)).toThrow('could not complete');
    expect(() => parseClaudeStream(lines({ ...final(value), usage: {} }), value).usage.inputTokens).not.toThrow();
    expect(parseClaudeStream(lines({ ...final(value), usage: {} }), value).usage.inputTokens).toBeNull();
  });
});

describe('synthetic filesystem and tool restrictions', () => {
  it('creates only the stated fixture and rejects traversal filenames', async () => {
    const path = await directory();
    await prepareLabFiles(scenario('source-code'), path);
    expect(await readdir(path)).toEqual(['fixture.ts']);
    await expect(prepareLabFiles({ ...scenario('small'), filename: '../outside.md' }, path)).rejects.toThrow('filename');
    await expect(prepareLabFiles({ ...scenario('glob-output'), source: 'fixtures/../../outside.ts' }, path)).rejects.toThrow('Glob');
    await prepareLabFiles(scenario('glob-output'), path);
    expect(await readFile(join(path, 'fixtures/services/atlas-audit-export-retention-policy.ts'), 'utf8')).toContain('Synthetic');
  });

  it('allows only full reads of the exact fixture or contained recovery files', async () => {
    const path = await directory(), outside = await directory(), value = scenario('small');
    await prepareLabFiles(value, path);
    await writeFile(join(outside, 'private.md'), 'outside data');
    await mkdir(join(path, 'store/recovery'), { recursive: true });
    await writeFile(join(path, 'store/recovery/original.txt'), 'synthetic archive');
    await symlink(join(outside, 'private.md'), join(path, 'store/recovery/escape.txt'));
    const read = (file_path: string, extra = {}) => labToolAllowed(value, path, { tool_name: 'Read', tool_input: { file_path, ...extra } });
    expect(await read('fixture.md')).toBe(true);
    expect(await read('fixture.md', { offset: 2 })).toBe(false);
    expect(await read('store/recovery/original.txt')).toBe(true);
    expect(await read('store/recovery/original.txt', { limit: 1 })).toBe(false);
    expect(await read('store/recovery/escape.txt')).toBe(false);
    expect(await read(join(outside, 'private.md'))).toBe(false);
    expect(await labToolAllowed(value, path, { tool_name: 'Edit', tool_input: { file_path: 'fixture.md' } })).toBe(false);
  });

  it('allows only the fixed Bash command and complete native search patterns', async () => {
    const path = await directory();
    for (const command of ['cat fixture.log; env', 'cat $HOME/.claude.json', 'cat fixture.md', 'node script.js']) expect(await labToolAllowed(scenario('bash-output'), path, { tool_name: 'Bash', tool_input: { command } })).toBe(false);
    expect(await labToolAllowed(scenario('bash-output'), path, { tool_name: 'Bash', tool_input: { command: 'cat fixture.log' } })).toBe(true);
    const input = { pattern: 'RECORD', path: 'fixture-search.log', output_mode: 'content', '-n': true, head_limit: 0 };
    expect(await labToolAllowed(scenario('grep-output'), path, { tool_name: 'Grep', tool_input: input })).toBe(true);
    expect(await labToolAllowed(scenario('grep-output'), path, { tool_name: 'Grep', tool_input: { ...input, head_limit: 20 } })).toBe(false);
    expect(await labToolAllowed(scenario('glob-output'), path, { tool_name: 'Glob', tool_input: { pattern: 'fixtures/**/*.ts' } })).toBe(true);
    expect(await labToolAllowed(scenario('glob-output'), path, { tool_name: 'Glob', tool_input: { pattern: '**/*' } })).toBe(false);
  });
});

function fakeClaude(value: LabScenario, unresolvedFilteredResult = false) {
  mocks.runProcess.mockImplementation(async (_command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
    const cwd = options.cwd, variant = options.env.JEVUSHER_LAB_VARIANT;
    const settings = JSON.parse(await readFile(args[args.indexOf('--settings') + 1]!, 'utf8'));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(args).toContain('--restricted');
    const finalEvent = { ...final(value), modelUsage: { [args[args.indexOf('--model') + 1]!]: {} } };
    if (value.tool === 'none') return { stdout: lines(finalEvent), stderr: '', code: 0 };
    const result = readResult(join(cwd, value.filename ?? 'fixture.md'), await readFile(join(cwd, value.filename ?? 'fixture.md'), 'utf8'));
    if (variant === 'filtered') {
      await appendFile(join(cwd, 'events.jsonl'), lines(post('native-call', result)) + '\n');
      if (options.env.JEVUSHER_FILTER === '1' && Buffer.byteLength(value.source) >= 4000) {
        await mkdir(join(cwd, 'store'), { recursive: true });
        await writeFile(join(cwd, 'store/ledger.jsonl'), lines({ requests: 2, jevUsage: { input_tokens: 1000, output_tokens: 0 } }) + '\n');
      }
    }
    return { stdout: lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'native-call', name: 'Read', input: { file_path: result.file.filePath } }] } },
      ...(variant === 'filtered' && unresolvedFilteredResult ? [] : [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-call', content: value.source }] }, tool_use_result: result }]), finalEvent), stderr: '', code: 0 };
  });
}

describe('paired model and context configuration', () => {
  it('does not count an unresolved tool result as zero admitted tokens', async () => {
    fakeClaude(scenario('small'), true);
    const result = await runLab({ scenario: scenario('small'), mode: 'compare', optimization: 'context', apiKey: 'synthetic-key', signal: new AbortController().signal, phase: () => {} });
    expect(result.hook).toMatchObject({ completeSource: true, observed: false });
    expect(result.admission).toMatchObject({ admittedTokens: null });
    expect(result.verdict).toMatchObject({ passed: false });
  });

  it('routes the optimized model and totals both JEV contributions', async () => {
    fakeClaude(scenario('release'));
    const result = await runLab({ scenario: scenario('release'), mode: 'compare', apiKey: 'synthetic-key', signal: new AbortController().signal, phase: () => {} });
    expect(mocks.selectModel).toHaveBeenCalledWith(scenario('release').prompt, expect.objectContaining({ fallbackModel: 'sonnet' }));
    const calls = mocks.runProcess.mock.calls;
    expect(calls.map(([, args]) => args[args.indexOf('--model') + 1])).toEqual(['sonnet', 'haiku']);
    expect(calls.map(([, , options]) => options.env.JEVUSHER_FILTER)).toEqual(['0', '1']);
    expect(result.jev).toMatchObject({ requests: 3, inputTokens: 1200, status: 'available' });
    expect(result.verdict).toMatchObject({ passed: true });
    expect(result.hook).toMatchObject({ completeSource: true, observed: true });
  });

  it('keeps both models fixed in context-only mode and honors comparison order', async () => {
    fakeClaude(scenario('release'));
    const result = await runLab({ scenario: scenario('release'), mode: 'compare', optimization: 'context', baselineModel: 'opus', filteredFirst: true, apiKey: 'synthetic-key', signal: new AbortController().signal, phase: () => {} });
    expect(mocks.selectModel).not.toHaveBeenCalled();
    expect(mocks.runProcess.mock.calls.map(([, args]) => args[args.indexOf('--model') + 1])).toEqual(['opus', 'opus']);
    expect(result.order).toEqual(['filtered', 'baseline']);
    expect(result.jev).toMatchObject({ requests: 2, inputTokens: 1000 });
  });

  it('retains original context and charges no context decision in routing-only mode', async () => {
    fakeClaude(scenario('release'));
    const result = await runLab({ scenario: scenario('release'), mode: 'compare', optimization: 'routing', apiKey: 'synthetic-key', signal: new AbortController().signal, phase: () => {} });
    expect(mocks.runProcess.mock.calls.every(([, , options]) => options.env.JEVUSHER_FILTER === '0')).toBe(true);
    expect(result.jev).toMatchObject({ requests: 1, inputTokens: 200 });
    expect(result.admission).toMatchObject({ status: 'disabled' });
    expect(result.verdict).toMatchObject({ passed: true });
  });

  it('routes direct questions without exposing tools', async () => {
    fakeClaude(scenario('inline-knowledge'));
    const result = await runLab({ scenario: scenario('inline-knowledge'), mode: 'compare', apiKey: 'synthetic-key', signal: new AbortController().signal, phase: () => {} });
    expect(mocks.runProcess.mock.calls.every(([, args]) => args[args.indexOf('--tools') + 1] === '')).toBe(true);
    expect(result.verdict).toMatchObject({ passed: true });
    expect(result.admission).toMatchObject({ offeredTokens: 0, admittedTokens: 0, status: 'disabled' });
  });

  it('does not report partial provider measurements as complete totals', async () => {
    const value = scenario('release');
    mocks.filterText.mockResolvedValue({ text: value.source, changed: false, startLine: 1, endLine: 1, chunks: [], verdicts: [], usage: { input_tokens: 300, output_tokens: 0 }, requests: 1, reason: 'unavailable' });
    const result = await runLab({ scenario: value, mode: 'preview', apiKey: 'synthetic-key', signal: new AbortController().signal, phase: () => {} });
    expect(result.jev).toMatchObject({ status: 'unavailable', requests: null, inputTokens: null, costUsd: null });
    expect(result.admission).toMatchObject({ status: 'unavailable' });
    expect(mocks.runProcess).not.toHaveBeenCalled();
  });

  it('rejects cancellation and invalid settings before calling either provider', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runLab({ scenario: scenario('small'), mode: 'compare', apiKey: 'synthetic-key', signal: controller.signal, phase: () => {} })).rejects.toThrow('cancelled');
    expect(mocks.selectModel).not.toHaveBeenCalled();
    expect(mocks.runProcess).not.toHaveBeenCalled();
  });
});
