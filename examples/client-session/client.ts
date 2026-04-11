/**
 * Session-based MPP client for AI agents.
 *
 * Full session lifecycle: onboard → open → pay (vouchers) → close.
 * The agent deposits once, pays per-request with signed vouchers,
 * and settles on-chain only when the session closes.
 *
 * Run:
 *   SOLANA_PRIVATE_KEY=base58... SERVER_URL=http://localhost:3000 npx tsx client.ts
 *
 * The client needs zero SOL — Dexter sponsors all transaction fees.
 * Only USDC is required in the wallet (minimum 1 USDC for onboarding).
 */

import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { createSessionClient } from "@dexterai/mpp/client/session";

const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: SOLANA_PRIVATE_KEY environment variable required (base58 encoded)");
  process.exit(1);
}

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const DEPOSIT = process.env.DEPOSIT ?? "100000"; // 0.10 USDC default

async function main() {
  console.log("\n  Dexter MPP Session Client\n");

  const keyBytes = getBase58Encoder().encode(PRIVATE_KEY);
  const signer = await createKeyPairSignerFromBytes(keyBytes);
  console.log(`  Wallet:  ${signer.address}`);
  console.log(`  Server:  ${SERVER_URL}`);
  console.log(`  Deposit: ${DEPOSIT} atomic USDC\n`);

  // Step 0: Get the seller's session challenge to find the seller wallet
  console.log("  --- Step 0: Discover seller ---");
  const challengeRes = await fetch(`${SERVER_URL}/challenge`);
  const challenge = await challengeRes.json();
  console.log(`  Seller:  ${challenge.recipient}`);
  console.log(`  Price:   ${challenge.pricePerUnit} atomic USDC per ${challenge.meter}`);
  console.log(`  Network: ${challenge.network}\n`);

  // Create session client with progress logging
  const session = createSessionClient({
    buyerWallet: signer.address,
    buyerSwigAddress: "pending", // will be set after onboard
    onProgress: (event) => {
      switch (event.type) {
        case "opening":
          console.log(`  [session] Opening channel with ${event.seller.slice(0, 12)}... (deposit: ${event.deposit})`);
          break;
        case "opened":
          console.log(`  [session] Channel opened: ${event.channelId}`);
          break;
        case "voucher":
          console.log(`  [session] Voucher #${event.sequence}: cumulative ${event.cumulative} atomic USDC`);
          break;
        case "closing":
          console.log(`  [session] Closing channel ${event.channelId}...`);
          break;
        case "closed":
          console.log(`  [session] Settled ${event.settled} to seller, refund ${event.refund} to buyer`);
          break;
      }
    },
  });

  // Step 1: Onboard — provision Swig wallet (only needed once per buyer)
  console.log("  --- Step 1: Onboard ---");
  const onboard = await session.onboard({ signer: signer.keyPair });
  console.log(`  Swig:    ${onboard.swigAddress}`);
  console.log(`  Role ID: ${onboard.roleId}`);
  console.log(`  Status:  ${onboard.status}\n`);

  // Step 2: Open session with the seller
  console.log("  --- Step 2: Open session ---");
  const channel = await session.open({
    seller: challenge.recipient,
    deposit: DEPOSIT,
  });
  console.log(`  Channel: ${channel.channel_id}`);
  console.log(`  Deposit: ${channel.deposit_atomic} atomic USDC\n`);

  // Step 3: Make paid requests with vouchers
  console.log("  --- Step 3: Pay for data ---");

  const keys = ["sol-price", "btc-price", "eth-price", "block-height", "tps"];
  let cumulative = 0;

  for (const key of keys) {
    // Increment cumulative amount (0.01 USDC = 10000 atomic per request)
    cumulative += parseInt(challenge.pricePerUnit);

    // Get a signed voucher from Dexter
    const voucher = await session.pay(channel.channel_id, {
      amount: String(cumulative),
      serverNonce: crypto.randomUUID(),
    });

    // Include voucher in request to seller
    const res = await fetch(`${SERVER_URL}/api/data/${key}`, {
      headers: { "x-mpp-voucher": JSON.stringify(voucher) },
    });

    const data = await res.json();
    console.log(`  ${key}: ${data.value} (paid: ${data.paid} atomic, seq: ${data.voucher_sequence})`);
  }

  console.log(`\n  Total paid: ${cumulative} atomic USDC (${keys.length} requests)\n`);

  // Step 4: Close session — settle to seller, refund remainder
  console.log("  --- Step 4: Close session ---");
  const settlement = await session.close(channel.channel_id);
  console.log(`  Settled:  ${settlement.settlement.amount_settled} atomic USDC to seller`);
  console.log(`  Refund:   ${settlement.settlement.buyer_refund} atomic USDC to buyer`);
  console.log(`  Vouchers: ${settlement.settlement.voucher_count}`);
  console.log(`  Duration: ${settlement.settlement.session_duration_seconds}s\n`);
  console.log("  Done. Session complete.\n");
}

main().catch((err) => {
  console.error("\n  Error:", err.message);
  process.exit(1);
});
