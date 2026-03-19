import { z } from "mppx";
import { DEFAULT_DEXTER_API_URL } from "./constants.js";

const DEFAULT_PREPARE_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;

// ── Response schemas ────────────────────────────────────────────────────────

const prepareResponseSchema = z.object({
  feePayer: z.string(),
  recentBlockhash: z.string(),
  lastValidBlockHeight: z.optional(z.number()),
  network: z.string(),
  splToken: z.string(),
  decimals: z.number(),
  tokenProgram: z.string(),
});

const settleResponseSchema = z.object({
  success: z.boolean(),
  signature: z.optional(z.string()),
  payer: z.optional(z.string()),
  network: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(z.string()),
  detail: z.optional(z.string()),
});

// ── Types ───────────────────────────────────────────────────────────────────

export type PrepareRequest = {
  network?: string;
};

export type PrepareResponse = z.infer<typeof prepareResponseSchema>;

export type SettleRequest = {
  transaction: string;
  recipient: string;
  amount: string;
  asset: string;
  network: string;
};

export type SettleResponse = z.infer<typeof settleResponseSchema>;

// ── Errors ──────────────────────────────────────────────────────────────────

export class SettlementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SettlementError";
    this.code = code;
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export type DexterSettlementClientOptions = {
  baseUrl?: string;
  prepareTimeoutMs?: number;
  settleTimeoutMs?: number;
};

export class DexterSettlementClient {
  private readonly baseUrl: string;
  private readonly prepareTimeoutMs: number;
  private readonly settleTimeoutMs: number;

  constructor(baseUrlOrOptions?: string | DexterSettlementClientOptions) {
    if (typeof baseUrlOrOptions === "string") {
      this.baseUrl = baseUrlOrOptions.replace(/\/+$/, "");
      this.prepareTimeoutMs = DEFAULT_PREPARE_TIMEOUT_MS;
      this.settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS;
    } else {
      const opts = baseUrlOrOptions ?? {};
      this.baseUrl = (opts.baseUrl ?? DEFAULT_DEXTER_API_URL).replace(/\/+$/, "");
      this.prepareTimeoutMs = opts.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
      this.settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    }
  }

  async prepare(params: PrepareRequest): Promise<PrepareResponse> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/mpp/prepare`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      },
      this.prepareTimeoutMs,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Dexter prepare failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const parsed = prepareResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        `Dexter prepare returned invalid response: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }

  async settle(params: SettleRequest): Promise<SettleResponse> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/mpp/settle`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      },
      this.settleTimeoutMs,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Dexter settle failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const parsed = settleResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        `Dexter settle returned invalid response: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Dexter API request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
