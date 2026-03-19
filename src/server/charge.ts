import { Method, Receipt } from "mppx";
import * as Methods from "../methods.js";
import { DexterSettlementClient } from "../api.js";
import { USDC_MINTS, TOKEN_PROGRAM } from "../constants.js";

export type ChargeParameters = {
  recipient: string;
  apiUrl?: string;
  network?: string;
  splToken?: string;
  decimals?: number;
};

export function charge(params: ChargeParameters) {
  const {
    recipient,
    apiUrl,
    network = "mainnet-beta",
    splToken,
    decimals = 6,
  } = params;

  const client = new DexterSettlementClient(apiUrl);
  const defaultToken = splToken ?? USDC_MINTS[network] ?? USDC_MINTS["mainnet-beta"];

  return Method.toServer(Methods.charge, {
    defaults: {
      currency: "USDC",
      recipient: "",
      methodDetails: {
        reference: "",
        network: "",
        splToken: "",
        decimals: 6,
        feePayer: true,
        feePayerKey: "",
        recentBlockhash: "",
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
        },
      };
    },

    async verify({ credential }) {
      const challenge = credential.challenge.request as {
        amount: string;
        recipient: string;
        methodDetails: {
          splToken: string;
          network: string;
        };
      };
      const { transaction } = credential.payload as { transaction: string };

      const result = await client.settle({
        transaction,
        recipient: challenge.recipient,
        amount: challenge.amount,
        asset: challenge.methodDetails.splToken,
        network: challenge.methodDetails.network,
      });

      if (!result.success) {
        throw new Error(result.error ?? result.detail ?? "Settlement failed");
      }

      return Receipt.from({
        method: "dexter",
        reference: result.signature ?? "",
        status: "success",
        timestamp: new Date().toISOString(),
      });
    },
  });
}

export { charge as default };
