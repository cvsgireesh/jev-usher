import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureHooks, shellQuote } from "../src/install.js";

const dirs: string[] = [];
async function settings(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), "jevusher-install-")); dirs.push(dir);
  const path = join(dir, "settings.json");
  if (content !== undefined) await writeFile(path, content);
  return { dir, path };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const command = "'/node' '/app/bin/jevusher.mjs'";

describe("settings installation", () => {
  it.each(['{broken', '[]', '{"hooks":[]}', '{"hooks":{"UserPromptSubmit":{}}}'])("preserves invalid settings byte for byte", async content => {
    const { path } = await settings(content);
    await expect(configureHooks(path, command)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(content);
  });
  it("is idempotent, backs up settings, and uninstalls only its own hooks", async () => {
    const original = { permissions: { deny: ["Bash(rm *)"] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-hook" }] }] } };
    const { dir, path } = await settings(JSON.stringify(original));
    await configureHooks(path, command);
    const first = await readFile(path, "utf8");
    await configureHooks(path, command);
    expect(await readFile(path, "utf8")).toBe(first);
    expect((await readdir(dir)).filter(n => n.includes("backup"))).toHaveLength(1);
    expect(first).not.toContain("npx");
    await configureHooks(path, command, true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
  });
  it("replaces legacy npx commands without deleting sibling handlers", async () => {
    const { path } = await settings(JSON.stringify({ hooks: { PostToolUse: [{ matcher: "WebFetch", hooks: [
      { type: "command", command: "npx --yes jevusher hook post-tool-use" }, { type: "command", command: "echo jevusher is installed" },
    ] }] } }));
    await configureHooks(path, command);
    const updated = await readFile(path, "utf8");
    expect(updated).not.toContain("npx --yes");
    expect(updated).toContain("echo jevusher is installed");
  });
  it("quotes paths containing spaces and apostrophes", () => {
    expect(shellQuote("/a'b/my folder")).toBe("'/a'\\''b/my folder'");
  });
  it("does not replace symlinked settings", async () => {
    const { dir, path } = await settings();
    const target = join(dir, "shared-settings.json");
    await writeFile(target, '{"permissions":{}}');
    await symlink(target, path);
    await expect(configureHooks(path, command)).rejects.toThrow("symlink");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe('{"permissions":{}}');
  });
});
