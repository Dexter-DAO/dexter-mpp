import { Credential, Method } from "mppx";
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  prependTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  address,
  type TransactionSigner,
  type Instruction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  getTransferCheckedInstruction,
  findAssociatedTokenPda,
} from "@solana-program/token";
import * as Methods from "../methods.js";
import { TOKEN_PROGRAM } from "../constants.js";

export type ProgressEvent =
  | { type: "building"; recipient: string; amount: string; splToken: string }
  | { type: "signing" }
  | { type: "signed"; transaction: string };

export type ChargeParameters = {
  /** Solana transaction signer. Accepts `@solana/kit` KeyPairSigner, ConnectorKit signers, or any TransactionSigner. */
  signer: TransactionSigner;
  /** Priority fee in micro-lamports. Default: `1n`. */
  computeUnitPrice?: bigint;
  /** Compute unit limit. Default: `50_000`. */
  computeUnitLimit?: number;
  /** Called at each step: `"building"`, `"signing"`, `"signed"`. */
  onProgress?: (event: ProgressEvent) => void;
};

/**
 * Creates a client-side MPP `dexter` charge method that builds and partially
 * signs Solana USDC transfer transactions.
 *
 * The client reads all payment parameters (fee payer, blockhash, token config)
 * from the server's 402 challenge — no RPC access needed. The transaction is
 * partially signed with transfer authority only; Dexter co-signs as fee payer
 * during settlement.
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/client';
 * import { charge } from '@dexterai/mpp/client';
 *
 * Mppx.create({ methods: [charge({ signer })] });
 * const response = await fetch('https://api.example.com/paid');
 * ```
 */
export function charge(params: ChargeParameters) {
  const {
    signer,
    computeUnitPrice = 1n,
    computeUnitLimit = 50_000,
    onProgress,
  } = params;

  return Method.toClient(Methods.charge, {
    async createCredential({ challenge }) {
      const { amount, recipient, methodDetails } = challenge.request as {
        amount: string;
        recipient: string;
        methodDetails: {
          splToken?: string;
          decimals?: number;
          tokenProgram?: string;
          feePayerKey?: string;
          recentBlockhash?: string;
          lastValidBlockHeight?: number;
          reference?: string;
        };
      };

      const splToken = methodDetails.splToken;
      const decimals = methodDetails.decimals ?? 6;
      const tokenProgramAddr = methodDetails.tokenProgram;
      const feePayerKey = methodDetails.feePayerKey;
      const recentBlockhash = methodDetails.recentBlockhash;
      const lastValidBlockHeight = methodDetails.lastValidBlockHeight;
      const reference = methodDetails.reference;

      if (!splToken) {
        throw new Error("Challenge missing required field: methodDetails.splToken");
      }
      if (!feePayerKey) {
        throw new Error("Challenge missing required field: methodDetails.feePayerKey");
      }
      if (!recentBlockhash) {
        throw new Error("Challenge missing required field: methodDetails.recentBlockhash");
      }

      onProgress?.({ type: "building", recipient, amount, splToken });

      const mint = address(splToken);
      const tokenProg = address(tokenProgramAddr || TOKEN_PROGRAM);

      const [sourceAta] = await findAssociatedTokenPda({
        owner: signer.address,
        mint,
        tokenProgram: tokenProg,
      });

      const [destAta] = await findAssociatedTokenPda({
        owner: address(recipient),
        mint,
        tokenProgram: tokenProg,
      });

      const instructions: Instruction[] = [];

      instructions.push(
        getTransferCheckedInstruction(
          {
            source: sourceAta,
            mint,
            destination: destAta,
            authority: signer,
            amount: BigInt(amount),
            decimals,
          },
          { programAddress: tokenProg },
        ),
      );

      if (reference?.trim()) {
        instructions.push(createMemoInstruction(reference));
      }

      const latestBlockhash = {
        blockhash: recentBlockhash as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0]["blockhash"],
        lastValidBlockHeight: BigInt(lastValidBlockHeight ?? 0),
      };

      onProgress?.({ type: "signing" });

      const txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(address(feePayerKey), msg),
        (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
        (msg) => appendTransactionMessageInstructions(instructions, msg),
        (msg) =>
          prependTransactionMessageInstructions(
            [
              getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice }),
              getSetComputeUnitLimitInstruction({ units: computeUnitLimit }),
            ],
            msg,
          ),
      );

      const signedTx = await partiallySignTransactionMessageWithSigners(txMessage);
      const encodedTx = getBase64EncodedWireTransaction(signedTx);

      onProgress?.({ type: "signed", transaction: encodedTx });

      return Credential.serialize({
        challenge,
        payload: { type: "transaction", transaction: encodedTx },
      });
    },
  });
}

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const textEncoder = new TextEncoder();

function createMemoInstruction(reference: string): Instruction {
  return {
    programAddress: address(MEMO_PROGRAM),
    accounts: [],
    data: textEncoder.encode(`mppx:${reference}`),
  };
}

export { charge as default };
