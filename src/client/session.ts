import {
  getTransactionDecoder,
  partiallySignTransaction,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import {
  createSIWxPayload,
  encodeSIWxHeader,
  type SolanaSigner,
} from "@x402/extensions/sign-in-with-x";
import { DexterSettlementClient, SettlementError } from "../api.js";
import { DEFAULT_DEXTER_API_URL } from "../constants.js";
import type {
  SessionOpenResponse,
  SessionVoucherResponse,
  SessionCloseResponse,
  SessionOnboardResponse,
} from "../api.js";

export type SessionClientParameters = {
  /** Buyer's Solana wallet address. */
  buyerWallet: string;
  /** Buyer's Swig smart wallet address (for non-custodial delegation). */
  buyerSwigAddress: string;
  /** Dexter settlement API URL. Default: `https://x402.dexter.cash` */
  apiUrl?: string;
  /** Solana network name. Default: `"mainnet-beta"`. */
  network?: string;
  /** Called on session lifecycle events. */
  onProgress?: (event: SessionProgressEvent) => void;
};

export type SessionProgressEvent =
  | { type: "opening"; seller: string; deposit: string }
  | { type: "opened"; channelId: string; sessionPubkey: string }
  | { type: "voucher"; channelId: string; sequence: number; cumulative: string }
  | { type: "closing"; channelId: string }
  | { type: "closed"; channelId: string; settled: string; refund: string };

interface ActiveSession {
  channelId: string;
  sessionPubkey: string;
  seller: string;
  deposit: string;
  network: string;
  cumulativeAmount: bigint;
  voucherCount: number;
}

/**
 * Creates a client-side MPP session manager for buyer agents.
 * Handles the full session lifecycle: open → pay (voucher) → close.
 *
 * The agent calls `open()` once, then `pay()` for each API request,
 * and `close()` when done. Dexter manages all on-chain operations.
 *
 * @example
 * ```ts
 * import { createSessionClient } from '@dexterai/mpp/client/session';
 *
 * const session = createSessionClient({
 *   buyerWallet: 'YourWallet...',
 *   buyerSwigAddress: 'YourSwigWallet...',
 * });
 *
 * // Open a session with a seller
 * const channel = await session.open({
 *   seller: 'SellerWallet...',
 *   deposit: '1000000', // 1 USDC
 * });
 *
 * // Pay for each API call
 * const voucher = await session.pay(channel.channelId, {
 *   amount: '10000', // 0.01 USDC cumulative
 *   serverNonce: nonceFromSeller,
 * });
 *
 * // Include voucher in request to seller
 * const response = await fetch('https://api.seller.com/data', {
 *   headers: { 'x-mpp-voucher': JSON.stringify(voucher) },
 * });
 *
 * // Close when done
 * const settlement = await session.close(channel.channelId);
 * ```
 */
export function createSessionClient(params: SessionClientParameters) {
  if (!params.buyerWallet || typeof params.buyerWallet !== "string") {
    throw new Error("@dexterai/mpp: createSessionClient() requires 'buyerWallet'");
  }
  if (!params.buyerSwigAddress || typeof params.buyerSwigAddress !== "string") {
    throw new Error("@dexterai/mpp: createSessionClient() requires 'buyerSwigAddress'");
  }

  const {
    buyerWallet,
    buyerSwigAddress,
    apiUrl,
    network = "mainnet-beta",
    onProgress,
  } = params;

  const client = new DexterSettlementClient(apiUrl ?? DEFAULT_DEXTER_API_URL);
  const activeSessions = new Map<string, ActiveSession>();

  return {
    /**
     * Open a session channel with a seller.
     * Dexter creates the channel, generates a session keypair, and
     * (when on-chain integration is complete) deposits USDC into escrow.
     */
    async open(opts: {
      seller: string;
      deposit: string;
      idleTimeoutSeconds?: number;
      metadata?: Record<string, unknown>;
    }): Promise<SessionOpenResponse> {
      onProgress?.({ type: "opening", seller: opts.seller, deposit: opts.deposit });

      const result = await client.sessionOpen({
        buyer_wallet: buyerWallet,
        buyer_swig_address: buyerSwigAddress,
        seller_wallet: opts.seller,
        deposit_atomic: opts.deposit,
        network,
        idle_timeout_seconds: opts.idleTimeoutSeconds,
        metadata: opts.metadata,
      });

      activeSessions.set(result.channel_id, {
        channelId: result.channel_id,
        sessionPubkey: result.session_pubkey,
        seller: opts.seller,
        deposit: opts.deposit,
        network: result.network,
        cumulativeAmount: 0n,
        voucherCount: 0,
      });

      onProgress?.({
        type: "opened",
        channelId: result.channel_id,
        sessionPubkey: result.session_pubkey,
      });

      return result;
    },

    /**
     * Request a signed voucher for a payment within an active session.
     * The returned voucher should be included in the request to the seller.
     *
     * @param channelId - The channel ID from `open()`
     * @param opts.amount - Cumulative payment amount in atomic USDC (must be monotonically increasing)
     * @param opts.serverNonce - UUID from the seller's 402 challenge (prevents replay)
     * @param opts.meter - Usage meter label. Default: "request"
     * @param opts.units - Units consumed this request. Default: "1"
     */
    async pay(
      channelId: string,
      opts: {
        amount: string;
        serverNonce: string;
        meter?: string;
        units?: string;
      },
    ): Promise<SessionVoucherResponse> {
      const session = activeSessions.get(channelId);
      if (!session) {
        throw new SettlementError("session_not_found", `No active session for channel ${channelId}`);
      }

      const result = await client.sessionVoucher({
        channel_id: channelId,
        amount: opts.amount,
        meter: opts.meter,
        units: opts.units,
        serverNonce: opts.serverNonce,
      });

      session.cumulativeAmount = BigInt(opts.amount);
      session.voucherCount++;

      onProgress?.({
        type: "voucher",
        channelId,
        sequence: result.voucher.sequence,
        cumulative: opts.amount,
      });

      return result;
    },

    /**
     * Close a session channel. Dexter settles the cumulative amount
     * to the seller and refunds the remainder to the buyer.
     */
    async close(channelId: string): Promise<SessionCloseResponse> {
      const session = activeSessions.get(channelId);
      if (!session) {
        throw new SettlementError("session_not_found", `No active session for channel ${channelId}`);
      }

      onProgress?.({ type: "closing", channelId });

      const result = await client.sessionClose({ channel_id: channelId });

      activeSessions.delete(channelId);

      onProgress?.({
        type: "closed",
        channelId,
        settled: result.settlement.amount_settled,
        refund: result.settlement.buyer_refund,
      });

      return result;
    },

    /**
     * Get the current state of an active session.
     */
    getSession(channelId: string): ActiveSession | null {
      return activeSessions.get(channelId) ?? null;
    },

    /**
     * List all active sessions.
     */
    listSessions(): ActiveSession[] {
      return Array.from(activeSessions.values());
    },

    /**
     * Onboard a buyer wallet by provisioning a Swig smart wallet and
     * granting Dexter a delegated session role. If the wallet already
     * has an active role, returns immediately with `status: 'ready'`.
     *
     * For `needs_swig` buyers (no Swig wallet), onboarding requires
     * two rounds: first to create the wallet, second to grant the role.
     * This method handles both automatically.
     *
     * Accepts either a `signer` (kit v2 CryptoKeyPair — preferred) or
     * callbacks for transaction and message signing. Message signing is
     * required for wallet ownership proof (CAIP-122 / SIWS).
     *
     * @example
     * ```ts
     * // With @solana/kit v2 (preferred — handles everything):
     * import { generateKeyPair } from '@solana/kit';
     * const signer = await generateKeyPair();
     *
     * await session.onboard({ signer });
     *
     * // With @solana/web3.js v1:
     * import { Keypair, VersionedTransaction } from '@solana/web3.js';
     * import nacl from 'tweetnacl';
     * const keypair = Keypair.generate();
     *
     * await session.onboard({
     *   signTransaction: async (txBase64) => {
     *     const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
     *     tx.sign([keypair]);
     *     return Buffer.from(tx.serialize()).toString('base64');
     *   },
     *   signMessage: async (message) => {
     *     return nacl.sign.detached(message, keypair.secretKey);
     *   },
     *   publicKey: keypair.publicKey.toBase58(),
     * });
     * ```
     */
    async onboard(opts: {
      /** Kit v2 CryptoKeyPair — preferred, handles both tx and message signing */
      signer?: CryptoKeyPair;
      /** Escape hatch for transaction signing (base64 in, base64 out) */
      signTransaction?: (unsignedTxBase64: string) => Promise<string>;
      /** Message signing for wallet ownership proof (SIWS/CAIP-122) */
      signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
      /** Public key (base58) — required when using signMessage callback */
      publicKey?: string;
      /** Override buyer wallet address (defaults to the one from createSessionClient) */
      buyerWallet?: string;
      /** USDC spend limit in atomic units (default: 100 USDC) */
      spendLimit?: string;
      /** Role TTL in seconds (default: 24 hours) */
      ttlSeconds?: number;
    }): Promise<{
      swigAddress: string;
      roleId: number;
      status: string;
      /** Transaction signatures from server-side Swig wallet creation (if applicable). */
      createTxSignatures?: string[];
    }> {
      if (!opts.signer && !opts.signTransaction) {
        throw new SettlementError(
          "onboard_no_signer",
          "Provide either 'signer' (CryptoKeyPair) or 'signTransaction' callback",
        );
      }

      if (!opts.signer && !opts.signMessage) {
        throw new SettlementError(
          "onboard_no_message_signer",
          "Provide either 'signer' (CryptoKeyPair) or 'signMessage' callback for wallet ownership proof",
        );
      }

      if (opts.signMessage && !opts.publicKey) {
        throw new SettlementError(
          "onboard_no_public_key",
          "'publicKey' (base58) is required when using 'signMessage' callback",
        );
      }

      const wallet = opts.buyerWallet ?? buyerWallet;

      // Build the transaction signing function
      const sign = opts.signer
        ? async (txBase64: string): Promise<string> => {
            const txBytes = Buffer.from(txBase64, 'base64');
            const decoder = getTransactionDecoder();
            const tx = decoder.decode(txBytes);
            const signed = await partiallySignTransaction([opts.signer!], tx);
            return getBase64EncodedWireTransaction(signed) as string;
          }
        : opts.signTransaction!;

      // Build the SIWx header for wallet ownership proof (CAIP-122 / SIWS)
      const solanaChainId = network === "devnet"
        ? "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
        : "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

      const baseUrl = apiUrl ?? DEFAULT_DEXTER_API_URL;
      const apiDomain = new URL(baseUrl).hostname;

      // Build a WalletAdapterSigner-compatible signer for SIWx.
      // Both paths produce the same interface: signMessage(Uint8Array) → Uint8Array
      const siwxSigner: SolanaSigner = opts.signer
        ? {
            signMessage: async (message: Uint8Array): Promise<Uint8Array> => {
              const data = new Uint8Array(message).buffer as ArrayBuffer;
              const signature = await crypto.subtle.sign(
                "Ed25519",
                (opts.signer as CryptoKeyPair).privateKey,
                data,
              );
              return new Uint8Array(signature);
            },
            publicKey: wallet,
          }
        : {
            signMessage: async (message: Uint8Array): Promise<Uint8Array> => {
              return opts.signMessage!(message);
            },
            publicKey: opts.publicKey!,
          };

      const nonce = crypto.randomUUID().replace(/-/g, "");
      const now = new Date();
      const siwxPayload = await createSIWxPayload(
        {
          domain: apiDomain,
          uri: `https://${apiDomain}/api/sessions/onboard`,
          version: "1",
          chainId: solanaChainId,
          type: "ed25519",
          signatureScheme: "siws",
          nonce,
          issuedAt: now.toISOString(),
          expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
        },
        siwxSigner,
      );

      const siwxHeader = encodeSIWxHeader(siwxPayload);

      // May need up to three rounds: create_swig → grant_role → activate_session_key
      for (let round = 0; round < 3; round++) {
        const result: SessionOnboardResponse = await client.sessionOnboard({
          buyer_wallet: wallet,
          spend_limit_atomic: opts.spendLimit,
          ttl_seconds: opts.ttlSeconds,
        }, siwxHeader);

        if (result.status === 'ready') {
          return {
            swigAddress: result.swig_address,
            roleId: result.role_id!,
            status: 'ready',
            createTxSignatures: result.create_tx_signatures,
          };
        }

        if (result.status === 'not_eligible' || result.status === 'temporarily_unavailable') {
          throw new SettlementError(
            "onboard_rejected",
            `Onboarding rejected: ${result.status}`,
          );
        }

        if (result.status !== 'transactions_required' || !result.transactions?.length) {
          throw new SettlementError(
            "onboard_unexpected",
            `Unexpected onboard response: ${result.status}`,
          );
        }

        // Sign each transaction
        const signedTransactions: string[] = [];
        for (const txEntry of result.transactions) {
          signedTransactions.push(await sign(txEntry.tx));
        }

        // Submit signed transactions for co-signing and broadcast
        const confirmed = await client.sessionOnboardConfirm({
          buyer_wallet: wallet,
          signed_transactions: signedTransactions,
        }, siwxHeader);

        if (confirmed.status === 'ready') {
          return {
            swigAddress: confirmed.swig_address ?? result.swig_address,
            roleId: confirmed.role_id ?? 0,
            status: 'ready',
            createTxSignatures: result.create_tx_signatures,
          };
        }

        // If pending (needs_swig → created wallet, still needs role grant),
        // loop back for the second round
      }

      throw new SettlementError(
        "onboard_incomplete",
        "Onboarding did not complete after 3 rounds — check buyer wallet state",
      );
    },

    /** The underlying Dexter settlement client (for advanced use). */
    client,
  };
}

export { createSessionClient as default };
