---
name: dexter-mpp
description: "Build with @dexterai/mpp — Dexter's managed Solana settlement for the Machine Payments Protocol. Use when adding MPP payments to a server, building an agent that pays for APIs, integrating with the Dexter settlement API, or debugging MPP payment flows."
---

# @dexterai/mpp — Managed Solana Settlement for MPP

Use this skill when building anything that involves MPP (Machine Payments Protocol) payments on Solana through Dexter's managed settlement infrastructure.

## What This Is

`@dexterai/mpp` is an MPP payment method that delegates Solana USDC settlement to Dexter's hosted infrastructure. Sellers install the package and accept payments without running any blockchain infrastructure. Buyers need only USDC — no SOL for gas.

**Package:** `@dexterai/mpp`
**Repo:** `~/websites/dexter-mpp`
**Settlement API:** `https://x402.dexter.cash/mpp/*`
**Facilitator endpoints:** defined in `~/websites/dexter-facilitator/src/mpp.ts`

## When To Use What

**Building a seller server that accepts MPP payments?**
→ `import { charge } from '@dexterai/mpp/server'`

**Building an agent/client that pays for MPP resources?**
→ `import { charge } from '@dexterai/mpp/client'`

**Need direct access to the settlement API?**
→ `import { DexterSettlementClient } from '@dexterai/mpp/api'`

**Working on the facilitator-side endpoints?**
→ Edit `~/websites/dexter-facilitator/src/mpp.ts`

**Need x402 payments instead of MPP?**
→ Use `@dexterai/x402` — see the **x402-implementations** skill

## Architecture

Three actors:

- **Buyer** — has USDC, signs transfer authority. Needs zero SOL.
- **Seller** — runs server with `charge({ recipient })`. Needs zero blockchain infra.
- **Dexter (facilitator)** — co-signs as fee payer, broadcasts, confirms on-chain.

```
Client → Seller Server → Dexter /mpp/prepare (get feePayer + blockhash)
                       ← 402 Challenge
Client builds + partially signs TransferChecked tx
Client → Seller Server → Dexter /mpp/settle (full settlement pipeline)
                       ← Receipt with tx signature
```

## Server Integration

### Minimal setup

```typescript
import crypto from 'node:crypto';
import { Mppx } from 'mppx/server';
import { charge } from '@dexterai/mpp/server';

const mppx = Mppx.create({
  secretKey: crypto.randomBytes(32).toString('hex'),
  methods: [
    charge({ recipient: 'YourSolanaWalletAddress' }),
  ],
});
```

### Protecting an endpoint

```typescript
app.get('/api/data', async (req, res) => {
  const result = await mppx.charge({
    amount: '10000',    // 0.01 USDC (6 decimals)
    currency: 'USDC',
  })(toWebRequest(req));

  if (result.status === 402) {
    // Return 402 challenge to client
    const challenge = result.challenge as Response;
    for (const [key, value] of challenge.headers) res.setHeader(key, value);
    return res.status(402).send(await challenge.text());
  }

  // Payment verified — serve content with receipt
  const response = result.withReceipt(Response.json({ data: '...' })) as Response;
  for (const [key, value] of response.headers) res.setHeader(key, value);
  res.status(200).send(await response.text());
});
```

### Express Request → Web Request adapter

MPP uses Web API Request/Response. Express needs an adapter:

```typescript
function toWebRequest(req: express.Request): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
  }
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    init.body = JSON.stringify(req.body);
  }
  return new Request(url, init);
}
```

Hono does not need this — it uses Web API types natively.

### Server charge() parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `recipient` | **yes** | — | Solana wallet address that receives USDC |
| `apiUrl` | no | `https://x402.dexter.cash` | Dexter settlement API URL |
| `network` | no | `mainnet-beta` | `mainnet-beta` or `devnet` |
| `splToken` | no | USDC on network | SPL token mint |
| `decimals` | no | `6` | Token decimals |
| `verifyRpcUrl` | no | — | Solana RPC URL for independent on-chain verification |

### On-chain verification (optional)

For high-value endpoints, add `verifyRpcUrl` to independently verify settlements:

```typescript
charge({
  recipient: 'YourWallet',
  verifyRpcUrl: 'https://api.mainnet-beta.solana.com',
})
```

This fetches the transaction from chain after settlement and verifies the TransferChecked instruction matches. Adds ~1-2s latency.

## Client Integration

### Headless agent

```typescript
import { Mppx } from 'mppx/client';
import { charge } from '@dexterai/mpp/client';
import { createKeyPairSignerFromBytes, getBase58Encoder } from '@solana/kit';

const signer = await createKeyPairSignerFromBytes(
  getBase58Encoder().encode(process.env.SOLANA_PRIVATE_KEY),
);

const mppx = Mppx.create({
  methods: [charge({ signer })],
  polyfill: false,
});

const response = await mppx.fetch('https://api.example.com/paid-endpoint');
```

### Client charge() parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `signer` | **yes** | — | `@solana/kit` TransactionSigner |
| `computeUnitPrice` | no | `1n` | Priority fee in micro-lamports |
| `computeUnitLimit` | no | `50000` | Compute unit limit |
| `onProgress` | no | — | Callback: `building`, `signing`, `signed` events |

## Settlement API

Open endpoints on the facilitator. No auth required.

### POST /mpp/prepare

Returns fee payer info and blockhash for challenge generation.

**Request:** `{ "network": "mainnet-beta" }`

**Response:**
```json
{
  "feePayer": "DEXVS3...",
  "recentBlockhash": "...",
  "lastValidBlockHeight": 385510966,
  "network": "mainnet-beta",
  "splToken": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "decimals": 6,
  "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
}
```

### POST /mpp/settle

Full settlement: validate, co-sign, simulate, broadcast, confirm.

**Request:**
```json
{
  "transaction": "base64...",
  "recipient": "SellerWallet",
  "amount": "10000",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "network": "mainnet-beta"
}
```

**Success response:**
```json
{
  "success": true,
  "signature": "5wHu...",
  "payer": "BuyerWallet",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "settlement": {
    "recipient": "SellerWallet",
    "amount": "10000",
    "asset": "EPjFWdd5...",
    "feePayer": "DEXVS3..."
  }
}
```

## Critical Constraints

1. **Recipients must have a USDC ATA.** The facilitator blocks ATA creation instructions to prevent rent-drain attacks on the fee payer. Any wallet that has ever held USDC already has an ATA.

2. **USDC only.** The facilitator's devnet asset allowlist is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Mainnet is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

3. **Buyers need zero SOL.** Dexter sponsors all gas. The client sets Dexter's fee payer key on the transaction and partially signs with transfer authority only.

4. **Network must be recognized.** The facilitator rejects unrecognized network names with a 400 listing supported options. Valid values: `mainnet-beta`, `devnet`, or CAIP-2 identifiers.

5. **Allowed programs only.** Transactions can contain: ComputeBudget, SPL Token, Token-2022, Lighthouse, Memo. Everything else is rejected by the facilitator's security policy.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `policy:program_not_allowed` | Transaction contains a disallowed program | Remove non-standard instructions |
| `no_transfer_instruction` | No TransferChecked in the transaction | Client must build a USDC TransferChecked |
| `policy:fee_payer_not_isolated` | Fee payer appears in instruction accounts | Fee payer can only sign for gas |
| `settlement_recipient_mismatch` | Facilitator settled to wrong address | Facilitator bug — report it |
| `settlement_amount_mismatch` | Facilitator settled wrong amount | Facilitator bug — report it |
| Timeout on prepare (10s) | Facilitator unreachable | Check facilitator is running, check `apiUrl` |
| Timeout on settle (30s) | Solana congestion | Retry; check Solana network status |
| Simulation failure | Insufficient USDC or missing ATA | Verify buyer has USDC, recipient has ATA |

## File Layout

```
~/websites/dexter-mpp/          # NPM package repo
  src/
    methods.ts                  # Method.from schema (name: "dexter", intent: "charge")
    server/charge.ts            # Method.toServer — delegates to Dexter API
    client/charge.ts            # Method.toClient — builds TransferChecked txs
    api.ts                      # DexterSettlementClient + SettlementError
    constants.ts                # USDC mints, token programs
    index.ts                    # Barrel export for root import
  examples/
    server-express/             # Express seller with 3 price tiers
    server-hono/                # Hono seller (zero adapter needed)
    client-headless/            # Agent client with progress events
    client-with-verification/   # Seller with on-chain RPC verification
  test/
    devnet-e2e.ts               # Real payment on Solana devnet

~/websites/dexter-facilitator/  # Facilitator repo
  src/mpp.ts                    # /mpp/prepare and /mpp/settle endpoints
```

## Devnet Testing

```bash
cd ~/websites/dexter-mpp
npm run test:devnet
```

Requires the facilitator running on localhost:4072 with devnet configured. Creates ephemeral buyer and seller keypairs, funds them with devnet USDC, executes a real payment, and verifies on-chain.

## Related Skills

- **x402-implementations** — choosing between x402 and MPP packages
- **x402-protocol** — x402 protocol internals
- **dexter-ecosystem-map** — how Dexter services communicate
