# Streaming Price Feed

Real-time token price feed charging per tick via MPP sessions. Demonstrates high-frequency paid data streaming that is impossible with per-request on-chain settlement.

## What This Proves

At 10 ticks/second, a 30-second session delivers 300 paid price updates. With charge mode, that's 300 on-chain transactions — $0.30 in gas alone, plus 300 seconds of cumulative settlement latency. With sessions, it's 300 vouchers (verified locally in microseconds) and 2 on-chain transactions total.

At higher tick rates, charge mode becomes physically impossible — Solana processes ~400 TPS total across the entire network.

## Architecture

```
Client                          Server                        Solana
  │                               │                              │
  │  GET /prices/challenge        │                              │
  │──────────────────────────────>│                              │
  │  { pricePerTick, tokens }    │                              │
  │<──────────────────────────────│                              │
  │                               │                              │
  │  session.open()               │                              │
  │──────────────────────────────────────────────────────────────>│  (1 tx)
  │                               │                              │
  │  ┌─── tick loop ────────────────────────────────────┐        │
  │  │  session.pay() → voucher  (off-chain, ~1ms)      │        │
  │  │  GET /prices/stream + voucher                    │        │
  │  │  server.verifyVoucher()   (local Ed25519, <1ms)  │        │
  │  │  ← price tick             (SSE event)            │        │
  │  │  ... 10x/sec for 30 seconds = 300 ticks ...      │        │
  │  └──────────────────────────────────────────────────┘        │
  │                               │                              │
  │  session.close()              │                              │
  │──────────────────────────────────────────────────────────────>│  (1 tx)
  │  { settled, refund, tx }     │                              │
```

2 transactions. 300 paid data points. $0.001 in gas.

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
| `RECIPIENT` | (required) | Seller's Solana wallet |
| `PORT` | 3000 | Server port |
| `TICK_INTERVAL_MS` | 100 | Milliseconds between ticks (100 = 10/sec) |
| `PRICE_PER_TICK` | 100 | Cost per tick in atomic USDC ($0.0001) |
| `SOLANA_PRIVATE_KEY` | (required) | Buyer's keypair (base58) |
| `DURATION_SEC` | 30 | How long to stream |
| `TOKENS` | SOL,BTC,ETH | Comma-separated token symbols |
| `DEPOSIT` | 100000 | Session deposit in atomic USDC (0.10 USDC) |

## Output

The client prints a results table at the end:

```
  RESULTS
  ══════════════════════════════════════════════════════════════
  Duration:              30.2s
  Ticks consumed:        300
  Ticks/second:          9.9
  Total paid:            30000 atomic ($0.0300 USDC)
  On-chain txs:          2 (open + close)

  Cost Comparison
  Session total gas:     $0.0002 (2 txs)
  Charge mode gas:       $0.0255 (300 txs)
  Gas savings:           99.3%
  ══════════════════════════════════════════════════════════════
```
