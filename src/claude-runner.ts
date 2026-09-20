import { spawn } from 'node:child_process';

/** Use the user's normal local login, never an inherited API key or injected OAuth token. */
export function localClaudeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'COMSPEC', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'CLAUDE_CONFIG_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export interface ProcessResult { stdout: string; stderr: string; code: number | null }

export async function runProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; input?: string;
} = {}): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new Error('Run cancelled.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'pipe', detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', failure: Error | undefined;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* already exited */ }
    };
    const abort = () => { failure = new Error('Run cancelled.'); kill(); };
    const timer = setTimeout(() => { failure = new Error('Claude timed out. Check Claude in your terminal, then retry.'); kill(); }, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
      if (stdout.length > 4_000_000) { failure = new Error('Claude output exceeded the local test limit.'); kill(); }
    });
    child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-10_000); });
    child.on('error', () => { cleanup(); reject(new Error('Claude CLI is unavailable. Install Claude Code and run claude auth login in your terminal.')); });
    child.on('close', code => { cleanup(); failure ? reject(failure) : resolve({ stdout, stderr, code }); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

export async function claudeStatus() {
  if (process.platform === 'win32') return { available: false, authenticated: false, version: null, message: 'Local Claude comparisons currently support macOS and Linux. JEV previews are still available.' };
  const env = localClaudeEnvironment();
  try {
    const version = await runProcess('claude', ['--version'], { env, timeoutMs: 8000 });
    const status = await runProcess('claude', ['auth', 'status', '--json'], { env, timeoutMs: 8000 });
    const auth = JSON.parse(status.stdout);
    const match = version.stdout.match(/^(\d+)\.(\d+)\.(\d+)/);
    const current = match ? match.slice(1).map(Number) : [];
    const compatible = current.length === 3 && (current[0]! > 2 || current[0] === 2 && (current[1]! > 1 || current[1] === 1 && current[2]! >= 278));
    const authenticated = compatible && auth.loggedIn === true && auth.authMethod === 'claude.ai' && auth.apiProvider === 'firstParty';
    return { available: true, authenticated, version: version.stdout.trim(), message: !compatible ? 'Update Claude Code to version 2.1.278 or newer before running comparisons.' : authenticated ? 'Using your local Claude subscription login.' : 'Run claude auth login in your terminal and choose your Claude subscription.' };
  } catch {
    return { available: false, authenticated: false, version: null, message: 'Install Claude Code, then run claude auth login in your terminal.' };
  }
}
