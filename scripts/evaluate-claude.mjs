import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLab } from '../dist/lab.js';
import { LAB_SCENARIOS } from '../dist/lab-scenarios.js';
import { claudeStatus } from '../dist/claude-runner.js';

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const output = value('--out');
const repeat = Number(value('--repeat') ?? '1');
const optimization = value('--optimization') ?? 'context';
const baselineModel = value('--baseline-model') ?? 'sonnet';
const selectedIds = value('--scenarios')?.split(',');
const scenarios = selectedIds ? LAB_SCENARIOS.filter(scenario => selectedIds.includes(scenario.id)) : LAB_SCENARIOS;
if (!args.includes('--live') || !output || !Number.isInteger(repeat) || repeat < 1 || repeat > 5 || !['context', 'routing', 'combined'].includes(optimization) || !['sonnet', 'opus', 'haiku'].includes(baselineModel) || !scenarios.length || selectedIds?.some(id => !scenarios.some(scenario => scenario.id === id))) {
  throw new Error('Usage: npm run eval:claude -- --live --out /outside/repo/results.json [--repeat 1..5] [--optimization context|routing|combined] [--baseline-model sonnet|opus|haiku] [--scenarios id,id]. Each pair consumes two Claude runs and may spend JEV credits.');
}
const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
if ((await lstat(resolve(output)).catch(() => null))?.isSymbolicLink()) throw new Error('The report path must not be a symlink.');
await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 });
const parent = await realpath(dirname(resolve(output)));
const rel = relative(root, parent);
if (rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)) throw new Error('Save generated evaluation results outside the repository.');
const key = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
if (!key) throw new Error('Set JEV_API_KEY before the live evaluation.');
const claude = await claudeStatus();
if (!claude.authenticated) throw new Error(claude.message);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const report = { startedAt: new Date().toISOString(), claudeVersion: claude.version, baselineModel, optimization, repeat, checks: 'Synthetic fixture assertions and observed Claude tool stream; not a general quality or billing guarantee.', results: [] };
const save = async () => { await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'w' }); await chmod(resolve(output), 0o600); };
for (let round = 0; round < repeat && !controller.signal.aborted; round++) {
  for (const scenario of scenarios) {
    if (controller.signal.aborted) break;
    console.log(`${round + 1}/${repeat} ${scenario.id}`);
    try {
      const result = await runLab({ scenario, mode: 'compare', optimization, baselineModel, apiKey: key, signal: controller.signal, filteredFirst: (round + report.results.length) % 2 === 1, phase: text => console.log(`  ${text}`) });
      report.results.push({ round: round + 1, ...result });
      console.log(`  Fixture checks: ${result.verdict?.passed === true ? 'passed' : 'incomplete or failed'}`);
    } catch (error) {
      report.results.push({ round: round + 1, scenarioId: scenario.id, error: (error instanceof Error ? error.message : 'Evaluation failed').split(key).join('[redacted]') });
      await save();
      throw error;
    }
    await save();
  }
}
report.completedAt = new Date().toISOString();
await save();
if (controller.signal.aborted || report.results.some(result => result.verdict?.passed !== true)) process.exitCode = 1;
console.log(`Saved ${report.results.length} pairs to ${resolve(output)}.`);
