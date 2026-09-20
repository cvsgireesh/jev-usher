import { DEFAULT_MODEL, JevClient, type JevClientConfig, type Provider } from "./client.js";
import { asChoice, runBatches, sumUsage, ZERO_USAGE } from "./core.js";
import { candidateTokens, chunk, totalTokens } from "./budget.js";
import type { Candidate, Question, Usage } from "./types.js";

export type Disposition = "keep" | "shorten" | "drop";

export interface TriageVerdict {
  id: string;
  disposition: Disposition;
  /** Present when the block was shortened: the text that survives. */
  shortened?: string;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  trusted: boolean;
  tokens: number;
}

export interface CompactOptions {
  /** What the session is still trying to accomplish. Survival is judged against this. */
  goal: string;
  /** Transcript blocks, oldest first. */
  blocks: Candidate[];
  /** Token ceiling for blocks kept verbatim. Default 8000. Overflow is shortened. */
  keepBudget?: number;
  /** Default 0.55. */
  minConfidence?: number;
  /** Default true: an untrusted verdict is shortened, never dropped. */
  failOpen?: boolean;
  /** Blocks per request. Default 48. */
  batchSize?: number;
  /** Characters a shortened block keeps from its start. Default 300. */
  headChars?: number;
}

export interface CompactResult {
  /** Untouched, byte for byte. */
  keep: Candidate[];
  /** Cut to their opening, with a marker naming what was removed. */
  shortened: Candidate[];
  drop: Candidate[];
  verdicts: TriageVerdict[];
  tokensBefore: number;
  tokensKept: number;
  usage: Usage;
  requests: number;
}

/**
 * J5 — compaction triage.
 *
 * Compaction usually means paying a model to rewrite the transcript as prose.
 * That costs money and loses things: an exact path, an error string, a number
 * that mattered. Measurement on a real session put the rewrite at $0.0215 a go,
 * for a result that is strictly less faithful than the text it replaced.
 *
 * So nothing here is rewritten. Jev decides, per block, between three outcomes,
 * and the surviving text is always the original text:
 *
 *   keep     untouched, byte for byte
 *   shorten  cut to its opening, with a marker naming what was removed
 *   drop     gone
 *
 * No second model runs, so triage costs only what Jev costs, and every word the
 * next turn reads is a word that was really written.
 */
export class Compactor {
  private readonly provider: Provider;

  constructor(config: JevClientConfig & { provider?: Provider } = {}) {
    this.provider = config.provider ?? new JevClient(config);
  }

  async triage(options: CompactOptions): Promise<CompactResult> {
    const {
      goal,
      blocks,
      keepBudget = 8000,
      minConfidence = 0.55,
      failOpen = true,
      batchSize = 48,
      headChars = 300,
    } = options;
    const tokensBefore = totalTokens(blocks);
    if (blocks.length === 0) {
      return { keep: [], shortened: [], drop: [], verdicts: [], tokensBefore: 0, tokensKept: 0, usage: { ...ZERO_USAGE }, requests: 0 };
    }

    const batches = chunk(blocks, batchSize);
    let responses;
    try {
      responses = await runBatches(
        this.provider,
        batches.map((batch) => ({
          model: this.provider.model ?? DEFAULT_MODEL,
          state: { goal, blocks: batch.map(({ id, text }) => ({ id, text })) },
          questions: triageQuestions(batch),
        })),
      );
    } catch {
      // Unreachable provider must never silently shrink a transcript.
      if (!failOpen) throw new Error("compaction triage failed and failOpen is off");
      return {
        keep: blocks,
        shortened: [],
        drop: [],
        verdicts: blocks.map((block) => ({
          id: block.id,
          disposition: "keep" as const,
          probabilities: null,
          confidence: null,
          trusted: false,
          tokens: candidateTokens(block),
        })),
        tokensBefore,
        tokensKept: tokensBefore,
        usage: { ...ZERO_USAGE },
        requests: 0,
      };
    }

    const verdicts: TriageVerdict[] = [];
    batches.forEach((batch, batchIndex) => {
      const answers = responses[batchIndex]?.answers ?? {};
      batch.forEach((block, position) => {
        const choice = asChoice(answers[`b${position}`]);
        const trusted = (choice?.confidence ?? 0) >= minConfidence;
        const raw = (choice?.choice ?? "shorten") as Disposition;
        // Untrusted verdicts land on the safe middle rung, never on drop.
        const disposition: Disposition = trusted ? raw : failOpen ? "shorten" : raw;
        verdicts.push({
          id: block.id,
          disposition,
          probabilities: choice?.probabilities ?? null,
          confidence: choice?.confidence ?? null,
          trusted,
          tokens: candidateTokens(block),
        });
      });
    });

    const byId = new Map(blocks.map((block) => [block.id, block]));
    const keep: Candidate[] = [];
    const shortened: Candidate[] = [];
    const drop: Candidate[] = [];
    let kept = 0;

    // Transcript order is preserved. A block demotes to `shorten` once the
    // verbatim budget is spent, so the budget caps what stays whole without
    // ever deciding what disappears.
    for (const verdict of verdicts) {
      const block = byId.get(verdict.id);
      if (!block) continue;

      if (verdict.disposition === "keep" && kept + verdict.tokens <= keepBudget) {
        kept += verdict.tokens;
        keep.push(block);
        continue;
      }
      if (verdict.disposition === "drop") {
        drop.push(block);
        continue;
      }

      verdict.disposition = "shorten";
      const short = shorten(block.text, headChars);
      verdict.shortened = short;
      shortened.push({ ...block, text: short });
      kept += Math.ceil(short.length / 4);
    }

    return { keep, shortened, drop, verdicts, tokensBefore, tokensKept: kept, usage: sumUsage(responses), requests: responses.length };
  }
}

function triageQuestions(batch: Candidate[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  batch.forEach((block, position) => {
    questions[`b${position}`] = {
      type: "choice",
      instructions: {
        task: "What should happen to the transcript block with this id when the conversation is compacted?",
        id: block.id,
      },
      criteria: {
        keep: "Its exact wording still matters: a decision, a constraint, an error message, or code that will be referenced again.",
        shorten: "Worth knowing it happened, but the body of it is no longer needed. Its opening alone would do.",
        drop: "Superseded, redundant, or irrelevant to the remaining goal. Losing it changes nothing.",
      },
    };
  });
  return questions;
}

/**
 * Cut a block to its opening and say what went.
 *
 * The surviving characters are the original characters. Nothing is paraphrased,
 * so a path or an error string inside the head survives exactly as written.
 */
function shorten(text: string, headChars: number): string {
  if (text.length <= headChars) return text;
  const removed = text.length - headChars;
  return `${text.slice(0, headChars)}\n[... ${removed.toLocaleString()} characters removed ...]`;
}
