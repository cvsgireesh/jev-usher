import type { SystemOneRequest, SystemOneResponse } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
export const DEFAULT_MODEL = "jev-latest";

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export interface JevClientConfig {
  /** Defaults to process.env.JEV_API_KEY, then TYPESAFE_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Retries on 429 and 5xx. Default 3. */
  maxRetries?: number;
  fetch?: typeof fetch;
}

/** Anything that can answer a System One request. Swap it out in tests. */
export interface Provider {
  evaluate(request: SystemOneRequest): Promise<SystemOneResponse>;
  readonly model: string;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export class JevClient implements Provider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: JevClientConfig = {}) {
    const apiKey = config.apiKey ?? process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
      throw new JevError("No API key. Pass { apiKey } or set JEV_API_KEY.");
    }
    this.apiKey = apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = config.model ?? DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async evaluate(request: SystemOneRequest): Promise<SystemOneResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.once(request);
      } catch (error) {
        lastError = error;
        const status = error instanceof JevError ? error.status : undefined;
        const retryable = status === undefined || RETRYABLE.has(status);
        if (!retryable || attempt === this.maxRetries) break;
        await sleep(Math.min(2 ** attempt * 250, 4_000) + Math.random() * 250);
      }
    }
    throw lastError;
  }

  private async once(request: SystemOneRequest): Promise<SystemOneResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new JevError(`Jev request failed: ${response.status}`, response.status, body.slice(0, 500));
      }
      return (await response.json()) as SystemOneResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
