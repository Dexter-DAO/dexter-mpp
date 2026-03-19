import { Method, z } from "mppx";

export const charge = Method.from({
  intent: "charge",
  name: "dexter",
  schema: {
    credential: {
      payload: z.object({
        type: z.optional(z.string()),
        transaction: z.optional(z.string()),
        signature: z.optional(z.string()),
      }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      methodDetails: z.object({
        reference: z.string(),
        network: z.optional(z.string()),
        splToken: z.optional(z.string()),
        decimals: z.optional(z.number()),
        tokenProgram: z.optional(z.string()),
        feePayer: z.optional(z.boolean()),
        feePayerKey: z.optional(z.string()),
        recentBlockhash: z.optional(z.string()),
        lastValidBlockHeight: z.optional(z.number()),
      }),
    }),
  },
});
