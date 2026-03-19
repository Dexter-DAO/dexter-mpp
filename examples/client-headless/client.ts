/**
 * Headless MPP client for AI agents and scripts.
 *
 * Pays for resources automatically using a Solana keypair. No browser,
 * no wallet UI, no human interaction. The agent calls fetch() and payments
 * happen transparently on 402 responses.
 *
 * Run:
 *   SOLANA_PRIVATE_KEY=base58... SERVER_URL=http://localhost:3000 npm start
 *
 * The client needs zero SOL — Dexter sponsors all transaction fees.
 * Only USDC is required in the wallet.
 */

import {
  createKeyPairSignerFromBytes,
  getBase58Encoder,
} from "@solana/kit";
import { Mppx } from "mppx/client";
import { charge } from "@dexterai/mpp/client";
import { Receipt } from "mppx";

const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: SOLANA_PRIVATE_KEY environment variable required (base58 encoded)");
  process.exit(1);
}

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";

async function main() {
  console.log("\n  Dexter MPP Headless Client\n");

  const keyBytes = getBase58Encoder().encode(PRIVATE_KEY);
  const signer = await createKeyPairSignerFromBytes(keyBytes);
  console.log(`  Wallet:  ${signer.address}`);
  console.log(`  Server:  ${SERVER_URL}\n`);

  const mppx = Mppx.create({
    methods: [
      charge({
        signer,
        onProgress: (event) => {
          if (event.type === "building") {
            console.log(`  [pay] Building tx: ${event.amount} ${event.splToken.slice(0, 8)}... → ${event.recipient.slice(0, 8)}...`);
          } else if (event.type === "signing") {
            console.log(`  [pay] Signing transaction...`);
          } else if (event.type === "signed") {
            console.log(`  [pay] Transaction signed, submitting for settlement`);
          }
        },
      }),
    ],
    polyfill: false,
  });

  // Example 1: Weather lookup
  console.log("  --- Request 1: Weather ---");
  const weatherRes = await mppx.fetch(`${SERVER_URL}/api/weather/tokyo`);
  const weather = await weatherRes.json();
  console.log(`  Status: ${weatherRes.status}`);
  console.log(`  Data:   ${JSON.stringify(weather)}`);

  const weatherReceipt = weatherRes.headers.get("payment-receipt");
  if (weatherReceipt) {
    const receipt = Receipt.deserialize(weatherReceipt);
    console.log(`  Receipt: method=${receipt.method} ref=${receipt.reference.slice(0, 20)}...`);
  }

  // Example 2: Quote (micropayment)
  console.log("\n  --- Request 2: Quote ---");
  const quoteRes = await mppx.fetch(`${SERVER_URL}/api/quote`);
  const quote = await quoteRes.json();
  console.log(`  Status: ${quoteRes.status}`);
  console.log(`  Data:   "${quote.text}" — ${quote.author}`);

  // Example 3: Analysis (higher value)
  console.log("\n  --- Request 3: Analysis ---");
  const analyzeRes = await mppx.fetch(`${SERVER_URL}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "Dexter is building the payment infrastructure for the AI economy with managed settlement on Solana.",
    }),
  });
  const analysis = await analyzeRes.json();
  console.log(`  Status: ${analyzeRes.status}`);
  console.log(`  Data:   ${JSON.stringify(analysis)}`);

  console.log("\n  Done. All payments settled via Dexter.\n");
}

main().catch((err) => {
  console.error("\n  Error:", err.message);
  process.exit(1);
});
