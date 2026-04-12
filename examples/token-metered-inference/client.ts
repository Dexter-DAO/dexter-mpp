/**
 * Token-Metered Inference — Client
 *
 * An AI agent having a multi-turn conversation with a paid LLM endpoint.
 * Each request costs a different amount based on the actual tokens consumed.
 * The agent pays exactly what it uses — no flat rate, no overpayment.
 *
 * Demonstrates:
 *   - Variable-cost API calls with exact payment
 *   - Cumulative token tracking across a conversation
 *   - Pay-per-token in a single request/response cycle
 *   - Cost comparison: exact metering vs flat-rate pricing
 *
 * Run:
 *   SOLANA_PRIVATE_KEY=base58... npx tsx client.ts
 */

import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { createSessionClient } from "@dexterai/mpp/client/session";

const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: SOLANA_PRIVATE_KEY environment variable required");
  process.exit(1);
}

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3002";
const DEPOSIT = process.env.DEPOSIT ?? "100000"; // 0.10 USDC

// Simulated conversation — varying prompt lengths to demonstrate variable cost
const conversation: string[] = [
  "What is Solana?",
  "Tell me about the DeFi ecosystem on Solana. Which protocols have the most TVL?",
  "How do x402 payments work?",
  "Explain streaming micropayments and sessions. How is it different from paying per request?",
  "What is MPP?",
  "Short answer: what's the settlement cost?",
  "Compare Solana DeFi to other chains",
  "Thanks",
];

async function main() {
  console.log("\n  Token-Metered Inference Client");
  console.log("  ══════════════════════════════════════════════════════════════\n");

  const keyBytes = getBase58Encoder().encode(PRIVATE_KEY);
  const signer = await createKeyPairSignerFromBytes(keyBytes);

  const session = createSessionClient({
    buyerWallet: signer.address,
    buyerSwigAddress: "",
    onProgress: (e) => {
      if (e.type === "opened") console.log(`  Session: ${e.channelId}\n`);
    },
  });

  // Onboard
  console.log("[setup] Onboarding...");
  const onboard = await session.onboard({ signer });
  console.log(`[setup] Swig: ${onboard.swigAddress}`);

  // Get challenge for pricing info
  const challengeRes = await fetch(`${SERVER_URL}/inference/challenge`);
  const challenge = await challengeRes.json();
  console.log(`[setup] Input:  ${challenge.pricing.inputTokenPrice}`);
  console.log(`[setup] Output: ${challenge.pricing.outputTokenPrice}\n`);

  // Open session
  const channel = await session.open({ seller: challenge.recipient, deposit: DEPOSIT });

  const messages: { role: string; content: string }[] = [];
  let cumulativeWeightedTokens = 0n;
  const requestCosts: { prompt: string; inputTokens: number; outputTokens: number; cost: bigint; costUsd: string }[] = [];

  // ─── Conversation Loop ──────────────────────────────────────────────────

  for (let i = 0; i < conversation.length; i++) {
    const userMessage = conversation[i];
    messages.push({ role: "user", content: userMessage });

    // Estimate cost for this request (input tokens * 1 + estimated output * 3)
    // We over-estimate slightly to ensure the voucher covers the actual cost
    const inputTokenEstimate = Math.ceil(
      messages.reduce((sum, m) => sum + m.content.length / 4, 0)
    );
    const outputTokenEstimate = 150; // conservative estimate
    const estimatedCost = BigInt(inputTokenEstimate * 1 + outputTokenEstimate * 3);
    cumulativeWeightedTokens += estimatedCost;

    // Pay with voucher
    const voucher = await session.pay(channel.channel_id, {
      amount: cumulativeWeightedTokens.toString(),
      serverNonce: `chat-${i}-${Date.now()}`,
      meter: "weighted_tokens",
      units: estimatedCost.toString(),
    });

    // Send to inference API
    const chatRes = await fetch(`${SERVER_URL}/inference/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mpp-voucher": JSON.stringify(voucher),
      },
      body: JSON.stringify({ messages, channelId: channel.channel_id }),
    });

    const chat = await chatRes.json();

    if (chat.response) {
      messages.push(chat.response);

      const usage = chat.usage;
      requestCosts.push({
        prompt: userMessage.slice(0, 50),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: BigInt(usage.requestCost),
        costUsd: usage.requestCostUsd,
      });

      // Truncate for display
      const responsePreview = chat.response.content.slice(0, 80);
      console.log(`  [${i + 1}] User: "${userMessage}"`);
      console.log(`      AI:   "${responsePreview}..."`);
      console.log(`      Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out = ${usage.requestCostUsd}`);
      console.log(`      Cumulative: ${usage.cumulativeCostUsd} (${usage.requestNumber} requests)\n`);
    } else {
      console.log(`  [${i + 1}] FAILED: ${chat.error || JSON.stringify(chat).slice(0, 100)}\n`);
    }
  }

  // Close session
  console.log("  Closing session...");
  const settlement = await session.close(channel.channel_id);

  // ─── Results ────────────────────────────────────────────────────────────

  const totalInputTokens = requestCosts.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutputTokens = requestCosts.reduce((s, r) => s + r.outputTokens, 0);
  const totalCost = requestCosts.reduce((s, r) => s + r.cost, 0n);

  // Calculate what flat-rate pricing would cost
  const maxRequestCost = requestCosts.reduce((max, r) => r.cost > max ? r.cost : max, 0n);
  const flatRateTotal = maxRequestCost * BigInt(requestCosts.length);

  console.log("\n  ══════════════════════════════════════════════════════════════");
  console.log("  TOKEN METERING RESULTS");
  console.log("  ══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Per-Request Breakdown:");
  for (const r of requestCosts) {
    console.log(`    "${r.prompt.padEnd(50)}" ${String(r.inputTokens).padStart(4)} in  ${String(r.outputTokens).padStart(4)} out  ${r.costUsd}`);
  }
  console.log("");
  console.log(`  Total tokens:          ${totalInputTokens} input + ${totalOutputTokens} output`);
  console.log(`  Total requests:        ${requestCosts.length}`);
  console.log(`  Exact cost:            $${(Number(totalCost) / 1e6).toFixed(6)}`);
  console.log(`  Settled:               ${settlement.settlement.amount_settled} atomic`);
  console.log(`  Refunded:              ${settlement.settlement.buyer_refund} atomic`);
  console.log(`  Settlement tx:         ${settlement.close_tx_signature}`);
  console.log("");
  console.log("  Pricing Model Comparison:");
  console.log(`    Exact (sessions):    $${(Number(totalCost) / 1e6).toFixed(6)} — pay for actual tokens used`);
  console.log(`    Flat rate:           $${(Number(flatRateTotal) / 1e6).toFixed(6)} — charge max-cost per request`);
  console.log(`    Savings:             $${(Number(flatRateTotal - totalCost) / 1e6).toFixed(6)} (${((1 - Number(totalCost) / Number(flatRateTotal)) * 100).toFixed(0)}%)`);
  console.log("");
  console.log("  Without sessions, exact per-token billing requires either:");
  console.log("    1. Two round trips per request (generate → charge exact amount)");
  console.log("    2. Flat-rate pricing that overcharges short responses");
  console.log("  Sessions enable exact billing in a single request/response cycle.");
  console.log("  ══════════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
