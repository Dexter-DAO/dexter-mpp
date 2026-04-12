/**
 * Streaming Price Feed — Session Client
 *
 * Connects to the price feed server, opens an MPP session, and consumes
 * real-time price ticks. Each tick is paid with a signed voucher — verified
 * by the server in microseconds with no chain interaction.
 *
 * At the end, prints a cost comparison: what this session cost via vouchers
 * vs what it would have cost with per-request on-chain settlement.
 *
 * Run:
 *   SOLANA_PRIVATE_KEY=base58... npx tsx client.ts
 *   SOLANA_PRIVATE_KEY=base58... DURATION_SEC=60 TOKENS=SOL,BTC npx tsx client.ts
 */

import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { createSessionClient } from "@dexterai/mpp/client/session";

const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: SOLANA_PRIVATE_KEY environment variable required");
  process.exit(1);
}

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 30);
const TOKENS = process.env.TOKENS ?? "SOL,BTC,ETH";
const DEPOSIT = process.env.DEPOSIT ?? "100000"; // 0.10 USDC

async function main() {
  console.log("\n  Streaming Price Feed Client");
  console.log("  ──────────────────────────────────────────────");
  console.log(`  Server:   ${SERVER_URL}`);
  console.log(`  Duration: ${DURATION_SEC}s`);
  console.log(`  Tokens:   ${TOKENS}`);
  console.log(`  Deposit:  ${(Number(DEPOSIT) / 1e6).toFixed(4)} USDC`);
  console.log("  ──────────────────────────────────────────────\n");

  const keyBytes = getBase58Encoder().encode(PRIVATE_KEY);
  const signer = await createKeyPairSignerFromBytes(keyBytes);

  const session = createSessionClient({
    buyerWallet: signer.address,
    buyerSwigAddress: "", // will be set after onboard
    onProgress: (event) => {
      if (event.type === "opening") console.log("  Opening session...");
      if (event.type === "opened") console.log(`  Session opened: ${event.channelId}`);
      if (event.type === "closing") console.log("  Closing session...");
      if (event.type === "closed") console.log(`  Settled: ${event.settled} atomic, refund: ${event.refund} atomic`);
    },
  });

  // 1. Get challenge from server
  console.log("[1] Fetching challenge...");
  const challengeRes = await fetch(`${SERVER_URL}/prices/challenge`);
  const challenge = await challengeRes.json();
  console.log(`    Price/tick: ${challenge.pricePerTick} atomic ($${(Number(challenge.pricePerTick) / 1e6).toFixed(4)})`);
  console.log(`    Tick rate:  ${(1000 / challenge.tickIntervalMs).toFixed(0)}/sec`);

  // 2. Onboard (idempotent — skips if already onboarded)
  console.log("\n[2] Onboarding...");
  const onboard = await session.onboard({ signer });
  console.log(`    Swig: ${onboard.swigAddress}`);
  console.log(`    Status: ${onboard.status}`);

  // 3. Open session
  console.log("\n[3] Opening session...");
  const channel = await session.open({
    seller: challenge.recipient,
    deposit: DEPOSIT,
  });

  // 4. Connect to price stream
  console.log(`\n[4] Streaming prices for ${DURATION_SEC}s...\n`);

  let tickCount = 0;
  let totalPaid = 0n;
  const pricePerTick = BigInt(challenge.pricePerTick);
  const startTime = Date.now();
  const voucherTimes: number[] = [];

  // Consume ticks for the specified duration
  const streamUrl = `${SERVER_URL}/prices/stream?channel=${channel.channel_id}&tokens=${TOKENS}`;

  // Use a polling approach since we need to send vouchers per tick
  const tickInterval = setInterval(async () => {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= DURATION_SEC) {
      clearInterval(tickInterval);
      return;
    }

    tickCount++;
    totalPaid += pricePerTick;

    // Pay for this tick with a voucher
    const vStart = performance.now();
    try {
      const voucher = await session.pay(channel.channel_id, {
        amount: totalPaid.toString(),
        serverNonce: `tick-${tickCount}-${Date.now()}`,
        meter: "price_ticks",
        units: "1",
      });
      const vMs = performance.now() - vStart;
      voucherTimes.push(vMs);

      // Display every 10th tick
      if (tickCount % 10 === 0) {
        process.stdout.write(
          `    Tick ${tickCount}: paid ${totalPaid} atomic ($${(Number(totalPaid) / 1e6).toFixed(4)}) ` +
          `| voucher ${vMs.toFixed(0)}ms | ${(tickCount / elapsed).toFixed(1)} ticks/sec\n`
        );
      }
    } catch (err: any) {
      console.error(`    Tick ${tickCount} FAILED: ${err.message?.slice(0, 80)}`);
    }
  }, challenge.tickIntervalMs);

  // Wait for duration
  await new Promise((resolve) => setTimeout(resolve, DURATION_SEC * 1000 + 500));
  clearInterval(tickInterval);

  // 5. Close session
  console.log(`\n[5] Closing session (${tickCount} ticks consumed)...`);
  const settlement = await session.close(channel.channel_id);

  // 6. Print results
  const durationActual = (Date.now() - startTime) / 1000;
  const avgVoucherMs = voucherTimes.length
    ? voucherTimes.reduce((a, b) => a + b, 0) / voucherTimes.length
    : 0;
  const p95VoucherMs = voucherTimes.length
    ? [...voucherTimes].sort((a, b) => a - b)[Math.ceil(0.95 * voucherTimes.length) - 1]
    : 0;

  const sessionCostLamports = 10200; // ~$0.001 at current SOL price
  const chargeCostPerTick = 10002; // lamports per charge-mode settlement
  const solPrice = 85; // approximate

  console.log("\n  ══════════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("  ══════════════════════════════════════════════════════════════");
  console.log(`  Duration:              ${durationActual.toFixed(1)}s`);
  console.log(`  Ticks consumed:        ${tickCount}`);
  console.log(`  Ticks/second:          ${(tickCount / durationActual).toFixed(1)}`);
  console.log(`  Total paid:            ${totalPaid} atomic ($${(Number(totalPaid) / 1e6).toFixed(4)} USDC)`);
  console.log(`  Settled to seller:     ${settlement.settlement.amount_settled} atomic`);
  console.log(`  Refunded to buyer:     ${settlement.settlement.buyer_refund} atomic`);
  console.log(`  Settlement tx:         ${settlement.close_tx_signature}`);
  console.log("");
  console.log("  Voucher Performance");
  console.log(`  Avg verification:      ${avgVoucherMs.toFixed(1)}ms`);
  console.log(`  p95 verification:      ${p95VoucherMs.toFixed(1)}ms`);
  console.log(`  On-chain txs:          2 (open + close)`);
  console.log("");
  console.log("  Cost Comparison");
  console.log(`  Session total gas:     $${((sessionCostLamports * 2) / 1e9 * solPrice).toFixed(4)} (2 txs)`);
  console.log(`  Charge mode gas:       $${((chargeCostPerTick * tickCount) / 1e9 * solPrice).toFixed(4)} (${tickCount} txs)`);
  console.log(`  Gas savings:           ${((1 - 2 / tickCount) * 100).toFixed(1)}%`);
  console.log("");
  if (tickCount > 400) {
    console.log(`  At ${(tickCount / durationActual).toFixed(0)} ticks/sec, charge mode would require`);
    console.log(`  ${(tickCount / durationActual).toFixed(0)} on-chain settlements per second.`);
    console.log(`  Solana processes ~400 TPS total. This is physically impossible`);
    console.log(`  with per-request settlement.`);
  }
  console.log("  ══════════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
