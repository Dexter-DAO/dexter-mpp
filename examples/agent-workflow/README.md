# Multi-Step Agent Workflow

An autonomous agent chains three paid APIs in a decision loop — research, summarize, generate — with payment at every step. Demonstrates tight-loop agent workflows where per-request settlement latency makes the task impractical.

## What This Proves

A 3-iteration workflow makes ~10 paid API calls across three services. With charge mode, each call blocks for ~1 second waiting for on-chain settlement before the seller responds. The workflow takes 10+ extra seconds just in payment latency. With sessions, payment adds milliseconds total. The agent runs at API speed, not chain speed.

The agent also makes autonomous decisions — iterating research queries based on summarization results, deciding when findings are sufficient. This kind of iterative, branching workflow is impossible when every step incurs a 1-second payment penalty.

## Architecture

```
Agent                          Research API     Summarize API    Generate API
  │                               │                │                │
  │  session.open()               │                │                │
  │                               │                │                │
  │  ┌─── iteration 1 ──────────────────────────────────────────┐
  │  │  pay() → voucher (1ms)    │                │                │
  │  │  GET /research?q=topic ──>│                │                │
  │  │  ← documents              │                │                │
  │  │                            │                │                │
  │  │  pay() → voucher (1ms)    │                │                │
  │  │  POST /summarize ────────────────────────>│                │
  │  │  ← key findings           │                │                │
  │  │                            │                │                │
  │  │  Agent decides: need more data? ──> yes ──> iterate        │
  │  └───────────────────────────────────────────────────────────┘
  │  ┌─── iteration 2 ──────────────────────────────────────────┐
  │  │  pay() → voucher with refined query                       │
  │  │  ... (same pattern, different query based on findings)     │
  │  └───────────────────────────────────────────────────────────┘
  │                               │                │                │
  │  pay() → voucher (1ms)       │                │                │
  │  POST /generate ──────────────────────────────────────────>│
  │  ← structured report         │                │                │
  │                               │                │                │
  │  session.close()              │                │                │
  │  ← settlement tx              │                │                │
```

10 paid API calls. 2 on-chain transactions. Payment adds milliseconds, not seconds.

## Run

Terminal 1 — server:
```bash
RECIPIENT=YourSolanaWallet npx tsx server.ts
```

Terminal 2 — client:
```bash
SOLANA_PRIVATE_KEY=base58... npx tsx client.ts
```

### Options

| Env Var | Default | Description |
|---|---|---|
| `TOPIC` | ai agents payments | Research topic |
| `ITERATIONS` | 3 | Number of research-summarize cycles before generating |
| `DEPOSIT` | 500000 | Session deposit (0.50 USDC) |

## Output

The client prints per-step timing, cost breakdown, and a charge-mode comparison:

```
  WORKFLOW RESULTS
  ══════════════════════════════════════════════════════════════
  Steps executed:        10
  Total workflow time:   2.3s
  Time in payments:      47ms (2.0% of workflow)

  Charge Mode Comparison:
  Session workflow:      2.3s
  Charge mode estimate:  12.3s (each step waits ~1s for on-chain)
  Speedup:              212x faster payment verification
  ══════════════════════════════════════════════════════════════
```
