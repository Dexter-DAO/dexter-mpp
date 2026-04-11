/**
 * Express seller server accepting MPP session payments.
 *
 * Sessions let buyer agents pay per-request with signed vouchers instead of
 * on-chain transactions. The seller verifies vouchers locally in microseconds.
 * Only two on-chain transactions for the entire session (open + close).
 *
 * Two paid endpoints:
 *   GET /api/data/:key   — 0.01 USDC per request (metered by api_calls)
 *   GET /api/stream      — 0.001 USDC per token (metered by tokens)
 *
 * Run:
 *   RECIPIENT=YourSolanaWallet npx tsx server.ts
 *
 * The server needs zero blockchain infrastructure — vouchers are verified
 * with Ed25519 signature checks, no RPC calls. Dexter handles settlement
 * when the session closes.
 */

import express from "express";
import cors from "cors";
import { createSessionServer } from "@dexterai/mpp/server/session";

const RECIPIENT = process.env.RECIPIENT;
if (!RECIPIENT) {
  console.error("Error: RECIPIENT environment variable required (your Solana wallet address)");
  console.error("Usage: RECIPIENT=YourSolanaWallet npx tsx server.ts");
  process.exit(1);
}

const NETWORK = process.env.NETWORK ?? "mainnet-beta";
const PORT = process.env.PORT ?? 3000;

// Create session handler — verifies vouchers locally, no network calls
const sessions = createSessionServer({
  recipient: RECIPIENT,
  pricePerUnit: "10000", // 0.01 USDC per request
  meter: "api_calls",
  network: NETWORK,
});

// Second session handler for token-metered streaming
const streamSessions = createSessionServer({
  recipient: RECIPIENT,
  pricePerUnit: "1000", // 0.001 USDC per token
  meter: "tokens",
  network: NETWORK,
});

const app = express();
app.use(express.json());
app.use(cors({ exposedHeaders: ["www-authenticate", "x-mpp-session"] }));

// Per-request pricing: 0.01 USDC per data lookup
app.get("/api/data/:key", (req, res) => {
  const voucherHeader = req.headers["x-mpp-voucher"] as string | undefined;

  if (!voucherHeader) {
    // No voucher — tell the buyer how to open a session
    return res.status(402).json(sessions.getChallenge());
  }

  let parsed: any;
  try {
    parsed = JSON.parse(voucherHeader);
  } catch {
    return res.status(400).json({ error: "invalid_voucher_json" });
  }

  const result = sessions.verifyVoucher(parsed);
  if (!result.valid) {
    return res.status(402).json({ error: result.error });
  }

  // Voucher verified — serve the data
  const data: Record<string, string> = {
    "sol-price": "$142.50",
    "btc-price": "$67,230.00",
    "eth-price": "$3,450.00",
    "block-height": "412381108",
    "tps": "3,847",
  };

  const key = req.params.key.toLowerCase();
  const value = data[key];

  if (!value) {
    return res.json({ error: "key_not_found", available: Object.keys(data) });
  }

  res.json({
    key,
    value,
    paid: result.amountPaid,
    voucher_sequence: result.voucher?.sequence,
  });
});

// Token-metered streaming: 0.001 USDC per token
app.get("/api/stream", (req, res) => {
  const voucherHeader = req.headers["x-mpp-voucher"] as string | undefined;
  const tokenCount = parseInt(req.query.tokens as string) || 1;

  if (!voucherHeader) {
    return res.status(402).json(streamSessions.getChallenge());
  }

  let parsed: any;
  try {
    parsed = JSON.parse(voucherHeader);
  } catch {
    return res.status(400).json({ error: "invalid_voucher_json" });
  }

  const result = streamSessions.verifyVoucher(parsed);
  if (!result.valid) {
    return res.status(402).json({ error: result.error });
  }

  // Generate mock tokens
  const tokens = Array.from({ length: tokenCount }, (_, i) =>
    `token_${Date.now()}_${i}`
  );

  res.json({
    tokens,
    count: tokenCount,
    paid: result.amountPaid,
    meter: "tokens",
  });
});

// Free endpoints
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    mode: "session",
    recipient: RECIPIENT,
    network: NETWORK,
    endpoints: [
      { method: "GET", path: "/api/data/:key", price: "0.01 USDC/request", meter: "api_calls" },
      { method: "GET", path: "/api/stream", price: "0.001 USDC/token", meter: "tokens" },
    ],
  });
});

app.get("/challenge", (_req, res) => {
  res.json(sessions.getChallenge());
});

app.listen(PORT, () => {
  console.log(`\n  Dexter MPP Session Server\n`);
  console.log(`  Listening:   http://localhost:${PORT}`);
  console.log(`  Recipient:   ${RECIPIENT}`);
  console.log(`  Network:     ${NETWORK}\n`);
  console.log(`  Session Endpoints:`);
  console.log(`    GET  /api/data/:key   0.01 USDC/request  (api_calls meter)`);
  console.log(`    GET  /api/stream      0.001 USDC/token   (tokens meter)`);
  console.log(`    GET  /health          free`);
  console.log(`    GET  /challenge       session challenge (for debugging)\n`);
  console.log(`  Buyers open a session, pay with vouchers, close when done.`);
  console.log(`  Seller verifies vouchers locally — no blockchain calls.\n`);
});
