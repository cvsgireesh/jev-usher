import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { claudeStatus } from './claude-runner.js';
import { DEFAULT_MODEL } from './client.js';
import { LAB_SCENARIOS } from './lab-scenarios.js';
import { runLab, type LabOptions } from './lab.js';
import { record } from './validation.js';

interface Run { id: string; scenarioId: string; mode: 'preview' | 'compare'; optimization: 'context' | 'routing' | 'combined'; baselineModel: 'sonnet' | 'opus' | 'haiku'; status: 'running' | 'complete' | 'error' | 'cancelled'; phase: string; result?: unknown; error?: string }
export interface UiOptions {
  port?: number;
  apiKey?: string;
  /** Test seams; never configured by HTTP callers. */
  status?: typeof claudeStatus;
  runner?: (options: LabOptions) => Promise<unknown>;
}

export async function startUi(options: UiOptions = {}) {
  const port = options.port ?? 4318;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  const environmentKey = options.apiKey ?? process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? '';
  let memoryKey = '';
  let keyGeneration = 0;
  let comparisonCount = 0;
  const token = randomBytes(32).toString('hex');
  const runs = new Map<string, Run>();
  let active: { id: string; controller: AbortController } | null = null;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let origin = '';
  const status = options.status ?? claudeStatus;
  const runner = options.runner ?? runLab;
  const assets = new Map([
    ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
    ['/metrics.js', { file: 'metrics.js', type: 'text/javascript; charset=utf-8' }],
    ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ]);

  const server = createServer((request, response) => { void handle(request, response).catch(() => json(response, 500, { error: 'The local server could not complete this request.' })); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 30;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (closing) return json(res, 503, { error: 'The local test server is shutting down.' });
    if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
      return json(res, 403, { error: 'Open the local URL printed by jev-usher ui.' });
    }
    const path = (req.url ?? '').split('?')[0]!;
    if (req.method === 'GET' && assets.has(path)) {
      const asset = assets.get(path)!;
      res.setHeader('Content-Type', asset.type);
      res.end(await readFile(new URL(`../ui/${asset.file}`, import.meta.url)));
      return;
    }
    if (req.method === 'GET' && path === '/api/status') {
      return json(res, 200, { csrfToken: token, jevConfigured: !!(memoryKey || environmentKey), keySource: memoryKey ? 'memory' : environmentKey ? 'environment' : null, claude: await status(), model: DEFAULT_MODEL, scenarios: LAB_SCENARIOS.map(({ checks, ...scenario }) => scenario), run: active ? runs.get(active.id) : null });
    }
    if (req.method === 'GET' && path.startsWith('/api/runs/')) {
      const run = runs.get(path.slice('/api/runs/'.length));
      return json(res, run ? 200 : 404, run ?? { error: 'Run not found. Results last only while the local server is running.' });
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') return json(res, 404, { error: 'Not found.' });
    const supplied = req.headers['x-jevusher-token'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return json(res, 403, { error: 'Refresh the local page before starting a request.' });
    if (active && (path === '/api/key' || path === '/api/runs')) return json(res, 409, { error: 'Wait for the current test or cancel it first.' });
    if (req.method === 'DELETE' && path === '/api/key') {
      memoryKey = '';
      keyGeneration++;
      return json(res, 200, { configured: !!environmentKey });
    }
    if (req.method === 'POST' && path.match(/^\/api\/runs\/[^/]+\/cancel$/)) {
      if (!active || active.id !== path.split('/')[3]) return json(res, 409, { error: 'That run is no longer active.' });
      active.controller.abort();
      return json(res, 200, { cancelled: true });
    }
    let body: Record<string, unknown>;
    try { body = await bodyJson(req); }
    catch { return json(res, 400, { error: 'Expected a JSON object smaller than 8 KB.' }); }
    if (closing) return json(res, 503, { error: 'The local test server is shutting down.' });
    if (req.method === 'POST' && path === '/api/key') {
      if (active) return json(res, 409, { error: 'Wait for the current test or cancel it first.' });
      if (typeof body.key !== 'string' || body.key.trim().length < 8 || body.key.length > 4096 || /[\r\n]/.test(body.key)) return json(res, 400, { error: 'Enter a valid JEV API key.' });
      memoryKey = body.key.trim();
      keyGeneration++;
      return json(res, 200, { configured: true });
    }
    if (req.method === 'POST' && path === '/api/runs') {
      const scenario = LAB_SCENARIOS.find(item => item.id === body.scenarioId);
      if (!scenario || (body.mode !== 'preview' && body.mode !== 'compare')) return json(res, 400, { error: 'Choose a built-in scenario and test mode.' });
      const optimization = body.optimization ?? 'combined';
      const baselineModel = body.baselineModel ?? 'sonnet';
      if (optimization !== 'context' && optimization !== 'routing' && optimization !== 'combined' || baselineModel !== 'sonnet' && baselineModel !== 'opus' && baselineModel !== 'haiku') return json(res, 400, { error: 'Choose a supported optimization and Claude model.' });
      const key = memoryKey || environmentKey;
      const generation = keyGeneration;
      if (!key) return json(res, 400, { error: 'Set a JEV API key before running a test.' });
      if (body.mode === 'compare' && !(await status()).authenticated) return json(res, 400, { error: 'Sign in with claude auth login in your terminal, then refresh status.' });
      if (closing) return json(res, 503, { error: 'The local test server is shutting down.' });
      if (generation !== keyGeneration) return json(res, 409, { error: 'The API key changed while checking Claude. Start the test again.' });
      // Another asynchronous status check may have started a run in the meantime.
      if (active) return json(res, 409, { error: 'A test is already running.' });
      const run: Run = { id: randomUUID(), scenarioId: scenario.id, mode: body.mode, optimization, baselineModel, status: 'running', phase: 'Starting the test.' };
      const controller = new AbortController();
      runs.set(run.id, run);
      while (runs.size > 30) runs.delete(runs.keys().next().value!);
      active = { id: run.id, controller };
      json(res, 202, { id: run.id });
      const filteredFirst = body.mode === 'compare' ? comparisonCount++ % 2 === 1 : false;
      void runner({ scenario, mode: body.mode, optimization, baselineModel, apiKey: key, filteredFirst, signal: controller.signal, phase: message => { run.phase = message; } }).then(result => {
        if (controller.signal.aborted) throw new Error('Run cancelled.');
        run.result = result; run.status = 'complete'; run.phase = 'Test complete.';
      }).catch(error => {
        run.status = controller.signal.aborted ? 'cancelled' : 'error'; run.phase = 'Test stopped.';
        const message = error instanceof Error ? error.message : 'Test could not complete.';
        run.error = message.split(key).join('[redacted]').slice(0, 500);
      }).finally(() => { if (active?.id === run.id) active = null; });
      return;
    }
    return json(res, 404, { error: 'Not found.' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind the local UI.');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, close: () => {
    if (closePromise) return closePromise;
    closing = true;
    keyGeneration++;
    active?.controller.abort(); memoryKey = '';
    server.closeIdleConnections();
    closePromise = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return closePromise;
  } };
}

async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8192) throw new Error('too large');
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!record(value)) throw new Error('object required');
  return value;
}

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
