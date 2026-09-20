import { integer, validateResponse } from "./validation.js";
import type { SystemOneRequest, SystemOneResponse } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
export const DEFAULT_MODEL = "jev-1.13.0";

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
    readonly retryAfterMs?: number,
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

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

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
    integer(this.timeoutMs, "timeoutMs", 1);
    integer(this.maxRetries, "maxRetries");
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async evaluate(request: SystemOneRequest): Promise<SystemOneResponse> {
    const stateBytes = Buffer.byteLength(JSON.stringify(request.state), "utf8");
    const questionBytes = Object.values(request.questions).map(q => Buffer.byteLength(JSON.stringify(q), "utf8"));
    // Conservative byte bounds: avoid depending on a different model's tokenizer.
    // Callers with larger inputs must split candidates, not silently truncate them.
    if (stateBytes + Math.max(0, ...questionBytes) > 32_000 ||
        Buffer.byteLength(JSON.stringify(request), "utf8") > 64_000) {
      throw new JevError("Request exceeds conservative byte budget; split state or questions");
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.once(request);
      } catch (error) {
        lastError = error;
        const status = error instanceof JevError ? error.status : undefined;
        const retryable = !(error instanceof SyntaxError) &&
          (status === undefined ? !(error instanceof JevError) : RETRYABLE.has(status));
        if (!retryable || attempt === this.maxRetries) break;
        const wait = error instanceof JevError ? error.retryAfterMs : undefined;
        // Do not wait indefinitely inside an agent hook. A caller may retry later.
        if (wait !== undefined && wait > this.timeoutMs) break;
        await sleep(wait ?? (Math.min(2 ** attempt * 250, 4_000) + Math.random() * 250));
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
        redirect: "error",
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const retryAfter = response.headers.get("retry-after");
        const delay = retryAfter === null ? undefined : /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
        throw new JevError(`Jev request failed: ${response.status}`, response.status, body.slice(0, 500),
          delay !== undefined && Number.isFinite(delay) ? delay : undefined);
      }
      const body: unknown = await response.json();
      try { return validateResponse(body, request); }
      catch { throw new JevError("Malformed Jev response"); }
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
