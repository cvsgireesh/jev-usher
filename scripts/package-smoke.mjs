import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const temp = mkdtempSync(join(tmpdir(), "jevusher-package-"));
try {
  // Run from the source root. prepack checks and rebuilds the package.
  const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const metadata = JSON.parse(packed.slice(packed.indexOf("[\n")))[0];
  const forbidden = metadata.files.filter(f => /^(apps|tests|scripts|src)\//.test(f.path) || /\.env|demo-plan|HANDOFF/.test(f.path));
  assert.deepEqual(forbidden, []);
  assert(metadata.files.some(f => f.path === "dist/index.js"));
  assert(metadata.files.some(f => f.path === ".claude-plugin/plugin.json"));
  assert(metadata.files.some(f => f.path === 'ui/index.html'));
  assert(metadata.files.some(f => f.path === 'ui/app.js'));
  const consumer = join(temp, "consumer with spaces"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}');
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temp, metadata.filename)], { cwd: consumer, stdio: "pipe" });
  const env = { ...process.env, JEV_API_KEY: "", TYPESAFE_API_KEY: "", JEVUSHER_HOME: join(temp, "empty-store"), JEVUSHER_MEMORY: join(temp, "absent-memory"), JEVUSHER_CATALOG: join(temp, "absent-catalog"), JEVUSHER_LEDGER: join(temp, "ledger"), JEVUSHER_SCREEN: "0" };
  const cli = join(consumer, "node_modules/jevusher/bin/jevusher.mjs");
  const run = (args, input = "") => spawnSync(process.execPath, [cli, ...args], { cwd: consumer, env, input, encoding: "utf8" });
  assert.equal(run(["--help"]).status, 0);
  assert.equal(run(["doctor"]).status, 1);
  const invalid = run(["hook", "user-prompt-submit"], "{invalid");
  assert.equal(invalid.status, 0); assert.equal(invalid.stdout, ""); assert.match(invalid.stderr, /jevusher/);
  const empty = run(["hook", "user-prompt-submit"], JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }));
  assert.equal(empty.status, 0); assert.equal(empty.stdout, "");
  assert.equal(run(["install"]).status, 0);
  const settings = join(consumer, ".claude/settings.json");
  const installed = readFileSync(settings, "utf8");
  assert.equal(run(["install"]).status, 0); assert.equal(readFileSync(settings, "utf8"), installed);
  assert(!JSON.parse(installed).hooks.UserPromptSubmit[0].hooks[0].command.startsWith("npx "));
  const command = JSON.parse(installed).hooks.UserPromptSubmit[0].hooks[0].command;
  const hooked = spawnSync(command, { shell: true, cwd: consumer, env, input: '{"prompt":"hi"}', encoding: "utf8" });
  assert.equal(hooked.status, 0); assert.equal(hooked.stdout, "");
  assert.equal(run(["uninstall"]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), {});
  const imports = spawnSync(process.execPath, ["--input-type=module", "-e", "import { Jevusher, DecisionCache } from 'jevusher'; if (!Jevusher || !DecisionCache) process.exit(1)"], { cwd: consumer, env, encoding: "utf8" });
  assert.equal(imports.status, 0, imports.stderr);
  const ui = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {startUi} from './node_modules/jevusher/dist/ui-server.js';
    const server=await startUi({port:0,apiKey:'',status:async()=>({available:false,authenticated:false,version:null,message:'offline smoke'})});
    try {
      const page=await fetch(server.url);
      if(page.status!==200 || !(await page.text()).toLowerCase().includes('jevusher'))throw new Error('UI page missing');
      if((await fetch(server.url+'/app.js')).status!==200)throw new Error('UI script missing');
      const status=await (await fetch(server.url+'/api/status')).json();
      if(status.jevConfigured || !status.scenarios.length)throw new Error('Invalid offline UI status');
    } finally {await server.close();}
  `], { cwd: consumer, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(ui.status, 0, ui.stderr);
  console.log(`Package smoke passed: ${metadata.files.length} files, ${metadata.size} bytes. Clean install, exports, CLI, local UI assets, quoted hooks, and uninstall verified.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
