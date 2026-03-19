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
  AccountRole,
  type Address,
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
import {
  TOKEN_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
} from "../constants.js";

export type ProgressEvent =
  | { type: "building"; recipient: string; amount: string; splToken: string }
  | { type: "signing" }
  | { type: "signed"; transaction: string };

export type ChargeParameters = {
  signer: TransactionSigner;
  computeUnitPrice?: bigint;
  computeUnitLimit?: number;
  onProgress?: (event: ProgressEvent) => void;
};

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
          reference?: string;
        };
      };

      const splToken = methodDetails.splToken;
      const decimals = methodDetails.decimals ?? 6;
      const tokenProgramAddr = methodDetails.tokenProgram;
      const feePayerKey = methodDetails.feePayerKey;
      const recentBlockhash = methodDetails.recentBlockhash;
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
        createAssociatedTokenAccountIdempotent(
          address(feePayerKey),
          address(recipient),
          mint,
          destAta,
          tokenProg,
        ),
      );

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
        lastValidBlockHeight: 0n,
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

function createAssociatedTokenAccountIdempotent(
  payer: Address,
  owner: Address,
  mint: Address,
  ata: Address,
  tokenProgram: Address,
): Instruction {
  return {
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM),
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: address("11111111111111111111111111111111"), role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  };
}

export { charge as default };
