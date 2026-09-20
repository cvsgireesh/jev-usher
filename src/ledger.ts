import type { Usage } from "./types.js";

/** Input price per million tokens, for turning token counts into money. */
export interface Prices {
  /** Default 0.042 — jev-1.13 input. Output is free. */
  jev?: number;
  /** The model Jevusher is protecting. Default 15 (Opus-class input). */
  target?: number;
}

export interface LedgerEntry {
  lens: string;
  at: number;
  /** Tokens that would have reached the target model without this lens. */
  offered: number;
  /** Tokens that actually reached it. */
  admitted: number;
  jevUsage: Usage;
  requests: number;
}

export interface LedgerReport {
  entries: number;
  byLens: Record<string, { offered: number; admitted: number; jevTokens: number; requests: number }>;
  offered: number;
  admitted: number;
  /** Tokens kept out of the target model. */
  saved: number;
  jevTokens: number;
  requests: number;
  cost: {
    jev: number;
    /** What the offered tokens would have cost at the target model's input price. */
    targetWithout: number;
    targetWith: number;
    /** Net saving after paying for Jev. Can be negative on small inputs. */
    net: number;
  };
}

/**
 * The only number that matters is tokens-into-the-expensive-model, and money per
 * completed task. Not how many Jev calls you made. Log both sides from day one,
 * and be skeptical of the result — including this project's claims about it.
 */
export class Ledger {
  private readonly entries: LedgerEntry[] = [];

  constructor(private readonly prices: Prices = {}) {}

  record(lens: string, data: { offered: number; admitted: number; jevUsage: Usage; requests: number }): void {
    this.entries.push({ lens, at: Date.now(), ...data });
  }

  get length(): number {
    return this.entries.length;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries.length = 0;
  }

  report(): LedgerReport {
    const jevPrice = this.prices.jev ?? 0.042;
    const targetPrice = this.prices.target ?? 15;
    const byLens: LedgerReport["byLens"] = Object.create(null);
    let offered = 0;
    let admitted = 0;
    let jevTokens = 0;
    let requests = 0;

    for (const entry of this.entries) {
      const bucket = (byLens[entry.lens] ??= { offered: 0, admitted: 0, jevTokens: 0, requests: 0 });
      bucket.offered += entry.offered;
      bucket.admitted += entry.admitted;
      bucket.jevTokens += entry.jevUsage.input_tokens;
      bucket.requests += entry.requests;
      offered += entry.offered;
      admitted += entry.admitted;
      jevTokens += entry.jevUsage.input_tokens;
      requests += entry.requests;
    }

    const jevCost = (jevTokens / 1_000_000) * jevPrice;
    const targetWithout = (offered / 1_000_000) * targetPrice;
    const targetWith = (admitted / 1_000_000) * targetPrice;

    return {
      entries: this.entries.length,
      byLens,
      offered,
      admitted,
      saved: offered - admitted,
      jevTokens,
      requests,
      cost: {
        jev: jevCost,
        targetWithout,
        targetWith,
        net: targetWithout - targetWith - jevCost,
      },
    };
  }
}
