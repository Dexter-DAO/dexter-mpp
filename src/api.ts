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

const settlementProofSchema = z.object({
  recipient: z.string(),
  amount: z.string(),
  asset: z.optional(z.string()),
  feePayer: z.optional(z.string()),
});

const settleResponseSchema = z.object({
  success: z.boolean(),
  signature: z.optional(z.string()),
  payer: z.optional(z.string()),
  network: z.optional(z.string()),
  settlement: z.optional(settlementProofSchema),
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

/**
 * Error thrown when settlement fails or verification detects a mismatch.
 * The `code` property contains a machine-readable error identifier such as
 * `"policy:program_not_allowed"`, `"settlement_recipient_mismatch"`, or
 * `"onchain_verification_amount_mismatch"`.
 */
export class SettlementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SettlementError";
    this.code = code;
  }
}

// ── Session Types ──────────────────────────────────────────────────────────

export type SessionOpenRequest = {
  buyer_wallet: string;
  buyer_swig_address: string;
  seller_wallet: string;
  deposit_atomic: string;
  network?: string;
  idle_timeout_seconds?: number;
  metadata?: Record<string, unknown>;
};

export type SessionOpenResponse = {
  success: true;
  channel_id: string;
  session_pubkey: string;
  deposit_atomic: string;
  network: string;
  channel_program: string;
};

export type SessionVoucherRequest = {
  channel_id: string;
  amount: string;
  meter?: string;
  units?: string;
  serverNonce: string;
};

export type SessionVoucherResponse = {
  success: true;
  voucher: {
    channelId: string;
    payer: string;
    recipient: string;
    cumulativeAmount: string;
    sequence: number;
    meter: string;
    units: string;
    serverNonce: string;
    chainId: string;
    channelProgram: string;
  };
  signature: string;
  signer: string;
  signatureType: "ed25519";
};

export type SessionCloseRequest = {
  channel_id: string;
};

export type SessionCloseResponse = {
  success: true;
  channel_id: string;
  settlement: {
    seller: string;
    amount_settled: string;
    buyer_refund: string;
    voucher_count: number;
    session_duration_seconds: number | null;
  };
};

// ── Client ──────────────────────────────────────────────────────────────────

export type DexterSettlementClientOptions = {
  /** Dexter settlement API base URL. Default: `https://x402.dexter.cash` */
  baseUrl?: string;
  /** Timeout for `/mpp/prepare` calls in milliseconds. Default: `10000` (10s). */
  prepareTimeoutMs?: number;
  /** Timeout for `/mpp/settle` calls in milliseconds. Default: `30000` (30s). */
  settleTimeoutMs?: number;
};

/**
 * HTTP client for Dexter's MPP settlement API. Used internally by the
 * server charge method; also available directly via `@dexterai/mpp/api`
 * for custom integrations.
 *
 * @example
 * ```ts
 * import { DexterSettlementClient } from '@dexterai/mpp/api';
 * const client = new DexterSettlementClient();
 * const info = await client.prepare({ network: 'devnet' });
 * ```
 */
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

  // ── Session Endpoints ───────────────────────────────────────────────────

  async sessionOpen(params: SessionOpenRequest): Promise<SessionOpenResponse> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/mpp/session/open`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      },
      this.settleTimeoutMs,
    );

    const data = await res.json();
    if (!data.success) {
      throw new SettlementError(
        data.error ?? "session_open_failed",
        data.detail ?? data.error ?? "Session open failed",
      );
    }
    return data as SessionOpenResponse;
  }

  async sessionVoucher(params: SessionVoucherRequest): Promise<SessionVoucherResponse> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/mpp/session/voucher`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      },
      this.prepareTimeoutMs,
    );

    const data = await res.json();
    if (!data.success) {
      throw new SettlementError(
        data.error ?? "voucher_failed",
        data.detail ?? data.error ?? "Voucher signing failed",
      );
    }
    return data as SessionVoucherResponse;
  }

  async sessionClose(params: SessionCloseRequest): Promise<SessionCloseResponse> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/mpp/session/close`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      },
      this.settleTimeoutMs,
    );

    const data = await res.json();
    if (!data.success) {
      throw new SettlementError(
        data.error ?? "session_close_failed",
        data.detail ?? data.error ?? "Session close failed",
      );
    }
    return data as SessionCloseResponse;
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
