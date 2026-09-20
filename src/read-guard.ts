import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { jevusherHome } from './store.js';
import { secureDirectory } from './recovery.js';
import { record } from './validation.js';

interface Guard { source: string; sourceAlias: string; recovery: string; digest: string; bytes: number }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const location = (session: string) => join(resolve(jevusherHome()), 'read-guards', hash(session));
const canonical = (path: string) => realpath(path).catch(() => resolve(path));

/** A distinct atomic file per result avoids lost updates from concurrent Reads. */
export async function protectRead(session: string, source: string, recovery: string, text: string): Promise<void> {
  const directory = location(session);
  await secureDirectory(directory);
  if ((await readdir(directory)).length >= 128) throw new Error('Recovery guard limit reached');
  const guard: Guard = { source: await canonical(source), sourceAlias: resolve(source), recovery: resolve(recovery), digest: hash(text), bytes: Buffer.byteLength(text, 'utf8') };
  const path = join(directory, `${randomUUID()}.json`);
  const temporary = `${path}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(guard)); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function requiredRecoveries(session: string, source: string): Promise<string[]> {
  const actual = await canonical(source);
  return (await guards(session)).filter(({ guard }) => guard.source === actual || guard.sourceAlias === resolve(source)).map(({ guard }) => guard.recovery);
}

/** Only a full, byte-identical Read of the stored original releases its guard. */
export async function acknowledgeRecovery(session: string, path: string, text: string, startLine: number): Promise<void> {
  if (startLine !== 1) return;
  const actual = await canonical(path);
  const digest = hash(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  for (const entry of await guards(session)) {
    if (await canonical(entry.guard.recovery) === actual && entry.guard.bytes === bytes && entry.guard.digest === digest) await rm(entry.path);
  }
}

async function guards(session: string): Promise<{ path: string; guard: Guard }[]> {
  const directory = location(session);
  try { await lstat(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  await secureDirectory(directory);
  const names = await readdir(directory);
  if (names.length > 256) throw new Error('Too many recovery guards');
  const entries: { path: string; guard: Guard }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 24_000) throw new Error('Invalid recovery guard');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!record(value) || typeof value.source !== 'string' || !isAbsolute(value.source) || typeof value.sourceAlias !== 'string' || !isAbsolute(value.sourceAlias) ||
      typeof value.recovery !== 'string' || !isAbsolute(value.recovery) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error('Invalid recovery guard');
    entries.push({ path, guard: value as unknown as Guard });
  }
  return entries;
}
