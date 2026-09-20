import { mkdir, readFile, open, writeFile, rename, unlink, stat, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { record } from "./validation.js";

function ours(handler: unknown): boolean {
  return record(handler) && handler.type === "command" && typeof handler.command === "string" &&
    (/\bjev-?usher(?:\.mjs)?['"]? hook (user-prompt-submit|pre-tool-use|post-tool-use|stop)$/.test(handler.command));
}

/** Preserve unrelated hooks and settings; refuse malformed input before writing. */
export async function configureHooks(path: string, command: string, remove = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Share the lock with earlier releases during installation and upgrades.
  const lock = await open(`${path}.jevusher.lock`, "wx", 0o600);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    let original: string | undefined;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Refusing to replace a symlinked settings file");
      original = await readFile(path, "utf8");
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const parsed: unknown = original === undefined ? {} : JSON.parse(original);
    if (!record(parsed) || parsed.hooks !== undefined && !record(parsed.hooks)) throw new TypeError("Invalid Claude settings; left unchanged");
    const hooks: Record<string, unknown> = parsed.hooks as Record<string, unknown> ?? {};
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
      const list = hooks[event] ?? [];
      if (!Array.isArray(list) || list.some(g => !record(g) || !Array.isArray(g.hooks))) {
        throw new TypeError(`Invalid ${event} hooks; settings left unchanged`);
      }
      hooks[event] = list.flatMap(group => {
        const remaining = group.hooks.filter((h: unknown) => !ours(h));
        return remaining.length ? [{ ...group, hooks: remaining }] : [];
      });
      if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
    }
    if (!remove) {
      for (const [event, argument, matcher] of [
        ["UserPromptSubmit", "user-prompt-submit", undefined],
        ["PreToolUse", "pre-tool-use", "^(Edit|Write)$"],
        ["PostToolUse", "post-tool-use", "^(Read|Bash|Grep|Glob|WebFetch|WebSearch|mcp__.*)$"],
      ] as const) {
        const list = (hooks[event] ??= []) as unknown[];
        list.push({ ...(matcher && { matcher }), hooks: [{ type: "command", command: `${command} hook ${argument}`, timeout: 20 }] });
      }
    }
    if (Object.keys(hooks).length) parsed.hooks = hooks;
    else delete parsed.hooks;
    const updated = `${JSON.stringify(parsed, null, 2)}\n`;
    if (original === updated || remove && original === undefined) return;
    let mode = 0o600;
    if (original !== undefined) {
      mode = (await stat(path)).mode & 0o777;
      await writeFile(`${path}.jevusher-backup-${randomUUID()}`, original, { mode: 0o600, flag: "wx" });
    }
    await writeFile(temporary, updated, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(`${path}.jevusher.lock`);
  }
}

export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
