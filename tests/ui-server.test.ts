import { afterEach, describe, expect, it } from 'vitest';
import { startUi } from '../src/ui-server.js';
import { localClaudeEnvironment, runProcess } from '../src/claude-runner.js';
import { request } from 'node:http';

const servers: Awaited<ReturnType<typeof startUi>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const ready = async () => ({ available: true, authenticated: true, version: 'test', message: 'ready' });
async function setup(options: Parameters<typeof startUi>[0] = {}) {
  const server = await startUi({ port: 0, apiKey: 'synthetic-test-key', status: ready, ...options });
  servers.push(server);
  const status = await (await fetch(`${server.url}/api/status`)).json() as { csrfToken: string };
  const post = (path: string, value: unknown, extra: RequestInit = {}) => fetch(`${server.url}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jevusher-Token': status.csrfToken }, body: JSON.stringify(value), ...extra,
  });
  return { ...server, post, token: status.csrfToken };
}

describe('local test UI boundary', () => {
  it('serves only packaged assets and never exposes the key in status', async () => {
    const server = await setup();
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const status = await (await fetch(`${server.url}/api/status`)).text();
    expect(status).not.toContain('synthetic-test-key');
    expect(JSON.parse(status).scenarios.every((scenario: object) => !Object.hasOwn(scenario, 'checks'))).toBe(true);
    expect((await fetch(`${server.url}/package.json`)).status).toBe(404);
    expect((await fetch(`${server.url}/src/cli.ts`)).status).toBe(404);
  });

  it('rejects foreign origins, rebinding hostnames, and missing CSRF tokens', async () => {
    const server = await setup();
    expect((await fetch(`${server.url}/api/status`, { headers: { Origin: 'https://example.invalid' } })).status).toBe(403);
    const rebindingStatus = await new Promise(resolve => {
      request(`${server.url}/api/status`, { headers: { Host: 'evil.example:4318' } }, response => { response.resume(); resolve(response.statusCode); }).end();
    });
    expect(rebindingStatus).toBe(403);
    expect((await fetch(`${server.url}/api/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"key":"bad-example-key"}' })).status).toBe(403);
    expect((await server.post('/api/key', { key: 'bad-example-key' }, { headers: { 'Content-Type': 'application/json', 'X-Jevusher-Token': 'é'.repeat(64) } })).status).toBe(403);
  });

  it('runs only known scenarios, retains one active run, and cancels', async () => {
    let started = 0;
    const server = await setup({ runner: async options => {
      started++;
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('Run cancelled.');
    } });
    expect((await server.post('/api/runs', { scenarioId: '../../private', mode: 'compare' })).status).toBe(400);
    const response = await server.post('/api/runs', { scenarioId: 'release', mode: 'compare' });
    const { id } = await response.json() as { id: string };
    expect(response.status).toBe(202);
    expect(started).toBe(1);
    expect((await server.post('/api/runs', { scenarioId: 'release', mode: 'compare' })).status).toBe(409);
    expect((await server.post('/api/key', { key: 'new-key-value' })).status).toBe(409);
    expect((await server.post(`/api/runs/${id}/cancel`, {})).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 10));
    const run = await (await fetch(`${server.url}/api/runs/${id}`)).json() as { status: string; error: string };
    expect(run.status).toBe('cancelled');
    expect(run.error).toBe('Run cancelled.');
  });

  it('redacts the configured key from errors and supports memory-only key removal', async () => {
    const server = await setup({ runner: async options => { throw new Error(`provider rejected ${options.apiKey}`); } });
    expect((await server.post('/api/key', { key: 'new-memory-key' })).status).toBe(200);
    const { id } = await (await server.post('/api/runs', { scenarioId: 'small', mode: 'preview' })).json() as { id: string };
    await new Promise(resolve => setTimeout(resolve, 10));
    const run = await (await fetch(`${server.url}/api/runs/${id}`)).text();
    expect(run).not.toContain('new-memory-key');
    expect(run).toContain('[redacted]');
    expect((await server.post('/api/key', undefined, { method: 'DELETE', body: undefined })).status).toBe(200);
    const state = await (await fetch(`${server.url}/api/status`)).json() as { keySource: string };
    expect(state.keySource).toBe('environment');
  });

  it('requires a key and a subscription login for comparison', async () => {
    const noKey = await setup({ apiKey: '' });
    expect((await noKey.post('/api/runs', { scenarioId: 'small', mode: 'preview' })).status).toBe(400);
    const noLogin = await setup({ status: async () => ({ available: true, authenticated: false, version: 'test', message: 'login required' }) });
    expect((await noLogin.post('/api/runs', { scenarioId: 'small', mode: 'compare' })).status).toBe(400);
  });

  it('rejects malformed requests and oversized key bodies', async () => {
    const server = await setup();
    expect((await server.post('/api/key', [])).status).toBe(400);
    expect((await server.post('/api/key', { key: 'x'.repeat(9000) })).status).toBe(400);
    expect((await server.post('/api/key', { key: 'secret\nheader' })).status).toBe(400);
  });

  it('does not start a paid run with a key removed while checking Claude', async () => {
    let release!: () => void;
    let checking!: () => void;
    const begun = new Promise<void>(resolve => { checking = resolve; });
    let checks = 0, starts = 0;
    const server = await setup({ status: async () => {
      if (++checks > 1) { checking(); await new Promise<void>(resolve => { release = resolve; }); }
      return ready();
    }, runner: async () => { starts++; return {}; } });
    await server.post('/api/key', { key: 'temporary-test-key' });
    const pending = server.post('/api/runs', { scenarioId: 'small', mode: 'compare' });
    await begun;
    expect((await server.post('/api/key', undefined, { method: 'DELETE', body: undefined })).status).toBe(200);
    release();
    expect((await pending).status).toBe(409);
    expect(starts).toBe(0);
  });

  it('never starts a model run after shutdown while subscription status is pending', async () => {
    let release!: () => void;
    let checking!: () => void;
    const begun = new Promise<void>(resolve => { checking = resolve; });
    let checks = 0, starts = 0;
    const server = await setup({ status: async () => {
      if (++checks > 1) { checking(); await new Promise<void>(resolve => { release = resolve; }); }
      return ready();
    }, runner: async () => { starts++; return {}; } });
    const pending = server.post('/api/runs', { scenarioId: 'small', mode: 'compare' });
    await begun;
    const closing = server.close();
    release();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'The local test server is shutting down.' });
    await closing;
    await server.close();
    expect(starts).toBe(0);
  });
});

describe('Claude process boundary', () => {
  it('does not forward inherited API credentials, OAuth token, or provider redirects', () => {
    const env = localClaudeEnvironment();
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'JEV_API_KEY']) expect(env[name]).toBeUndefined();
    expect(env.HOME ?? env.USERPROFILE).toBeTruthy();
  });

  it('can cancel a subprocess without waiting for its natural exit', async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('preserves multibyte characters split across process output chunks', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write(Buffer.from([0xe6]));setTimeout(()=>process.stdout.write(Buffer.from([0x9d,0xb1])),30)"]);
    expect(result.stdout).toBe('東');
  });
});
