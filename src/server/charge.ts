import { Method, Receipt } from "mppx";
import * as Methods from "../methods.js";
import { DexterSettlementClient, SettlementError } from "../api.js";
import { USDC_MINTS, TOKEN_PROGRAM } from "../constants.js";

export type ChargeParameters = {
  /** Solana wallet address that receives USDC payments. */
  recipient: string;
  /** Dexter settlement API URL. Default: `https://x402.dexter.cash` */
  apiUrl?: string;
  /** Solana network name. Default: `"mainnet-beta"`. Also accepts `"devnet"`. */
  network?: string;
  /** SPL token mint address. Default: USDC on the selected network. */
  splToken?: string;
  /** Token decimals. Default: `6` (USDC). */
  decimals?: number;
  /**
   * Optional Solana RPC URL for independent on-chain verification after
   * settlement. When provided, the server fetches the settled transaction
   * and verifies the TransferChecked instruction matches the challenge
   * (correct recipient, amount, and token). This catches facilitator bugs
   * or regressions at the cost of one additional RPC round-trip (~1-2s).
   *
   * When omitted (default), the server verifies using the settlement proof
   * returned by the facilitator — no RPC needed.
   */
  verifyRpcUrl?: string;
};

/**
 * Creates a server-side MPP `dexter` charge method that delegates Solana
 * settlement to Dexter's hosted infrastructure.
 *
 * The returned method handles challenge generation (via `/mpp/prepare`) and
 * settlement verification (via `/mpp/settle`). The seller's server never
 * touches the Solana network directly.
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/server';
 * import { charge } from '@dexterai/mpp/server';
 *
 * const mppx = Mppx.create({
 *   methods: [charge({ recipient: 'YourWallet...' })],
 * });
 * ```
 */
export function charge(params: ChargeParameters) {
  if (!params.recipient || typeof params.recipient !== "string" || !params.recipient.trim()) {
    throw new Error("@dexterai/mpp: charge() requires a non-empty 'recipient' wallet address");
  }

  const {
    recipient,
    apiUrl,
    network = "mainnet-beta",
    splToken,
    decimals = 6,
    verifyRpcUrl,
  } = params;

  const client = new DexterSettlementClient(apiUrl);
  const defaultToken = splToken ?? USDC_MINTS[network] ?? USDC_MINTS["mainnet-beta"];

  return Method.toServer(Methods.charge, {
    defaults: {
      currency: "USDC",
      recipient: "",
      methodDetails: {
        reference: "",
      },
    },

    async request({ credential, request }) {
      if (credential) {
        return credential.challenge.request as typeof request;
      }

      const prepared = await client.prepare({ network });

      return {
        ...request,
        recipient,
        methodDetails: {
          reference: crypto.randomUUID(),
          network: prepared.network,
          splToken: prepared.splToken || defaultToken,
          decimals: prepared.decimals ?? decimals,
          tokenProgram: prepared.tokenProgram || TOKEN_PROGRAM,
          feePayer: true,
          feePayerKey: prepared.feePayer,
          recentBlockhash: prepared.recentBlockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
        },
      };
    },

    async verify({ credential }) {
      const challenge = credential.challenge.request as {
        amount: string;
        recipient: string;
        externalId?: string;
        methodDetails: {
          splToken?: string;
          network?: string;
        };
      };

      const payload = credential.payload as {
        type?: string;
        transaction?: string;
        signature?: string;
      };

      if (payload.type && payload.type !== "transaction") {
        throw new Error(
          `Unsupported credential type: "${payload.type}". Dexter managed settlement only supports server-broadcast (type="transaction").`,
        );
      }

      if (!payload.transaction) {
        throw new Error("Missing transaction in credential payload");
      }

      const expectedAsset = challenge.methodDetails.splToken ?? defaultToken;
      const expectedNetwork = challenge.methodDetails.network ?? network;

      const result = await client.settle({
        transaction: payload.transaction,
        recipient: challenge.recipient,
        amount: challenge.amount,
        asset: expectedAsset,
        network: expectedNetwork,
      });

      if (!result.success) {
        throw new SettlementError(
          result.errorCode ?? result.error ?? "settlement_failed",
          result.detail ?? result.error ?? "Settlement failed",
        );
      }

      if (!result.signature) {
        throw new Error(
          "Facilitator returned success but no transaction signature — settlement state is ambiguous",
        );
      }

      // Verify settlement proof from facilitator response
      if (result.settlement) {
        const s = result.settlement;
        if (s.recipient !== challenge.recipient) {
          throw new SettlementError(
            "settlement_recipient_mismatch",
            `Facilitator settled to ${s.recipient} but challenge specified ${challenge.recipient}`,
          );
        }
        if (s.amount !== challenge.amount) {
          throw new SettlementError(
            "settlement_amount_mismatch",
            `Facilitator settled ${s.amount} but challenge specified ${challenge.amount}`,
          );
        }
        if (s.asset && expectedAsset && s.asset !== expectedAsset) {
          throw new SettlementError(
            "settlement_asset_mismatch",
            `Facilitator settled asset ${s.asset} but challenge specified ${expectedAsset}`,
          );
        }
      }

      // Optional: independent on-chain verification via seller-provided RPC
      if (verifyRpcUrl) {
        await verifyOnChain(verifyRpcUrl, result.signature, {
          recipient: challenge.recipient,
          amount: challenge.amount,
          asset: expectedAsset,
        });
      }

      return Receipt.from({
        method: "dexter",
        reference: result.signature,
        status: "success",
        timestamp: new Date().toISOString(),
      });
    },
  });
}

async function verifyOnChain(
  rpcUrl: string,
  signature: string,
  expected: { recipient: string; amount: string; asset: string },
): Promise<void> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ],
    }),
  });

  const data = (await res.json()) as {
    result?: {
      meta: { err: unknown } | null;
      transaction: {
        message: {
          instructions: Array<{
            program?: string;
            programId?: string;
            parsed?: { type: string; info: Record<string, unknown> };
          }>;
        };
      };
    } | null;
  };

  if (!data.result) {
    throw new SettlementError(
      "onchain_verification_tx_not_found",
      `Transaction ${signature} not found on-chain`,
    );
  }

  if (data.result.meta?.err) {
    throw new SettlementError(
      "onchain_verification_tx_failed",
      `Transaction ${signature} failed on-chain: ${JSON.stringify(data.result.meta.err)}`,
    );
  }

  const instructions = data.result.transaction.message.instructions;
  const transfer = instructions.find(
    (ix) => ix.parsed?.type === "transferChecked",
  );

  if (!transfer || !transfer.parsed) {
    throw new SettlementError(
      "onchain_verification_no_transfer",
      `Transaction ${signature} contains no TransferChecked instruction`,
    );
  }

  const info = transfer.parsed.info as {
    mint?: string;
    tokenAmount?: { amount?: string };
    destination?: string;
  };

  if (info.mint && info.mint !== expected.asset) {
    throw new SettlementError(
      "onchain_verification_asset_mismatch",
      `On-chain transfer used mint ${info.mint}, expected ${expected.asset}`,
    );
  }

  if (info.tokenAmount?.amount && info.tokenAmount.amount !== expected.amount) {
    throw new SettlementError(
      "onchain_verification_amount_mismatch",
      `On-chain transfer amount ${info.tokenAmount.amount}, expected ${expected.amount}`,
    );
  }
}

export { charge as default };
