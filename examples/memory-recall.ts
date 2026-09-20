/**
 * Live demo: a handful of recalled "memories", one real goal, one Jev request.
 *
 *   JEV_API_KEY=... npx tsx examples/memory-recall.ts
 */
import { Usher, type Candidate } from "../src/index.js";

const goal = "Users report the login page redirects in a loop, but only on Safari.";

const recalled: Candidate[] = [
  { id: "mem:cookie", text: "March 2026: session cookie SameSite was tightened from Lax to Strict." },
  { id: "mem:safari", text: "Safari's ITP blocks third-party cookies by default, unlike Chrome." },
  { id: "mem:tailwind", text: "The project uses Tailwind v4 for styling; design tokens live in theme.css." },
  { id: "mem:deploy", text: "Deploys go out via GitHub Actions to Fly.io on merge to main." },
  { id: "mem:redirect", text: "auth/callback.ts redirects to / when no session cookie is present." },
  { id: "mem:standup", text: "Standup moved to 9:15am on Tuesdays." },
];

const usher = new Usher();
const result = await usher.admit({ goal, candidates: recalled, budget: 2000 });

console.log(`goal: ${goal}\n`);
console.log(`need context: ${result.need?.toFixed(2) ?? "n/a"}\n`);
for (const verdict of result.verdicts) {
  const mark = verdict.admitted ? "IN " : "OUT";
  console.log(
    `${mark} ${verdict.id.padEnd(14)} score=${verdict.score?.toFixed(2) ?? "-"} ` +
      `conf=${verdict.confidence?.toFixed(2) ?? "-"} ${verdict.reason}`,
  );
}
console.log(
  `\noffered ${result.tokensOffered} tok -> admitted ${result.tokensAdmitted} tok ` +
    `(${result.requests} request, jev read ${result.jevUsage.input_tokens} tok)`,
);
