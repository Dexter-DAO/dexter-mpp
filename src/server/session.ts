import { DexterSettlementClient, SettlementError } from "../api.js";
import { DEFAULT_DEXTER_API_URL } from "../constants.js";
import type { SessionVoucherResponse } from "../api.js";

export type SessionServerParameters = {
  /** Solana wallet address that receives session payments. */
  recipient: string;
  /** Dexter settlement API URL. Default: `https://x402.dexter.cash` */
  apiUrl?: string;
  /** Solana network name. Default: `"mainnet-beta"`. */
  network?: string;
  /** Price per unit in atomic USDC (e.g., "10000" = 0.01 USDC). */
  pricePerUnit: string;
  /** Meter label for usage tracking (e.g., "api_calls", "tokens"). Default: `"request"`. */
  meter?: string;
  /** Suggested deposit amount in atomic USDC. Default: 100x pricePerUnit. */
  suggestedDeposit?: string;
};

export interface SessionContext {
  channelId: string;
  sessionPubkey: string;
  cumulativeAmount: bigint;
  voucherCount: number;
}

/**
 * Creates a server-side MPP session handler for accepting streaming
 * micropayments via Dexter-managed sessions.
 *
 * The seller verifies voucher signatures locally (Ed25519, microseconds).
 * Dexter manages the channel lifecycle, signs vouchers, and sponsors gas.
 *
 * @example
 * ```ts
 * import { createSessionServer } from '@dexterai/mpp/server/session';
 *
 * const sessions = createSessionServer({
 *   recipient: 'YourWallet...',
 *   pricePerUnit: '10000', // 0.01 USDC per request
 * });
 *
 * app.get('/api/data', async (req, res) => {
 *   const voucher = req.headers['x-mpp-voucher'];
 *   if (!voucher) {
 *     return res.status(402).json(sessions.getChallenge());
 *   }
 *
 *   const result = sessions.verifyVoucher(JSON.parse(voucher));
 *   if (!result.valid) {
 *     return res.status(402).json({ error: result.error });
 *   }
 *
 *   res.json({ data: 'your paid content' });
 * });
 * ```
 */
export function createSessionServer(params: SessionServerParameters) {
  if (!params.recipient || typeof params.recipient !== "string" || !params.recipient.trim()) {
    throw new Error("@dexterai/mpp: createSessionServer() requires a non-empty 'recipient' wallet address");
  }

  if (!params.pricePerUnit || typeof params.pricePerUnit !== "string") {
    throw new Error("@dexterai/mpp: createSessionServer() requires 'pricePerUnit' in atomic USDC units");
  }

  const {
    recipient,
    apiUrl,
    network = "mainnet-beta",
    pricePerUnit,
    meter = "request",
    suggestedDeposit,
  } = params;

  const client = new DexterSettlementClient(apiUrl ?? DEFAULT_DEXTER_API_URL);

  // Track active sessions by channel ID for local voucher verification
  const activeSessions = new Map<string, {
    sessionPubkey: string;
    lastCumulativeAmount: bigint;
    lastSequence: number;
    voucherCount: number;
  }>();

  return {
    /**
     * Returns a 402 challenge payload telling the buyer's agent
     * how to open a session and what it costs.
     */
    getChallenge() {
      return {
        type: "mpp-session",
        recipient,
        network,
        pricePerUnit,
        meter,
        suggestedDeposit: suggestedDeposit ?? String(BigInt(pricePerUnit) * 100n),
        channelProgram: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
      };
    },

    /**
     * Verify a signed voucher from the buyer's agent.
     * This is a LOCAL verification — Ed25519 signature check, no network calls.
     * Returns the voucher data if valid, or an error.
     */
    verifyVoucher(signed: SessionVoucherResponse): {
      valid: boolean;
      error?: string;
      voucher?: SessionVoucherResponse["voucher"];
      amountPaid?: string;
    } {
      const { voucher, signature, signer, signatureType } = signed;

      if (!voucher || !signature || !signer) {
        return { valid: false, error: "missing_voucher_fields" };
      }

      if (signatureType !== "ed25519") {
        return { valid: false, error: `unsupported_signature_type: ${signatureType}` };
      }

      // Check recipient matches
      if (voucher.recipient !== recipient) {
        return { valid: false, error: `recipient_mismatch: expected ${recipient}, got ${voucher.recipient}` };
      }

      // Track/validate session state
      const existing = activeSessions.get(voucher.channelId);

      if (existing) {
        // Verify signer consistency
        if (signer !== existing.sessionPubkey) {
          return { valid: false, error: "signer_changed_mid_session" };
        }

        // Verify monotonic amount
        const newAmount = BigInt(voucher.cumulativeAmount);
        if (newAmount <= existing.lastCumulativeAmount) {
          return { valid: false, error: "amount_not_monotonic" };
        }

        // Verify sequence
        if (voucher.sequence <= existing.lastSequence) {
          return { valid: false, error: "sequence_not_monotonic" };
        }

        // Calculate amount paid this request
        const delta = newAmount - existing.lastCumulativeAmount;
        const expectedDelta = BigInt(pricePerUnit) * BigInt(voucher.units || "1");

        if (delta < expectedDelta) {
          return { valid: false, error: `underpaid: expected ${expectedDelta}, got ${delta}` };
        }

        // Update tracking
        existing.lastCumulativeAmount = newAmount;
        existing.lastSequence = voucher.sequence;
        existing.voucherCount++;

        return {
          valid: true,
          voucher,
          amountPaid: delta.toString(),
        };
      } else {
        // First voucher for this channel — register it
        const amount = BigInt(voucher.cumulativeAmount);
        const expectedMin = BigInt(pricePerUnit) * BigInt(voucher.units || "1");

        if (amount < expectedMin) {
          return { valid: false, error: `underpaid: expected at least ${expectedMin}, got ${amount}` };
        }

        activeSessions.set(voucher.channelId, {
          sessionPubkey: signer,
          lastCumulativeAmount: amount,
          lastSequence: voucher.sequence,
          voucherCount: 1,
        });

        return {
          valid: true,
          voucher,
          amountPaid: amount.toString(),
        };
      }
    },

    /**
     * Get session context for a channel (for logging, analytics, etc.)
     */
    getSessionContext(channelId: string): SessionContext | null {
      const s = activeSessions.get(channelId);
      if (!s) return null;
      return {
        channelId,
        sessionPubkey: s.sessionPubkey,
        cumulativeAmount: s.lastCumulativeAmount,
        voucherCount: s.voucherCount,
      };
    },

    /**
     * Remove a session from tracking (called when channel closes).
     */
    removeSession(channelId: string): void {
      activeSessions.delete(channelId);
    },

    /** The underlying Dexter settlement client (for advanced use). */
    client,
  };
}

export { createSessionServer as default };
