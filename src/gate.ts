import { DEFAULT_MODEL, JevClient, type JevClientConfig, type Provider } from "./client.js";
import { asChoice, asNoul, asScore, runBatches, sumUsage, ZERO_USAGE } from "./core.js";
import { chunk } from "./budget.js";
import type { Question, SystemOneRequest, Usage } from "./types.js";

/** A skill, MCP tool, plugin, or subagent competing to be surfaced this turn. */
export interface Capability {
  id: string;
  name: string;
  /** One line. This is what stage one ranks on. */
  summary: string;
  /** Full description, read only by stage two for the shortlist. */
  detail?: string;
  meta?: Record<string, unknown>;
}

export const NONE = "__none__";

export interface GateOptions {
  turn: string;
  catalog: Capability[];
  /** How many to surface. Default 1. */
  maxSelected?: number;
  /** Shortlist size handed to stage two. Default 3. Set 0 to skip stage two. */
  shortlist?: number;
  /** Default 0.55. Below it, nothing is surfaced unless failOpen is on. */
  minConfidence?: number;
  /**
   * Default false. Surfacing the wrong capability is not free — it pollutes the
   * prompt and invites a wrong tool call — so this lens fails CLOSED by default.
   * Admission lenses fail open; selection lenses do not.
   */
  failOpen?: boolean;
  /** Skip everything when the turn plainly needs no capability. Default true. */
  checkNeed?: boolean;
  /** Default 0.2. */
  needThreshold?: number;
  /** Catalog entries per stage-one request. Default 96. */
  batchSize?: number;
}

export interface GateResult {
  /** What to surface. Empty means "surface nothing", which is a valid answer. */
  selected: Capability[];
  /** Stage-one ranking, highest first. */
  ranked: { capability: Capability; score: number; confidence: number }[];
  /** Stage-two distribution over the shortlist plus NONE. */
  probabilities: Record<string, number> | null;
  confidence: number | null;
  /** Probability the turn needs any capability at all. */
  need: number | null;
  reason: "selected" | "none-needed" | "low-confidence" | "empty-catalog" | "provider-error";
  usage: Usage;
  requests: number;
}

/**
 * J2 — capability gating.
 *
 * A full skill and tool catalog in the system prompt costs tens of thousands of
 * tokens on every single turn. Rank the catalog with Jev, read the top few
 * properly, and inject one line instead of two hundred descriptions.
 */
export class Gate {
  private readonly provider: Provider;

  constructor(config: JevClientConfig & { provider?: Provider } = {}) {
    this.provider = config.provider ?? new JevClient(config);
  }

  async select(options: GateOptions): Promise<GateResult> {
    const {
      turn,
      catalog,
      maxSelected = 1,
      shortlist = 3,
      minConfidence = 0.55,
      failOpen = false,
      checkNeed = true,
      needThreshold = 0.2,
      batchSize = 96,
    } = options;

    if (catalog.length === 0) return empty("empty-catalog");

    const batches = chunk(catalog, batchSize);
    const stageOne: SystemOneRequest[] = batches.map((batch, index) => ({
      model: this.provider.model ?? DEFAULT_MODEL,
      state: { turn, catalog: batch.map((c) => ({ id: c.id, name: c.name, summary: c.summary })) },
      questions: rankQuestions(batch, checkNeed && index === 0),
    }));

    let responses;
    try {
      responses = await runBatches(this.provider, stageOne);
    } catch {
      return { ...empty("provider-error"), selected: failOpen ? catalog.slice(0, maxSelected) : [] };
    }

    const need = asNoul(responses[0]?.answers?.need);
    const ranked: GateResult["ranked"] = [];
    batches.forEach((batch, batchIndex) => {
      const answers = responses[batchIndex]?.answers ?? {};
      batch.forEach((capability, position) => {
        const score = asScore(answers[`r${position}`]);
        ranked.push({
          capability,
          score: score?.score ?? 0,
          confidence: score?.confidence ?? 0,
        });
      });
    });
    ranked.sort((a, b) => b.score - a.score);

    let usage = sumUsage(responses);
    let requests = responses.length;

    if (need !== null && need < needThreshold) {
      return { selected: [], ranked, probabilities: null, confidence: null, need, reason: "none-needed", usage, requests };
    }

    const top = ranked.slice(0, Math.max(shortlist, maxSelected));
    if (shortlist === 0 || top.length === 0) {
      const selected = top.slice(0, maxSelected).filter((entry) => entry.confidence >= minConfidence || failOpen);
      return {
        selected: selected.map((entry) => entry.capability),
        ranked,
        probabilities: null,
        confidence: null,
        need,
        reason: selected.length ? "selected" : "low-confidence",
        usage,
        requests,
      };
    }

    // Stage two: read the shortlist properly, with an explicit way to reject all of them.
    const criteria: Record<string, string> = { [NONE]: "None of these fits this request." };
    for (const entry of top) {
      criteria[entry.capability.id] = entry.capability.detail ?? entry.capability.summary;
    }

    let finalResponses;
    try {
      finalResponses = await runBatches(this.provider, [
        {
          model: this.provider.model ?? DEFAULT_MODEL,
          state: { turn },
          questions: {
            pick: {
              type: "choice",
              instructions: "Which one of these should handle this request? Choose none if nothing fits well.",
              criteria,
            },
          },
        },
      ]);
    } catch {
      return { selected: failOpen ? top.slice(0, maxSelected).map((e) => e.capability) : [], ranked, probabilities: null, confidence: null, need, reason: "provider-error", usage, requests };
    }

    usage = {
      input_tokens: usage.input_tokens + sumUsage(finalResponses).input_tokens,
      output_tokens: usage.output_tokens + sumUsage(finalResponses).output_tokens,
    };
    requests += finalResponses.length;

    const pick = asChoice(finalResponses[0]?.answers?.pick);
    const trusted = (pick?.confidence ?? 0) >= minConfidence;

    if (!trusted && !failOpen) {
      return { selected: [], ranked, probabilities: pick?.probabilities ?? null, confidence: pick?.confidence ?? null, need, reason: "low-confidence", usage, requests };
    }
    if (pick?.choice === NONE && trusted) {
      return { selected: [], ranked, probabilities: pick.probabilities, confidence: pick.confidence, need, reason: "none-needed", usage, requests };
    }

    // Order the shortlist by the stage-two distribution, then take maxSelected.
    const probabilities = pick?.probabilities ?? {};
    const selected = top
      .filter((entry) => entry.capability.id !== NONE)
      .sort((a, b) => (probabilities[b.capability.id] ?? 0) - (probabilities[a.capability.id] ?? 0))
      .slice(0, maxSelected)
      .map((entry) => entry.capability);

    return {
      selected,
      ranked,
      probabilities: pick?.probabilities ?? null,
      confidence: pick?.confidence ?? null,
      need,
      reason: "selected",
      usage,
      requests,
    };
  }
}

function rankQuestions(batch: Capability[], withNeed: boolean): Record<string, Question> {
  const questions: Record<string, Question> = {};
  batch.forEach((capability, position) => {
    questions[`r${position}`] = {
      type: "score",
      instructions: {
        task: "How well does the catalog entry with this id match what the turn is asking for?",
        id: capability.id,
      },
      criteria: [
        "Unrelated to the request.",
        "Plausibly adjacent, but not what the request is about.",
        "A direct match for what the request needs.",
      ],
    };
  });
  if (withNeed) {
    questions.need = {
      type: "noul",
      instructions: "Does this turn call for any specialised capability at all, rather than a plain answer?",
      criteria: {
        true: "A specific skill, tool, or subagent would materially help.",
        false: "An ordinary answer or edit handles it; no special capability applies.",
      },
    };
  }
  return questions;
}

function empty(reason: GateResult["reason"]): GateResult {
  return {
    selected: [],
    ranked: [],
    probabilities: null,
    confidence: null,
    need: null,
    reason,
    usage: { ...ZERO_USAGE },
    requests: 0,
  };
}
