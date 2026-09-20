import { JevClient, type JevClientConfig, type Provider } from "./client.js";
import { Router, type RouteOptions, type RouteResult, type Tier } from "./route.js";
import { Gate, type Capability, type GateResult } from "./gate.js";
import { Usher } from "./usher.js";
import { Filter, type FilterOptions, type FilterResult } from "./filter.js";
import { Compactor, type CompactOptions, type CompactResult } from "./compact.js";
import { StopGate, type StopOptions, type StopResult } from "./stop.js";
import { Screen } from "./screen.js";
import { Ledger, type Prices } from "./ledger.js";
import { totalTokens } from "./budget.js";
import { ZERO_USAGE } from "./core.js";
import type { AdmitResult, Candidate, StateValue, Usage } from "./types.js";

export interface JevusherConfig extends JevClientConfig {
  provider?: Provider;
  prices?: Prices;
}

export interface BeforeTurnOptions {
  turn: string;
  /** Recalled memories, retrieved docs — anything competing for the window. */
  memory?: Candidate[];
  /** Skills, MCP tools, subagents. */
  catalog?: Capability[];
  tiers?: Tier[];
  memoryBudget?: number;
  maxSkills?: number;
  /** Extra state for routing: repo facts, open files. */
  context?: StateValue;
  /** Skip routing. Default false. */
  skipRoute?: boolean;
}

export interface BeforeTurnResult {
  route: RouteResult | null;
  gate: GateResult | null;
  memory: AdmitResult | null;
  /** Everything that survived, ready to inject. */
  admitted: Candidate[];
  /** Capabilities to surface, usually zero or one. */
  skills: Capability[];
  usage: Usage;
  requests: number;
}

/**
 * The whole set, wired together.
 *
 * Seven lenses, one posture: Jev reads cheaply so the expensive model does not
 * have to. Admission lenses fail open — dropping something needed costs a whole
 * retry turn, admitting something spare costs a few hundred tokens. Selection
 * lenses fail closed, because surfacing the wrong tool invites a wrong call.
 */
export class Jevusher {
  readonly router: Router;
  readonly gate: Gate;
  readonly usher: Usher;
  readonly filter: Filter;
  readonly compactor: Compactor;
  readonly stopGate: StopGate;
  readonly screen: Screen;
  readonly ledger: Ledger;

  constructor(config: JevusherConfig = {}) {
    const provider = config.provider ?? new JevClient(config);
    const shared = { ...config, provider };
    this.router = new Router(shared);
    this.gate = new Gate(shared);
    this.usher = new Usher(shared);
    this.filter = new Filter(shared);
    this.compactor = new Compactor(shared);
    this.stopGate = new StopGate(shared);
    this.screen = new Screen(shared);
    this.ledger = new Ledger(config.prices);
  }

  /** J1 + J2 + J3 for one incoming turn, run concurrently. */
  async beforeTurn(options: BeforeTurnOptions): Promise<BeforeTurnResult> {
    const { turn, memory = [], catalog = [], tiers, memoryBudget = 4000, maxSkills = 1, context, skipRoute = false } = options;

    const routeArgs: RouteOptions = { turn, ...(context !== undefined && { context }), ...(tiers && { tiers }) };

    const [route, gate, admitted] = await Promise.all([
      skipRoute ? Promise.resolve(null) : this.router.route(routeArgs),
      catalog.length ? this.gate.select({ turn, catalog, maxSelected: maxSkills }) : Promise.resolve(null),
      memory.length ? this.usher.admit({ goal: turn, candidates: memory, budget: memoryBudget }) : Promise.resolve(null),
    ]);

    if (gate) {
      const catalogTokens = totalTokens(catalog.map((c) => ({ id: c.id, text: `${c.name}: ${c.detail ?? c.summary}` })));
      const selectedTokens = totalTokens(gate.selected.map((c) => ({ id: c.id, text: `${c.name}: ${c.detail ?? c.summary}` })));
      this.ledger.record("gate", { offered: catalogTokens, admitted: selectedTokens, jevUsage: gate.usage, requests: gate.requests });
    }
    if (admitted) {
      this.ledger.record("memory", {
        offered: admitted.tokensOffered,
        admitted: admitted.tokensAdmitted,
        jevUsage: admitted.jevUsage,
        requests: admitted.requests,
      });
    }
    if (route) {
      this.ledger.record("route", { offered: 0, admitted: 0, jevUsage: route.usage, requests: 1 });
    }

    const usage = sum([route?.usage, gate?.usage, admitted?.jevUsage]);
    const requests = (route ? 1 : 0) + (gate?.requests ?? 0) + (admitted?.requests ?? 0);

    return {
      route,
      gate,
      memory: admitted,
      admitted: admitted?.admitted ?? [],
      skills: gate?.selected ?? [],
      usage,
      requests,
    };
  }

  /** J4 — everything a tool just returned, before it lands in the transcript. */
  async filterToolResult(options: FilterOptions): Promise<FilterResult> {
    const result = await this.filter.apply(options);
    this.ledger.record("tool-result", {
      offered: result.tokensOffered,
      admitted: result.tokensAdmitted,
      jevUsage: sum([result.jevUsage, result.screenUsage]),
      requests: result.requests,
    });
    return result;
  }

  /** J5 — what survives compaction. */
  async beforeCompact(options: CompactOptions): Promise<CompactResult> {
    const result = await this.compactor.triage(options);
    this.ledger.record("compaction", {
      offered: result.tokensBefore,
      admitted: result.tokensKept,
      jevUsage: result.usage,
      requests: result.requests,
    });
    return result;
  }

  /** J6 — should this loop keep going? */
  async shouldStop(options: StopOptions): Promise<StopResult> {
    const result = await this.stopGate.check(options);
    this.ledger.record("stop", { offered: 0, admitted: 0, jevUsage: result.usage, requests: 1 });
    return result;
  }

  report() {
    return this.ledger.report();
  }
}

function sum(usages: (Usage | null | undefined)[]): Usage {
  return usages.reduce<Usage>(
    (total, usage) => ({
      input_tokens: total.input_tokens + (usage?.input_tokens ?? 0),
      output_tokens: total.output_tokens + (usage?.output_tokens ?? 0),
    }),
    { ...ZERO_USAGE },
  );
}
