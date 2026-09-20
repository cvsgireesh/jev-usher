import { DEFAULT_MODEL, JevClient, type JevClientConfig, type Provider } from "./client.js";
import { asChoice, runBatches, sumUsage, ZERO_USAGE } from "./core.js";
import { requiredText, candidates, integer, nonNegative, threshold } from "./validation.js";
import { candidateTokens, boundedChunks, totalTokens } from "./budget.js";
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
  /** Default true: an untrusted verdict is kept verbatim, even over keepBudget. */
  failOpen?: boolean;
  /** Blocks per request. Default 48. */
  batchSize?: number;
  /** Characters a shortened block keeps from its start. Default 300. */
  headChars?: number;
}

export interface CompactResult {
  /** Surviving blocks in original order, including shortened blocks. */
  retained: Candidate[];
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
 * Extractive, lossy reduction of text blocks. Kept text is unchanged; shortened
 * and dropped blocks lose information. Callers own role/tool pairing, protected
 * instructions, recovery, and the final model context limit.
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
    requiredText(goal, "goal");
    candidates(blocks);
    nonNegative(keepBudget, "keepBudget");
    integer(headChars, "headChars");
    integer(batchSize, "batchSize", 1);
    threshold(minConfidence, "minConfidence");
    const tokensBefore = totalTokens(blocks);
    if (blocks.length === 0) {
      return { retained: [], keep: [], shortened: [], drop: [], verdicts: [], tokensBefore: 0, tokensKept: 0, usage: { ...ZERO_USAGE }, requests: 0 };
    }

    const batches = boundedChunks(blocks, batchSize, ({ id, text }) => ({ id, text }));
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
        retained: blocks,
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
        const valid = choice !== null && ["keep", "shorten", "drop"].includes(choice.choice);
        const trusted = valid && choice.confidence >= minConfidence;
        const raw = (valid ? choice.choice : "keep") as Disposition;
        // Missing or uncertain evidence cannot justify deleting text.
        const disposition: Disposition = trusted ? raw : failOpen ? "keep" : raw;
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
    const retained: Candidate[] = [];
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

      if (verdict.disposition === "keep" && (!verdict.trusted && failOpen || kept + verdict.tokens <= keepBudget)) {
        kept += verdict.tokens;
        keep.push(block);
        retained.push(block);
        continue;
      }
      if (verdict.disposition === "drop") {
        drop.push(block);
        continue;
      }

      verdict.disposition = "shorten";
      const short = shorten(block.text, headChars);
      verdict.shortened = short;
      const tokens = short === block.text ? candidateTokens(block) : Math.ceil(short.length / 4);
      const reduced = { ...block, text: short, tokens };
      shortened.push(reduced);
      retained.push(reduced);
      kept += tokens;
    }

    return { retained, keep, shortened, drop, verdicts, tokensBefore, tokensKept: kept, usage: sumUsage(responses), requests: responses.length };
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
  // Avoid splitting a UTF-16 surrogate pair.
  let end = headChars;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  const removed = text.length - end;
  const result = `${text.slice(0, end)}\n[... ${removed} characters removed ...]`;
  return result.length < text.length ? result : text;
}
