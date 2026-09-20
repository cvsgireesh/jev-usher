/** Run one scenario from the terminal. Useful for checking a scenario before filming it. */
import { runScenario, SCENARIOS } from "./scenarios.js";

const id = process.argv[2] ?? "bug";
const result = await runScenario(id);
const { without, withDoorman, doorman, delta } = result;

console.log(`\n${result.scenario.label}`);
console.log(`"${result.scenario.question}"\n`);
console.log(`                  WITHOUT        WITH DOORMAN`);
console.log(`  material tok    ${String(without.materialTokens).padEnd(15)}${withDoorman.materialTokens}`);
console.log(`  total tok       ${String(without.inputTokens).padEnd(15)}${withDoorman.inputTokens}`);
console.log(`  seconds         ${(without.ms / 1000).toFixed(1).padEnd(15)}${(withDoorman.ms / 1000).toFixed(1)}`);
console.log(`  cost            $${without.costUsd.toFixed(4).padEnd(14)}$${withDoorman.costUsd.toFixed(4)}`);
console.log(`\n  doorman: ${doorman.note}`);
console.log(`  doorman cost: $${doorman.jevCostUsd.toFixed(5)} (${doorman.jevTokens} tokens, ${doorman.jevMs}ms)`);
if (doorman.routeTier) console.log(`  doorman would route to: ${doorman.routeTier} (${doorman.routeModel})`);
console.log(`\n  fixed floor (same both sides): ${result.floorTokens} tokens`);
console.log(`  delta: ${delta.materialTokens} tokens of material, $${delta.costUsd.toFixed(4)}, ${(delta.ms / 1000).toFixed(1)}s\n`);
console.log(`--- WITHOUT ---\n${without.answer}\n`);
console.log(`--- WITH DOORMAN ---\n${withDoorman.answer}\n`);
console.log(`(scenarios: ${SCENARIOS.map((s) => s.id).join(", ")})`);
