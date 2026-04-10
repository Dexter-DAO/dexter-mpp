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

**Building a seller server that accepts one-shot MPP payments?**
→ `import { charge } from '@dexterai/mpp/server'`

**Building a seller server that accepts streaming session payments?**
→ `import { createSessionServer } from '@dexterai/mpp/server/session'`

**Building an agent/client that pays for MPP resources (one-shot)?**
→ `import { charge } from '@dexterai/mpp/client'`

**Building an agent/client that pays via sessions (streaming)?**
→ `import { createSessionClient } from '@dexterai/mpp/client/session'`

**Need direct access to the settlement API?**
→ `import { DexterSettlementClient } from '@dexterai/mpp/api'`

**Working on the facilitator-side endpoints?**
→ Edit `~/websites/dexter-facilitator/src/mpp.ts`

**Need x402 payments instead of MPP?**
→ Use `@dexterai/x402` — see the **x402-implementations** skill

### Charge vs Sessions — when to use which

| | Charge | Sessions |
|---|---|---|
| **Use when** | Single API calls, infrequent requests | High-frequency requests, streaming, agent orchestration |
| **On-chain txns** | 1 per request | 2 total (open + close) |
| **Latency per request** | Full settlement pipeline | Microseconds (local voucher verification) |
| **Buyer setup** | Wallet + USDC | Swig smart wallet (provisioned via `onboard()`) |

## Architecture

Three actors:

- **Buyer** — has USDC, signs transfer authority. Needs zero SOL.
- **Seller** — runs server with `charge({ recipient })`. Needs zero blockchain infra.
- **Dexter (facilitator)** — co-signs as fee payer, broadcasts, confirms on-chain.

### Charge flow (one-shot)

```
Client → Seller Server → Dexter /mpp/prepare (get feePayer + blockhash)
                       ← 402 Challenge
Client builds + partially signs TransferChecked tx
Client → Seller Server → Dexter /mpp/settle (full settlement pipeline)
                       ← Receipt with tx signature
```

### Session flow (streaming)

```
Buyer Agent → Dexter /api/sessions/onboard       (provision Swig wallet + role)
Buyer Agent → Dexter /mpp/session/open            (create channel, deposit USDC)
  loop:
    Buyer Agent → Dexter /mpp/session/voucher     (get signed voucher, off-chain)
    Buyer Agent → Seller Server + x-mpp-voucher   (seller verifies locally, μs)
Buyer Agent → Dexter /mpp/session/close           (settle to seller, refund buyer)
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

## Session Server Integration

### Accepting session payments

```typescript
import { createSessionServer } from '@dexterai/mpp/server/session';

const sessions = createSessionServer({
  recipient: 'YourSolanaWalletAddress',
  pricePerUnit: '10000', // 0.01 USDC per request
});

app.get('/api/data', async (req, res) => {
  const voucher = req.headers['x-mpp-voucher'];
  if (!voucher) {
    return res.status(402).json(sessions.getChallenge());
  }

  const result = sessions.verifyVoucher(JSON.parse(voucher));
  if (!result.valid) {
    return res.status(402).json({ error: result.error });
  }

  res.json({ data: '...' });
});
```

### Session server parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `recipient` | **yes** | — | Solana wallet that receives payments |
| `pricePerUnit` | **yes** | — | Price per unit in atomic USDC |
| `apiUrl` | no | `https://x402.dexter.cash` | Dexter API URL |
| `network` | no | `mainnet-beta` | Solana network |
| `meter` | no | `request` | Usage label |
| `suggestedDeposit` | no | 100x pricePerUnit | Suggested deposit for buyers |

### Voucher verification details

`verifyVoucher()` returns `{ valid, error?, voucher?, amountPaid? }`:
- Checks Ed25519 signature type
- Validates recipient matches
- Enforces monotonic cumulative amounts (rejects replay/rollback)
- Enforces monotonic sequence numbers
- Detects signer changes mid-session
- Checks payment amount covers pricePerUnit x units

## Session Client Integration

### Full lifecycle: onboard → open → pay → close

```typescript
import { createSessionClient } from '@dexterai/mpp/client/session';

const session = createSessionClient({
  buyerWallet: 'YourWallet...',
  buyerSwigAddress: 'YourSwigWallet...',
});

// Onboard: provision Swig wallet (only needed once per buyer)
// Requires both transaction signing and message signing (for wallet ownership proof)
await session.onboard({
  signTransaction: async (txBase64) => {
    // Sign with your preferred library
    return signedTxBase64;
  },
  signMessage: async (message) => {
    // Sign raw message bytes (CAIP-122 / SIWS wallet ownership proof)
    return signatureBytes;
  },
  publicKey: 'YourPublicKeyBase58...',
});
// Or with @solana/kit v2 (handles both automatically):
// await session.onboard({ signer: await generateKeyPair() });

// Open session
const channel = await session.open({
  seller: 'SellerWallet...',
  deposit: '1000000', // 1 USDC
});

// Pay per request
for (const item of workload) {
  const voucher = await session.pay(channel.channel_id, {
    amount: String(cumulative),
    serverNonce: nonceFromSeller,
  });
  const res = await fetch(sellerUrl, {
    headers: { 'x-mpp-voucher': JSON.stringify(voucher) },
  });
}

// Close — settle and refund
const result = await session.close(channel.channel_id);
```

### Session client parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `buyerWallet` | **yes** | — | Buyer's Solana wallet address |
| `buyerSwigAddress` | **yes** | — | Buyer's Swig smart wallet address |
| `apiUrl` | no | `https://x402.dexter.cash` | Dexter API URL |
| `network` | no | `mainnet-beta` | Solana network |
| `onProgress` | no | — | Lifecycle events: `opening`, `opened`, `voucher`, `closing`, `closed` |

### Onboard options

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `signer` | one of | — | `@solana/kit` CryptoKeyPair (preferred — handles tx + message signing) |
| `signTransaction` | one of | — | Callback: base64 in → signed base64 out (for onboard transactions) |
| `signMessage` | with callbacks | — | Callback: Uint8Array in → Uint8Array out (for SIWS wallet ownership proof) |
| `publicKey` | with callbacks | — | Buyer's public key (base58) — required with signMessage |
| `spendLimit` | no | 100 USDC | USDC spend limit in atomic units |
| `ttlSeconds` | no | 24 hours | Role time-to-live |

The onboard endpoint requires CAIP-122 (SIWS) wallet ownership proof. The SDK constructs and sends this automatically. With `signer`, both transaction and message signing are handled. With callbacks, you must provide all three: `signTransaction`, `signMessage`, and `publicKey`.

## Settlement API

Open endpoints on the facilitator. No auth required.

### Charge Endpoints

#### POST /mpp/prepare

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

#### POST /mpp/settle

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

### Session Endpoints

#### POST /mpp/session/open

Open a payment channel.

**Request:**
```json
{
  "buyer_wallet": "BuyerWallet...",
  "buyer_swig_address": "SwigWallet...",
  "seller_wallet": "SellerWallet...",
  "deposit_atomic": "1000000",
  "network": "mainnet-beta"
}
```

**Response:**
```json
{
  "success": true,
  "channel_id": "ch_abc123",
  "session_pubkey": "SessionKey...",
  "deposit_atomic": "1000000",
  "network": "mainnet-beta",
  "channel_program": "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB"
}
```

#### POST /mpp/session/voucher

Sign a voucher for a payment within an active channel.

**Request:**
```json
{
  "channel_id": "ch_abc123",
  "amount": "10000",
  "meter": "request",
  "units": "1",
  "serverNonce": "uuid-from-seller"
}
```

**Response:**
```json
{
  "success": true,
  "voucher": {
    "channelId": "ch_abc123",
    "payer": "BuyerWallet",
    "recipient": "SellerWallet",
    "cumulativeAmount": "10000",
    "sequence": 1,
    "meter": "request",
    "units": "1",
    "serverNonce": "uuid-from-seller",
    "chainId": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "channelProgram": "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB"
  },
  "signature": "ed25519-signature-base64",
  "signer": "SessionPubkey...",
  "signatureType": "ed25519"
}
```

#### POST /mpp/session/close

Close a channel — settle to seller, refund remainder.

**Request:** `{ "channel_id": "ch_abc123" }`

**Response:**
```json
{
  "success": true,
  "channel_id": "ch_abc123",
  "settlement": {
    "seller": "SellerWallet",
    "amount_settled": "50000",
    "buyer_refund": "950000",
    "voucher_count": 5,
    "session_duration_seconds": 120
  }
}
```

#### POST /api/sessions/onboard

Provision a Swig smart wallet and grant a delegated session role.

**Requires:** `SIGN-IN-WITH-X` header (CAIP-122 / SIWS wallet ownership proof). The SDK constructs this automatically in `onboard()`.

**Request:** `{ "buyer_wallet": "BuyerWallet...", "spend_limit_atomic": "100000000", "ttl_seconds": 86400 }`

**Response (ready):** `{ "status": "ready", "swig_address": "...", "role_id": 42 }`

**Response (needs transactions):**
```json
{
  "status": "transactions_required",
  "swig_address": "...",
  "transactions": [
    { "type": "create_swig", "tx": "base64..." },
    { "type": "grant_role", "tx": "base64..." }
  ]
}
```

#### POST /api/sessions/onboard/confirm

Submit signed onboarding transactions.

**Request:** `{ "buyer_wallet": "...", "signed_transactions": ["base64...", "base64..."] }`

#### GET /api/sessions/onboard/status?buyer_wallet=...

Check onboarding status: `not_onboarded`, `pending`, `active`, `expired`, `revoked`.

**Requires:** `SIGN-IN-WITH-X` header.

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
    server/session.ts           # createSessionServer — accept streaming session payments
    client/charge.ts            # Method.toClient — builds TransferChecked txs
    client/session.ts           # createSessionClient — open/pay/close lifecycle + onboard
    api.ts                      # DexterSettlementClient + SettlementError + session types
    constants.ts                # USDC mints, token programs
    index.ts                    # Barrel export for root import
  examples/
    server-express/             # Express seller with 3 price tiers
    server-hono/                # Hono seller (zero adapter needed)
    client-headless/            # Agent client with progress events
    client-with-verification/   # Seller with on-chain RPC verification
  test/
    api.test.ts                 # DexterSettlementClient charge methods
    api-session.test.ts         # DexterSettlementClient session methods
    server-charge.test.ts       # Server charge method
    server-session.test.ts      # Session server (voucher verification, monotonic enforcement)
    client-session.test.ts      # Session client (lifecycle, onboarding, progress events)
    methods.test.ts             # Method schema definitions
    e2e.test.ts                 # E2E mock Dexter server
    devnet-e2e.ts               # Real payment on Solana devnet

~/websites/dexter-facilitator/  # Facilitator repo
  src/mpp.ts                    # /mpp/prepare, /mpp/settle, /mpp/session/* endpoints
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
