import type { JevClientConfig, Provider } from "./client.js";
import { Usher, type AdmitOptions } from "./usher.js";
import { Screen, type ScreenFinding } from "./screen.js";
import { ZERO_USAGE } from "./core.js";
import type { AdmitResult, Candidate, Usage } from "./types.js";

export interface FilterOptions extends Omit<AdmitOptions, "candidates"> {
  /** Chunks of tool output: grep hits, page sections, log lines, file slices. */
  chunks: Candidate[];
  /** Where this came from. `web` and `mcp` default to screening on. */
  source?: "file" | "shell" | "web" | "mcp" | string;
  /** Screen for hostile instructions before judging relevance. Default: on for web and mcp. */
  screen?: boolean;
  /** Drop blocked chunks entirely instead of passing them through flagged. Default true. */
  dropBlocked?: boolean;
}

export interface FilterResult extends AdmitResult {
  findings: ScreenFinding[];
  /** Chunks removed by the screen before relevance was ever considered. */
  blocked: Candidate[];
  /** Chunks the screen was unsure about. They still compete for admission. */
  flagged: Candidate[];
  screenUsage: Usage;
}

/**
 * J4 — tool-result filtering.
 *
 * Grep hits, fetched pages, log dumps. Usually the single largest sink in an
 * agent transcript, and the one nobody budgets for. Two passes in one call
 * shape: screen out anything issuing instructions, then admit only what the
 * current goal actually needs.
 */
export class Filter {
  private readonly usher: Usher;
  private readonly screener: Screen;

  constructor(config: JevClientConfig & { provider?: Provider } = {}) {
    this.usher = new Usher(config);
    this.screener = new Screen(config);
  }

  async apply(options: FilterOptions): Promise<FilterResult> {
    const { chunks, source, screen, dropBlocked = true, ...admitOptions } = options;
    const shouldScreen = screen ?? (source === "web" || source === "mcp");

    let findings: ScreenFinding[] = [];
    let blocked: Candidate[] = [];
    let flagged: Candidate[] = [];
    let screenUsage: Usage = { ...ZERO_USAGE };
    let survivors = chunks;

    if (shouldScreen && chunks.length > 0) {
      const result = await this.screener.check({ items: chunks, source });
      findings = result.findings;
      blocked = result.blocked;
      flagged = result.flagged;
      screenUsage = result.usage;
      survivors = dropBlocked ? [...result.passed, ...result.flagged] : chunks;
      // Preserve the caller's ordering rather than the screen's bucketing.
      const keep = new Set(survivors.map((chunk) => chunk.id));
      survivors = chunks.filter((chunk) => keep.has(chunk.id));
    }

    const admitted = await this.usher.admit({ ...admitOptions, candidates: survivors });
    return { ...admitted, findings, blocked, flagged, screenUsage };
  }
}
