/**
 * Token-Metered Inference — Session Server
 *
 * A simulated LLM API that charges per token generated. The cost per request
 * varies based on actual output length — the buyer doesn't know the cost
 * upfront because it depends on what the model generates.
 *
 * Demonstrates something impossible without sessions: exact pay-per-token
 * billing in a single request/response cycle. Without sessions, you'd need
 * either flat-rate pricing (overpay for short responses, underpay for long
 * ones) or a two-step flow (generate first, then charge exact amount in a
 * second transaction).
 *
 * With sessions, the seller tracks cumulative token consumption across the
 * conversation and the buyer sends a voucher for the exact cumulative amount
 * before each request. The seller verifies locally and responds immediately.
 *
 * Pricing:
 *   Input tokens:  $0.000001 per token (1 atomic USDC per token)
 *   Output tokens: $0.000003 per token (3 atomic USDC per token)
 *
 * Run:
 *   RECIPIENT=YourSolanaWallet npx tsx server.ts
 *
 * Endpoints:
 *   GET  /inference/challenge    — session challenge with pricing
 *   POST /inference/chat         — chat completion (requires voucher)
 *   GET  /inference/usage        — token usage and cost breakdown
 */

import express from "express";
import cors from "cors";
import { createSessionServer } from "@dexterai/mpp/server/session";

const RECIPIENT = process.env.RECIPIENT;
if (!RECIPIENT) {
  console.error("Error: RECIPIENT environment variable required");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3002);
const INPUT_PRICE = 1;  // 1 atomic per input token ($0.000001)
const OUTPUT_PRICE = 3; // 3 atomic per output token ($0.000003)

// ─── Simulated LLM ──────────────────────────────────────────────────────────

function countTokens(text: string): number {
  // Rough tokenization: ~4 chars per token (GPT-style approximation)
  return Math.max(1, Math.ceil(text.length / 4));
}

interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// Simulated responses based on topic keywords
const responses: Record<string, string[]> = {
  solana: [
    "Solana is a high-performance blockchain designed for decentralized applications and marketplaces. It achieves consensus through a combination of Proof of History (PoH) and Proof of Stake (PoS), enabling transaction throughput exceeding 50,000 TPS with sub-second finality.",
    "The Solana ecosystem includes major DeFi protocols like Jupiter (DEX aggregation), Marinade (liquid staking), and Raydium (concentrated liquidity). The total value locked across these protocols reached $14.2 billion in early 2026.",
    "Firedancer, the second validator client for Solana developed by Jump Crypto, launched on mainnet in 2025. It achieves up to 1 million TPS in synthetic benchmarks and has reduced average slot times to approximately 200ms.",
  ],
  defi: [
    "Decentralized Finance encompasses protocols that recreate traditional financial services on blockchain: lending (Aave, Compound), exchange (Uniswap, Jupiter), derivatives (dYdX, Drift), and asset management (Yearn, Kamino). The total DeFi TVL across all chains is approximately $180 billion.",
    "Concentrated liquidity, pioneered by Uniswap V3 and adopted across ecosystems (Raydium, Orca), allows liquidity providers to allocate capital within specific price ranges. This improves capital efficiency by 2-4x compared to full-range liquidity.",
  ],
  payments: [
    "The x402 protocol enables machine-to-machine payments over HTTP. When a server returns a 402 Payment Required response, the client's payment middleware automatically constructs and submits a USDC transfer, with a facilitator co-signing and sponsoring gas fees. This enables pay-per-request API monetization without subscriptions or API keys.",
    "Streaming micropayments via sessions allow an agent to make thousands of paid API calls with only two on-chain transactions: one to open the session and one to settle at close. Between open and close, payments happen via signed vouchers verified locally by the seller in microseconds.",
    "The Machine Payments Protocol (MPP) extends x402 with session-based payment channels. A buyer deposits USDC into a Swig smart wallet, grants the facilitator scoped delegation authority, and then pays per-request with cumulative signed vouchers. Settlement happens once at session close.",
  ],
  default: [
    "I can discuss topics related to blockchain technology, Solana, DeFi, payments, and the x402 protocol. Each response is metered by token count — you pay for exactly what you receive.",
    "This is a token-metered inference endpoint. Your payment covers the exact number of tokens generated. Short answers cost less. Detailed explanations cost more. You control the depth by controlling your prompts.",
  ],
};

function generateResponse(messages: ConversationMessage[]): string {
  const lastMessage = messages[messages.length - 1]?.content?.toLowerCase() || "";

  // Find best matching topic
  for (const [topic, pool] of Object.entries(responses)) {
    if (topic === "default") continue;
    if (lastMessage.includes(topic)) {
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }

  return responses.default[Math.floor(Math.random() * responses.default.length)];
}

// ─── Server ──────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// We use a base price of 1 atomic per "unit" and calculate total tokens as
// (input_tokens * INPUT_PRICE + output_tokens * OUTPUT_PRICE) units
const sessions = createSessionServer({
  recipient: RECIPIENT,
  pricePerUnit: "1", // 1 atomic per unit (we define units as weighted tokens)
  meter: "weighted_tokens",
});

// Track per-session token usage
const usageTracking = new Map<string, {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: bigint;
  requestCount: number;
  messages: ConversationMessage[];
}>();

app.get("/inference/challenge", (_req, res) => {
  res.json({
    ...sessions.getChallenge(),
    pricing: {
      inputTokenPrice: `${INPUT_PRICE} atomic ($${(INPUT_PRICE / 1e6).toFixed(6)}/token)`,
      outputTokenPrice: `${OUTPUT_PRICE} atomic ($${(OUTPUT_PRICE / 1e6).toFixed(6)}/token)`,
      unit: "weighted_tokens (input * 1 + output * 3)",
      note: "Cost varies per request based on response length. Voucher amount must cover cumulative weighted tokens.",
    },
    model: "dexter-sim-1",
    maxOutputTokens: 500,
  });
});

app.post("/inference/chat", (req, res) => {
  const voucher = req.headers["x-mpp-voucher"];
  if (!voucher) {
    return res.status(402).json(sessions.getChallenge());
  }

  const { messages, channelId } = req.body;
  if (!messages || !Array.isArray(messages) || !channelId) {
    return res.status(400).json({ error: "messages array and channelId required" });
  }

  // Count input tokens
  const inputTokens = messages.reduce((sum: number, m: ConversationMessage) =>
    sum + countTokens(m.content), 0);

  // Generate response
  const responseText = generateResponse(messages);
  const outputTokens = countTokens(responseText);

  // Calculate cost for this request
  const requestCost = BigInt(inputTokens * INPUT_PRICE + outputTokens * OUTPUT_PRICE);

  // Update cumulative tracking
  let usage = usageTracking.get(channelId);
  if (!usage) {
    usage = { totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0n, requestCount: 0, messages: [] };
    usageTracking.set(channelId, usage);
  }
  usage.totalInputTokens += inputTokens;
  usage.totalOutputTokens += outputTokens;
  usage.totalCost += requestCost;
  usage.requestCount++;
  usage.messages.push(...messages, { role: "assistant", content: responseText });

  // Verify voucher covers cumulative cost
  // The voucher amount should be >= total weighted tokens across all requests
  const result = sessions.verifyVoucher(JSON.parse(voucher as string));
  if (!result.valid) {
    // Undo tracking on failure
    usage.totalInputTokens -= inputTokens;
    usage.totalOutputTokens -= outputTokens;
    usage.totalCost -= requestCost;
    usage.requestCount--;
    usage.messages.splice(-messages.length - 1);
    return res.status(402).json({ error: result.error });
  }

  res.json({
    response: {
      role: "assistant",
      content: responseText,
    },
    usage: {
      inputTokens,
      outputTokens,
      requestCost: requestCost.toString(),
      requestCostUsd: `$${(Number(requestCost) / 1e6).toFixed(6)}`,
      cumulativeInputTokens: usage.totalInputTokens,
      cumulativeOutputTokens: usage.totalOutputTokens,
      cumulativeCost: usage.totalCost.toString(),
      cumulativeCostUsd: `$${(Number(usage.totalCost) / 1e6).toFixed(6)}`,
      requestNumber: usage.requestCount,
    },
    model: "dexter-sim-1",
    payment: { paid: result.amountPaid, meter: "weighted_tokens" },
  });
});

app.get("/inference/usage", (req, res) => {
  const channelId = req.query.channel as string;
  if (!channelId) {
    // Return all sessions
    const all: Record<string, any> = {};
    for (const [id, usage] of usageTracking) {
      const flatRate = Number(usage.totalCost) * 1.5; // what flat rate would cost (50% markup)
      all[id] = {
        requests: usage.requestCount,
        inputTokens: usage.totalInputTokens,
        outputTokens: usage.totalOutputTokens,
        totalCost: `${usage.totalCost} atomic ($${(Number(usage.totalCost) / 1e6).toFixed(6)})`,
        comparison: {
          exactPayPerToken: `$${(Number(usage.totalCost) / 1e6).toFixed(6)}`,
          flatRateEquivalent: `$${(flatRate / 1e6).toFixed(6)} (50% markup for variable-length uncertainty)`,
          savings: `$${((flatRate - Number(usage.totalCost)) / 1e6).toFixed(6)} saved with exact metering`,
        },
      };
    }
    return res.json({ sessions: all });
  }

  const usage = usageTracking.get(channelId);
  if (!usage) return res.status(404).json({ error: "session not found" });

  res.json({
    channelId,
    requests: usage.requestCount,
    inputTokens: usage.totalInputTokens,
    outputTokens: usage.totalOutputTokens,
    totalCost: `${usage.totalCost} atomic ($${(Number(usage.totalCost) / 1e6).toFixed(6)})`,
    averageTokensPerRequest: {
      input: Math.round(usage.totalInputTokens / usage.requestCount),
      output: Math.round(usage.totalOutputTokens / usage.requestCount),
    },
    averageCostPerRequest: `$${(Number(usage.totalCost) / usage.requestCount / 1e6).toFixed(6)}`,
  });
});

app.listen(PORT, () => {
  console.log(`\n  Token-Metered Inference Server`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  Recipient:     ${RECIPIENT}`);
  console.log(`  Input price:   ${INPUT_PRICE} atomic/token ($${(INPUT_PRICE / 1e6).toFixed(6)})`);
  console.log(`  Output price:  ${OUTPUT_PRICE} atomic/token ($${(OUTPUT_PRICE / 1e6).toFixed(6)})`);
  console.log(`  Model:         dexter-sim-1`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  GET  /inference/challenge — session + pricing`);
  console.log(`  POST /inference/chat      — chat completion`);
  console.log(`  GET  /inference/usage     — token usage stats`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  Listening on :${PORT}\n`);
});
