# Token-Metered Inference

A simulated LLM API charging per token generated. The cost per request varies based on actual output length. Demonstrates exact pay-per-token billing in a single request/response cycle — something impossible without sessions.

## What This Proves

"How much does this API call cost?" depends on the response. A short answer costs less than a detailed explanation. Without sessions, you either:

1. **Flat-rate pricing** — charge the maximum possible cost per request. The buyer overpays for every short response. A simple "yes/no" answer costs the same as a 500-word essay.

2. **Two round trips** — generate the response first, calculate the exact token cost, then charge in a second transaction. Doubles latency, doubles on-chain transactions.

With sessions, the seller counts tokens after generation and the cumulative cost is tracked in the voucher. The buyer pays exactly what they consume, in one request/response cycle. No overpayment, no second transaction.

## Pricing

| Token Type | Price | Per 1K Tokens |
|---|---|---|
| Input | 1 atomic ($0.000001) | $0.001 |
| Output | 3 atomic ($0.000003) | $0.003 |

Output tokens cost 3x input tokens because generation is more expensive than encoding.

## Architecture

```
Agent                          Inference API                  Solana
  │                               │                              │
  │  session.open()               │                              │
  │──────────────────────────────────────────────────────────────>│ (1 tx)
  │                               │                              │
  │  ┌─── conversation ────────────────────────────────┐         │
  │  │  pay(cumulative_tokens)   │                     │         │
  │  │  POST /chat + voucher ───>│                     │         │
  │  │                            │  generate response │         │
  │  │                            │  count tokens      │         │
  │  │                            │  verify voucher    │         │
  │  │  ← response + usage       │  (local, <1ms)     │         │
  │  │                            │                     │         │
  │  │  "What is Solana?"     → 8 in / 67 out = $0.000209       │
  │  │  "Tell me about DeFi" → 22 in / 55 out = $0.000187      │
  │  │  "Short answer: cost?" → 6 in / 12 out = $0.000042      │
  │  │  ... cost varies per response length ...        │         │
  │  └─────────────────────────────────────────────────┘         │
  │                               │                              │
  │  session.close()              │                              │
  │──────────────────────────────────────────────────────────────>│ (1 tx)
  │  { exact amount settled }    │                              │
```

8 requests. Variable costs. 2 on-chain transactions. Exact billing.

## Run

Terminal 1 — server:
```bash
RECIPIENT=YourSolanaWallet npx tsx server.ts
```

Terminal 2 — client:
```bash
SOLANA_PRIVATE_KEY=base58... npx tsx client.ts
```

## Output

The client shows per-request token usage and cost, then compares pricing models:

```
  TOKEN METERING RESULTS
  ══════════════════════════════════════════════════════════════
  Per-Request Breakdown:
    "What is Solana?"                                    8 in    67 out  $0.000209
    "Tell me about the DeFi ecosystem..."               22 in    55 out  $0.000187
    "How do x402 payments work?"                         9 in    72 out  $0.000225
    "Short answer: what's the settlement cost?"          8 in    12 out  $0.000044
    "Thanks"                                             2 in     8 out  $0.000026

  Pricing Model Comparison:
    Exact (sessions):    $0.000691 — pay for actual tokens
    Flat rate:           $0.001125 — charge max-cost per request
    Savings:             38%
  ══════════════════════════════════════════════════════════════
```
