import { DEFAULT_MODEL, JevClient, type JevClientConfig, type Provider } from "./client.js";
import { asChoice, runBatches, sumUsage, ZERO_USAGE } from "./core.js";
import { candidateTokens, chunk, totalTokens } from "./budget.js";
import type { Candidate, Question, Usage } from "./types.js";

export type Disposition = "keep" | "summarize" | "drop";

export interface TriageVerdict {
  id: string;
  disposition: Disposition;
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
  /** Token ceiling for blocks kept verbatim. Default 8000. Overflow becomes `summarize`. */
  keepBudget?: number;
  /** Default 0.55. */
  minConfidence?: number;
  /** Default true: an untrusted verdict becomes `summarize`, never `drop`. */
  failOpen?: boolean;
  /** Blocks per request. Default 48. */
  batchSize?: number;
}

export interface CompactResult {
  keep: Candidate[];
  summarize: Candidate[];
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
 * Compaction normally means paying an expensive model to read the whole
 * transcript. Here Jev reads it instead and labels each block; the summarizing
 * model only ever sees the `summarize` pile, and `drop` costs nothing at all.
 */
export class Compactor {
  private readonly provider: Provider;

  constructor(config: JevClientConfig & { provider?: Provider } = {}) {
    this.provider = config.provider ?? new JevClient(config);
  }

  async triage(options: CompactOptions): Promise<CompactResult> {
    const { goal, blocks, keepBudget = 8000, minConfidence = 0.55, failOpen = true, batchSize = 48 } = options;
    const tokensBefore = totalTokens(blocks);
    if (blocks.length === 0) {
      return { keep: [], summarize: [], drop: [], verdicts: [], tokensBefore: 0, tokensKept: 0, usage: { ...ZERO_USAGE }, requests: 0 };
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
        keep: [],
        summarize: blocks,
        drop: [],
        verdicts: blocks.map((block) => ({
          id: block.id,
          disposition: "summarize" as const,
          probabilities: null,
          confidence: null,
          trusted: false,
          tokens: candidateTokens(block),
        })),
        tokensBefore,
        tokensKept: 0,
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
        const raw = (choice?.choice ?? "summarize") as Disposition;
        // Untrusted verdicts land on the safe middle rung, never on drop.
        const disposition: Disposition = trusted ? raw : failOpen ? "summarize" : raw;
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
    const summarize: Candidate[] = [];
    const drop: Candidate[] = [];
    let kept = 0;

    // Keep in transcript order; demote to summarize once the verbatim budget is spent.
    for (const verdict of verdicts) {
      const block = byId.get(verdict.id);
      if (!block) continue;
      if (verdict.disposition === "keep") {
        if (kept + verdict.tokens <= keepBudget) {
          kept += verdict.tokens;
          keep.push(block);
        } else {
          verdict.disposition = "summarize";
          summarize.push(block);
        }
      } else if (verdict.disposition === "summarize") {
        summarize.push(block);
      } else {
        drop.push(block);
      }
    }

    return { keep, summarize, drop, verdicts, tokensBefore, tokensKept: kept, usage: sumUsage(responses), requests: responses.length };
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
        summarize: "Its gist matters but its wording does not.",
        drop: "Superseded, redundant, or irrelevant to the remaining goal. Losing it changes nothing.",
      },
    };
  });
  return questions;
}
