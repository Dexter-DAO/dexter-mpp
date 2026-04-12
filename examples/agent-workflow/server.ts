/**
 * Multi-Step Agent Workflow — API Server
 *
 * Three paid API endpoints that an AI agent chains together in a workflow:
 *   /api/research    — search + retrieve documents ($0.005/request)
 *   /api/summarize   — condense documents into key findings ($0.01/request)
 *   /api/generate    — produce structured output from findings ($0.02/request)
 *
 * Demonstrates something impossible without sessions: an agent making 20+
 * paid API calls in a tight decision loop, where each call depends on the
 * previous result. With charge mode, each call blocks for ~1s waiting for
 * on-chain settlement. A 20-step workflow adds 20+ seconds of payment latency.
 * With sessions, payment adds microseconds per step.
 *
 * Run:
 *   RECIPIENT=YourSolanaWallet npx tsx server.ts
 */

import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { createSessionServer } from "@dexterai/mpp/server/session";

const RECIPIENT = process.env.RECIPIENT;
if (!RECIPIENT) {
  console.error("Error: RECIPIENT environment variable required");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3001);

const app = express();
app.use(cors());
app.use(express.json());

// ─── Research API ($0.005/request) ──────────────────────────────────────────

const researchSessions = createSessionServer({
  recipient: RECIPIENT,
  pricePerUnit: "5000", // $0.005
  meter: "research_queries",
});

// Simulated research database
const documents: Record<string, { title: string; content: string; relevance: number }[]> = {
  "solana defi": [
    { title: "Solana DeFi TVL Analysis Q1 2026", content: "Total value locked across Solana DeFi protocols reached $14.2B in Q1 2026, driven primarily by liquid staking (Marinade, Jito) and DEX aggregation (Jupiter). The migration from EVM chains accelerated after Firedancer's mainnet launch reduced slot times to 200ms.", relevance: 0.95 },
    { title: "Raydium vs Orca: Market Share Dynamics", content: "Raydium's concentrated liquidity pools captured 62% of Solana DEX volume in March 2026, up from 45% in January. Orca's Whirlpools maintain dominance in stablecoin pairs with tighter spreads.", relevance: 0.87 },
    { title: "Swig Smart Wallets and DeFi Composability", content: "Swig's delegation model enables gasless DeFi interactions through scoped authority roles. Early integrations include Jupiter limit orders and Marinade native staking, both operating without user signatures per transaction.", relevance: 0.82 },
  ],
  "ai agents payments": [
    { title: "Machine Payments Protocol Adoption", content: "MPP transaction volume grew 340% in Q1 2026, with 47 API providers accepting session-based micropayments. The average session processes 1,200 vouchers before settlement, with median session values of $2.40.", relevance: 0.93 },
    { title: "x402 Protocol Ecosystem Report", content: "The x402 payment standard now has 26 facilitators across Solana and 8 EVM chains. Dexter processes 52% of daily settlement volume. Key growth areas: LLM inference billing, real-time data feeds, and multi-agent orchestration.", relevance: 0.91 },
    { title: "Agent-to-Agent Commerce Patterns", content: "Autonomous agent spending reached $1.2M/month across x402 facilitators in March 2026. Primary use cases: data enrichment (38%), code generation (24%), research synthesis (21%), monitoring (17%).", relevance: 0.88 },
  ],
  "default": [
    { title: "General Web3 Infrastructure Trends", content: "Cross-chain bridge volume exceeded $50B in Q1 2026. Account abstraction wallets surpassed 10M deployments across EVM chains. Solana's Firedancer client processes 50,000+ TPS in testnet.", relevance: 0.65 },
  ],
};

app.get("/api/research", (req, res) => {
  const voucher = req.headers["x-mpp-voucher"];
  if (!voucher) {
    return res.status(402).json(researchSessions.getChallenge());
  }

  const result = researchSessions.verifyVoucher(JSON.parse(voucher as string));
  if (!result.valid) {
    return res.status(402).json({ error: result.error });
  }

  const query = (req.query.q as string || "default").toLowerCase();
  const matchKey = Object.keys(documents).find(k => query.includes(k)) || "default";
  const results = documents[matchKey];

  res.json({
    query,
    results: results.map(d => ({
      title: d.title,
      snippet: d.content.slice(0, 120) + "...",
      relevance: d.relevance,
      documentId: crypto.createHash("sha256").update(d.title).digest("hex").slice(0, 12),
    })),
    payment: { paid: result.amountPaid, meter: "research_queries" },
  });
});

// ─── Summarize API ($0.01/request) ──────────────────────────────────────────

const summarizeSessions = createSessionServer({
  recipient: RECIPIENT,
  pricePerUnit: "10000", // $0.01
  meter: "summarize_calls",
});

app.post("/api/summarize", (req, res) => {
  const voucher = req.headers["x-mpp-voucher"];
  if (!voucher) {
    return res.status(402).json(summarizeSessions.getChallenge());
  }

  const result = summarizeSessions.verifyVoucher(JSON.parse(voucher as string));
  if (!result.valid) {
    return res.status(402).json({ error: result.error });
  }

  const { documents: docs, focusArea } = req.body;
  if (!docs || !Array.isArray(docs)) {
    return res.status(400).json({ error: "documents array required" });
  }

  // Simulated summarization
  const keyFindings = docs.map((d: any, i: number) => ({
    finding: `Finding ${i + 1}: ${d.snippet?.slice(0, 60) || d.title || "Unknown"}...`,
    confidence: 0.7 + Math.random() * 0.25,
    source: d.documentId || d.title,
  }));

  const summary = focusArea
    ? `Analysis of ${docs.length} documents focusing on "${focusArea}": ${keyFindings.length} key findings identified.`
    : `Synthesized ${docs.length} documents into ${keyFindings.length} key findings.`;

  res.json({
    summary,
    keyFindings,
    documentCount: docs.length,
    payment: { paid: result.amountPaid, meter: "summarize_calls" },
  });
});

// ─── Generate API ($0.02/request) ────────────────────────────────────────────

const generateSessions = createSessionServer({
  recipient: RECIPIENT,
  pricePerUnit: "20000", // $0.02
  meter: "generate_calls",
});

app.post("/api/generate", (req, res) => {
  const voucher = req.headers["x-mpp-voucher"];
  if (!voucher) {
    return res.status(402).json(generateSessions.getChallenge());
  }

  const result = generateSessions.verifyVoucher(JSON.parse(voucher as string));
  if (!result.valid) {
    return res.status(402).json({ error: result.error });
  }

  const { findings, outputFormat, topic } = req.body;
  if (!findings || !Array.isArray(findings)) {
    return res.status(400).json({ error: "findings array required" });
  }

  const format = outputFormat || "report";

  let output: any;
  if (format === "report") {
    output = {
      type: "report",
      title: `${topic || "Research"} Analysis Report`,
      sections: [
        {
          heading: "Executive Summary",
          content: `Based on ${findings.length} key findings, this report synthesizes the current state of ${topic || "the research area"}.`,
        },
        {
          heading: "Key Findings",
          content: findings.map((f: any, i: number) =>
            `${i + 1}. ${f.finding} (confidence: ${(f.confidence * 100).toFixed(0)}%)`
          ).join("\n"),
        },
        {
          heading: "Methodology",
          content: "Findings were extracted via MPP session-based research pipeline. Each data retrieval, summarization, and generation step was paid for with cryptographic vouchers, settled on-chain in a single transaction.",
        },
      ],
      generatedAt: new Date().toISOString(),
    };
  } else if (format === "json") {
    output = {
      type: "structured_data",
      topic,
      findings: findings.map((f: any) => ({
        ...f,
        tags: ["auto-generated", topic?.toLowerCase()].filter(Boolean),
      })),
      metadata: { generatedAt: new Date().toISOString(), findingCount: findings.length },
    };
  } else {
    output = {
      type: "text",
      content: findings.map((f: any) => `- ${f.finding}`).join("\n"),
    };
  }

  res.json({
    output,
    payment: { paid: result.amountPaid, meter: "generate_calls" },
  });
});

// ─── Workflow challenge (all three services) ─────────────────────────────────

app.get("/api/workflow/challenge", (_req, res) => {
  res.json({
    services: [
      { endpoint: "/api/research", method: "GET", ...researchSessions.getChallenge() },
      { endpoint: "/api/summarize", method: "POST", ...summarizeSessions.getChallenge() },
      { endpoint: "/api/generate", method: "POST", ...generateSessions.getChallenge() },
    ],
    note: "Open one session per service, or one session shared across all. Each service verifies vouchers independently.",
  });
});

app.listen(PORT, () => {
  console.log(`\n  Agent Workflow API Server`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  Recipient: ${RECIPIENT}`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  GET  /api/research?q=     — $0.005/query`);
  console.log(`  POST /api/summarize       — $0.01/call`);
  console.log(`  POST /api/generate        — $0.02/call`);
  console.log(`  GET  /api/workflow/challenge`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(`  Listening on :${PORT}\n`);
});
