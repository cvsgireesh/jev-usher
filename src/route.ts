import { DEFAULT_MODEL, JevClient, type JevClientConfig, type Provider } from "./client.js";
import { requiredText, ids, threshold } from "./validation.js";
import { asChoice, asNoul, runBatches, sumUsage, ZERO_USAGE } from "./core.js";
import type { StateValue, Usage } from "./types.js";

/** One destination a turn can be routed to. */
export interface Tier {
  id: string;
  /** What kind of work belongs here. This is the rubric Jev reads. */
  description: string;
  /** Free-form; carry your model id, effort setting, or anything else. */
  meta?: Record<string, unknown>;
}

/**
 * A starting rubric for coding agents. Replace the descriptions with your own
 * boundary cases — that is where routing accuracy actually comes from.
 */
export const DEFAULT_TIERS: Tier[] = [
  {
    id: "trivial",
    description:
      "Answerable in one or two sentences from general knowledge. No files to read, no code to write, no judgement call.",
    meta: { model: "claude-haiku-4-5-20251001" },
  },
  {
    id: "mechanical",
    description:
      "Well-specified work with an obvious correct shape: a rename, a straightforward edit, running a command, bulk changes across files.",
    meta: { model: "claude-sonnet-5" },
  },
  {
    id: "judgement",
    description:
      "User-facing work where taste matters: UI, API shape, naming, copy, or a review where the right answer is arguable.",
    meta: { model: "claude-opus-5" },
  },
  {
    id: "hard",
    description:
      "Open-ended or architectural: unclear cause, competing designs, multi-step planning, or a problem that has already resisted one attempt.",
    meta: { model: "claude-opus-5", effort: "high" },
  },
];

export interface RouteOptions {
  /** The user's turn, verbatim. */
  turn: string;
  /** Anything else worth judging against: repo facts, open files, recent errors. */
  context?: StateValue;
  /** Default: DEFAULT_TIERS. */
  tiers?: Tier[];
  /** Tier id to use when confidence is below the floor. Default: the last tier. */
  fallback?: string;
  /** Default 0.55. */
  minConfidence?: number;
  /** Also ask whether the turn needs to read files or call tools. Default true. */
  probeWork?: boolean;
}

export interface RouteResult {
  /** The tier to use, after the confidence floor has been applied. */
  tier: Tier;
  /** What Jev actually picked, before the floor. */
  raw: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  /** True when confidence cleared the floor. */
  trusted: boolean;
  /** Probability the turn needs to read project files. null when probeWork is off. */
  needsFiles: number | null;
  /** Probability the turn needs to call tools or run commands. */
  needsTools: number | null;
  usage: Usage;
  model: string | null;
}

/**
 * J1 — intent and effort routing.
 *
 * One Choice over your tiers, plus two cheap probes about whether the turn
 * needs to touch the filesystem at all. Most turns are not Opus turns.
 */
export class Router {
  private readonly provider: Provider;

  constructor(config: JevClientConfig & { provider?: Provider } = {}) {
    this.provider = config.provider ?? new JevClient(config);
  }

  async route(options: RouteOptions): Promise<RouteResult> {
    const {
      turn,
      context,
      tiers = DEFAULT_TIERS,
      minConfidence = 0.55,
      probeWork = true,
    } = options;

    requiredText(turn, "turn");
    ids(tiers);
    threshold(minConfidence, "minConfidence");
    if (tiers.length > 255) throw new RangeError("route supports at most 255 tiers");
    if (tiers.length < 2) throw new RangeError("route needs at least two tiers");
    const fallbackId = options.fallback ?? tiers[tiers.length - 1]!.id;
    const fallback = tiers.find((tier) => tier.id === fallbackId);
    if (!fallback) throw new RangeError(`fallback tier "${fallbackId}" is not in tiers`);

    const criteria: Record<string, string> = Object.create(null);
    for (const tier of tiers) criteria[tier.id] = tier.description;

    const questions: Record<string, import("./types.js").Question> = {
      tier: {
        type: "choice",
        instructions: "Which tier of effort does handling this request actually require?",
        criteria,
      },
    };
    if (probeWork) {
      questions.needs_files = {
        type: "noul",
        instructions: "Does answering this request require reading the project's files?",
        criteria: {
          true: "Specific project code, config or data must be read first.",
          false: "Answerable from general knowledge or from what is already stated.",
        },
      };
      questions.needs_tools = {
        type: "noul",
        instructions: "Does handling this request require running commands or calling tools?",
        criteria: {
          true: "Something must be executed, fetched, or changed on the system.",
          false: "A written answer is the whole deliverable.",
        },
      };
    }

    let responses;
    try {
      responses = await runBatches(this.provider, [
        {
          model: this.provider.model ?? DEFAULT_MODEL,
          state: context === undefined ? { turn } : { turn, context },
          questions,
        },
      ]);
    } catch {
      return {
        tier: fallback,
        raw: null,
        probabilities: null,
        confidence: null,
        trusted: false,
        needsFiles: null,
        needsTools: null,
        usage: { ...ZERO_USAGE },
        model: null,
      };
    }

    const answers = responses[0]?.answers ?? {};
    const choice = asChoice(answers.tier);
    const trusted = (choice?.confidence ?? 0) >= minConfidence;
    const picked = trusted ? tiers.find((tier) => tier.id === choice?.choice) : undefined;

    return {
      tier: picked ?? fallback,
      raw: choice?.choice ?? null,
      probabilities: choice?.probabilities ?? null,
      confidence: choice?.confidence ?? null,
      trusted: trusted && picked !== undefined,
      needsFiles: asNoul(answers.needs_files),
      needsTools: asNoul(answers.needs_tools),
      usage: sumUsage(responses),
      model: responses[0]?.model ?? null,
    };
  }
}
