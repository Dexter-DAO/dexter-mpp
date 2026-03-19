/**
 * Express seller server accepting MPP payments via Dexter managed settlement.
 *
 * Three paid endpoints demonstrating different pricing models:
 *   GET /api/weather/:city    — 0.01 USDC per request (fixed price)
 *   GET /api/quote            — 0.001 USDC per request (sub-cent micropayment)
 *   POST /api/analyze         — 0.05 USDC per request (higher-value endpoint)
 *
 * Run:
 *   RECIPIENT=YourSolanaWallet npm start
 *
 * The server needs zero blockchain infrastructure — Dexter handles settlement.
 */

import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { Mppx } from "mppx/server";
import { charge } from "@dexterai/mpp/server";

const RECIPIENT = process.env.RECIPIENT;
if (!RECIPIENT) {
  console.error("Error: RECIPIENT environment variable required (your Solana wallet address)");
  console.error("Usage: RECIPIENT=YourSolanaWallet npm start");
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
    }),
  ],
});

function toWebRequest(req: express.Request): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
  }
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    init.body = JSON.stringify(req.body);
  }
  return new Request(url, init);
}

function sendMppResponse(res: express.Response, mppResponse: Response) {
  for (const [key, value] of mppResponse.headers) {
    res.setHeader(key, value);
  }
  mppResponse.text().then((body) => res.status(mppResponse.status).send(body));
}

const WEATHER: Record<string, { temperature: number; conditions: string; humidity: number }> = {
  "san-francisco": { temperature: 15, conditions: "Foggy", humidity: 85 },
  "new-york": { temperature: 22, conditions: "Partly Cloudy", humidity: 60 },
  "london": { temperature: 12, conditions: "Rainy", humidity: 90 },
  "tokyo": { temperature: 26, conditions: "Sunny", humidity: 55 },
  "paris": { temperature: 18, conditions: "Overcast", humidity: 70 },
  "sydney": { temperature: 24, conditions: "Clear", humidity: 45 },
};

const app = express();
app.use(express.json());
app.use(cors({ exposedHeaders: ["www-authenticate", "payment-receipt"] }));

// Fixed price: 0.01 USDC per weather lookup
app.get("/api/weather/:city", async (req, res) => {
  const result = await mppx.charge({
    amount: "10000",
    currency: "USDC",
    description: `Weather for ${req.params.city}`,
  })(toWebRequest(req));

  if (result.status === 402) {
    return sendMppResponse(res, result.challenge as Response);
  }

  const city = req.params.city.toLowerCase().replace(/\s+/g, "-");
  const data = WEATHER[city];
  if (!data) {
    const available = Object.keys(WEATHER).join(", ");
    return res.status(404).json({ error: `City not found. Available: ${available}` });
  }

  sendMppResponse(res, result.withReceipt(Response.json({ city: req.params.city, ...data })) as Response);
});

// Micropayment: 0.001 USDC per quote
app.get("/api/quote", async (req, res) => {
  const result = await mppx.charge({
    amount: "1000",
    currency: "USDC",
    description: "Random inspirational quote",
  })(toWebRequest(req));

  if (result.status === 402) {
    return sendMppResponse(res, result.challenge as Response);
  }

  const quotes = [
    { text: "The best way to predict the future is to invent it.", author: "Alan Kay" },
    { text: "Move fast and break things.", author: "Mark Zuckerberg" },
    { text: "Stay hungry, stay foolish.", author: "Steve Jobs" },
    { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  ];
  const quote = quotes[Math.floor(Math.random() * quotes.length)];

  sendMppResponse(res, result.withReceipt(Response.json(quote)) as Response);
});

// Higher-value: 0.05 USDC per analysis
app.post("/api/analyze", async (req, res) => {
  const result = await mppx.charge({
    amount: "50000",
    currency: "USDC",
    description: "Text sentiment analysis",
  })(toWebRequest(req));

  if (result.status === 402) {
    return sendMppResponse(res, result.challenge as Response);
  }

  const text = req.body?.text ?? "";
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentiment = words > 10 ? "positive" : words > 5 ? "neutral" : "insufficient_data";

  sendMppResponse(
    res,
    result.withReceipt(Response.json({ sentiment, wordCount: words, confidence: 0.85 })) as Response,
  );
});

// Free health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    recipient: RECIPIENT,
    network: NETWORK,
    endpoints: [
      { method: "GET", path: "/api/weather/:city", price: "0.01 USDC" },
      { method: "GET", path: "/api/quote", price: "0.001 USDC" },
      { method: "POST", path: "/api/analyze", price: "0.05 USDC" },
    ],
  });
});

app.listen(PORT, () => {
  console.log(`\n  Dexter MPP Example Server\n`);
  console.log(`  Listening:   http://localhost:${PORT}`);
  console.log(`  Recipient:   ${RECIPIENT}`);
  console.log(`  Network:     ${NETWORK}`);
  console.log(`  Settlement:  ${API_URL}\n`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /api/weather/:city   0.01 USDC`);
  console.log(`    GET  /api/quote           0.001 USDC`);
  console.log(`    POST /api/analyze         0.05 USDC`);
  console.log(`    GET  /health              free\n`);
});
