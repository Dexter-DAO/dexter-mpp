import { Method, z } from "mppx";

export const charge = Method.from({
  intent: "charge",
  name: "dexter",
  schema: {
    credential: {
      payload: z.object({
        transaction: z.string(),
      }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      description: z.optional(z.string()),
      methodDetails: z.object({
        reference: z.string(),
        network: z.string(),
        splToken: z.string(),
        decimals: z.number(),
        tokenProgram: z.optional(z.string()),
        feePayer: z.boolean(),
        feePayerKey: z.string(),
        recentBlockhash: z.string(),
      }),
    }),
  },
});
