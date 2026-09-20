import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { jevusherHome } from "./store.js";
import { record } from "./validation.js";

const TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_GOAL_BYTES = 8_000;

interface SessionGoal { goal: string; cwd: string; at: number; disabled: boolean }

function sessionKey(session: string): string { return createHash("sha256").update(session).digest("hex"); }
function sessionPath(session: string): string { return join(resolve(jevusherHome()), "sessions", `${sessionKey(session)}.json`); }

/** Save only prompts delivered by this session's hook, never discovery of history. */
export async function rememberPrompt(session: unknown, cwd: unknown, prompt: unknown): Promise<void> {
  if (typeof session !== "string" || !session || typeof cwd !== "string" || !isAbsolute(cwd)) return;
  const path = sessionPath(session);
  // Validate the parent before invalidating a record: rm would otherwise follow
  // a symlinked sessions directory even though the subsequent write is refused.
  await secureDirectory(dirname(path));
  const previous = await readGoalFile(path);
  // Invalidate the old task before saving a new one. A failed write must not
  // leave the previous turn's goal active when a new request changed the task.
  await rm(path, { force: true });
  const validPrevious = previous?.cwd === resolve(cwd) && Date.now() - previous.at < TTL_MS;
  const goal = typeof prompt === "string" && prompt.trim()
    ? [validPrevious ? previous.goal : "", prompt].filter(Boolean).join("\n\n--- next user request ---\n\n")
    : "";
  const disabled = !goal || !!(validPrevious && previous.disabled) || Buffer.byteLength(goal, "utf8") > MAX_GOAL_BYTES;
  const value: SessionGoal = { goal: disabled ? "" : goal, cwd: resolve(cwd), at: Date.now(), disabled };
  await secureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); } finally { await file.close(); }
    // Replacing a symlink is safe: rename replaces its directory entry, never its target.
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function recallPrompt(session: unknown, cwd: unknown): Promise<string | null> {
  if (typeof session !== "string" || !session || typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  const goal = await readGoalFile(sessionPath(session));
  return goal && !goal.disabled && goal.cwd === resolve(cwd) && Date.now() >= goal.at && Date.now() - goal.at < TTL_MS ? goal.goal : null;
}

async function readGoalFile(path: string): Promise<SessionGoal | null> {
  try {
    await secureDirectory(dirname(path));
    const info = await lstat(path);
    if (!info.isFile() || info.size > 16_000 || info.isSymbolicLink()) return null;
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return record(value) && typeof value.goal === "string" && Buffer.byteLength(value.goal, "utf8") <= MAX_GOAL_BYTES &&
      typeof value.cwd === "string" && typeof value.at === "number" && Number.isFinite(value.at) && typeof value.disabled === "boolean"
      ? value as unknown as SessionGoal : null;
  } catch { return null; }
}

/** Write once before replacing any output. The caller fails open if this fails. */
export async function saveOriginal(session: string, text: string): Promise<string> {
  const directory = join(resolve(jevusherHome()), "recovery", sessionKey(session));
  await secureDirectory(directory);
  const path = join(directory, `${randomUUID()}.txt`);
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(text, "utf8"); } finally { await file.close(); }
  return path;
}

/** Both direct recovery reads and symlink aliases bypass admission. */
export async function isRecoveryPath(path: string): Promise<boolean> {
  const root = resolve(jevusherHome(), "recovery");
  const inside = (base: string, candidate: string): boolean => {
    const rel = relative(base, candidate);
    return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (inside(root, resolve(path))) return true;
  return inside(await realpath(root).catch(() => root), await realpath(path).catch(() => resolve(path)));
}

export async function secureDirectory(path: string): Promise<void> {
  // Check the configured storage root and each child. Platform aliases such as
  // macOS /var -> /private/var outside that root are harmless.
  const root = resolve(jevusherHome());
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("jev-usher storage must use private real directories (0700)");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(current);
    }
    if (current === root) break;
    current = dirname(current);
  }
  for (const directory of missing.reverse()) await mkdir(directory, { mode: 0o700, recursive: directory === root }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("jev-usher storage directory must be private (0700)");
}
