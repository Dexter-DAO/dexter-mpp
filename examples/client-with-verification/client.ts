/**
 * MPP client with independent on-chain verification.
 *
 * Demonstrates the high-security path where the seller independently verifies
 * every payment on-chain via their own RPC connection. This adds ~1-2s latency
 * per payment but provides trustless settlement verification — the seller does
 * not need to trust Dexter's facilitator response.
 *
 * Use this pattern for:
 *   - High-value endpoints (>$1 per request)
 *   - Compliance-sensitive applications
 *   - Environments where trustless verification is required
 *
 * For most use cases, the default settlement proof verification (no RPC) is
 * sufficient. See the server-express example for the standard approach.
 *
 * Run:
 *   RECIPIENT=YourWallet SOLANA_RPC_URL=https://api.mainnet-beta.solana.com npm start
 */

import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { Mppx } from "mppx/server";
import { charge } from "@dexterai/mpp/server";

const RECIPIENT = process.env.RECIPIENT;
const RPC_URL = process.env.SOLANA_RPC_URL;

if (!RECIPIENT) {
  console.error("Error: RECIPIENT environment variable required");
  process.exit(1);
}
if (!RPC_URL) {
  console.error("Error: SOLANA_RPC_URL environment variable required for on-chain verification");
  console.error("Example: SOLANA_RPC_URL=https://api.mainnet-beta.solana.com");
  process.exit(1);
}

const NETWORK = process.env.NETWORK ?? "mainnet-beta";
const API_URL = process.env.DEXTER_API_URL ?? "https://x402.dexter.cash";
const PORT = process.env.PORT ?? 3000;

const mppx = Mppx.create({
  secretKey: crypto.randomBytes(32).toString("hex"),
  methods: [
    charge({
      recipient: RECIPIENT,
      network: NETWORK,
      apiUrl: API_URL,
      // This is the key difference: verifyRpcUrl enables independent
      // on-chain verification after every settlement.
      verifyRpcUrl: RPC_URL,
    }),
  ],
});

function toWebRequest(req: express.Request): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
  }
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  return new Request(url, { method: req.method, headers });
}

const app = express();
app.use(cors({ exposedHeaders: ["www-authenticate", "payment-receipt"] }));

app.get("/api/premium-data", async (req, res) => {
  const result = await mppx.charge({
    amount: "1000000",
    currency: "USDC",
    description: "Premium verified data — on-chain verification enabled",
  })(toWebRequest(req));

  if (result.status === 402) {
    const challenge = result.challenge as Response;
    for (const [key, value] of challenge.headers) res.setHeader(key, value);
    return res.status(challenge.status).send(await challenge.text());
  }

  // If we reach here, the payment was:
  //   1. Settled by Dexter's facilitator
  //   2. Settlement proof verified (recipient, amount, asset match)
  //   3. Transaction independently verified on-chain via our own RPC

  const response = result.withReceipt(
    Response.json({
      data: "This response is backed by trustless on-chain verification.",
      verified: true,
      verificationMethod: "independent_rpc",
    }),
  ) as Response;
  for (const [key, value] of response.headers) res.setHeader(key, value);
  res.status(response.status).send(await response.text());
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    recipient: RECIPIENT,
    network: NETWORK,
    verification: "on-chain via " + RPC_URL,
  });
});

app.listen(PORT, () => {
  console.log(`\n  Dexter MPP — On-Chain Verified Server\n`);
  console.log(`  Listening:      http://localhost:${PORT}`);
  console.log(`  Recipient:      ${RECIPIENT}`);
  console.log(`  Network:        ${NETWORK}`);
  console.log(`  Verification:   on-chain via ${RPC_URL}`);
  console.log(`\n  Every payment is independently verified on-chain.`);
  console.log(`  This adds ~1-2s latency but is fully trustless.\n`);
});
