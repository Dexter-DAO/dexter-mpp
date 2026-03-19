/**
 * Hono seller server accepting MPP payments via Dexter managed settlement.
 *
 * Hono is the framework used in MPP's own documentation. This example shows
 * how @dexterai/mpp integrates with Hono's native Request/Response model —
 * no adapter needed since Hono already uses Web API types.
 *
 * Run:
 *   RECIPIENT=YourSolanaWallet npm start
 */

import crypto from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Mppx } from "mppx/server";
import { charge } from "@dexterai/mpp/server";

const RECIPIENT = process.env.RECIPIENT;
if (!RECIPIENT) {
  console.error("Error: RECIPIENT environment variable required");
  process.exit(1);
}

const NETWORK = process.env.NETWORK ?? "mainnet-beta";
const API_URL = process.env.DEXTER_API_URL ?? "https://x402.dexter.cash";
const PORT = Number(process.env.PORT ?? 3000);

const mppx = Mppx.create({
  secretKey: crypto.randomBytes(32).toString("hex"),
  methods: [
    charge({
      recipient: RECIPIENT,
      network: NETWORK,
      apiUrl: API_URL,
    }),
  ],
});

const app = new Hono();

// Hono uses Web API Request/Response natively — no adapter needed.
app.get("/api/data", async (c) => {
  const result = await mppx.charge({
    amount: "10000",
    currency: "USDC",
    description: "Premium data endpoint",
  })(c.req.raw);

  if (result.status === 402) return result.challenge as Response;

  return result.withReceipt(
    Response.json({
      data: "premium content",
      timestamp: new Date().toISOString(),
    }),
  ) as Response;
});

app.get("/health", (c) => {
  return c.json({ status: "ok", recipient: RECIPIENT, network: NETWORK });
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`\n  Dexter MPP Hono Example`);
  console.log(`  Listening: http://localhost:${PORT}`);
  console.log(`  Recipient: ${RECIPIENT}\n`);
});
