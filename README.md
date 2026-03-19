<p align="center">
  <img src="https://raw.githubusercontent.com/Dexter-DAO/dexter-x402-sdk/main/assets/dexter-wordmark.svg" alt="Dexter" width="360">
</p>

<h1 align="center">@dexterai/mpp</h1>

<p align="center">
  <strong>Managed Solana settlement for the Machine Payments Protocol. Accept MPP payments without running blockchain infrastructure.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dexterai/mpp"><img src="https://img.shields.io/npm/v/@dexterai/mpp.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18.7-brightgreen.svg" alt="Node"></a>
  <a href="https://mpp.dev"><img src="https://img.shields.io/badge/MPP-mpp.dev-blue" alt="MPP"></a>
  <a href="https://x402.dexter.cash"><img src="https://img.shields.io/badge/Settlement-x402.dexter.cash-blueviolet" alt="Settlement API"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License"></a>
</p>

---

## What This Is

An [MPP](https://mpp.dev) payment method that lets any seller accept Solana USDC payments through the Machine Payments Protocol — with Dexter handling all settlement infrastructure.

Sellers install this package and get:
- **Zero blockchain operations.** No RPC connections, no fee payer wallets, no SOL for gas. Dexter handles co-signing, simulation, broadcast, and confirmation.
- **Gas-free for buyers.** Dexter sponsors all transaction fees. Buyers only need USDC and a Solana wallet.
- **Production-grade settlement.** The same security validation, backpressure controls, and smart wallet support that powers 50% of daily x402 transactions — now available as an MPP method.
- **Standard MPP protocol.** Works with any `mppx` client. Supports HTTP and MCP transports.

The method name is `dexter`. Clients that support custom MPP methods will discover and use it automatically.

---

## Quick Start

### Install

```bash
npm install @dexterai/mpp
```

Peer dependencies: `mppx`, `@solana/kit`, `@solana-program/token`, `@solana-program/compute-budget`

### Server

Add Solana payments to any endpoint in a few lines:

```typescript
import { Mppx } from 'mppx/server';
import { charge } from '@dexterai/mpp/server';

const mppx = Mppx.create({
  methods: [
    charge({
      recipient: 'YourSolanaWalletAddress...',
    }),
  ],
});

export async function handler(request: Request) {
  const result = await mppx.charge({
    amount: '10000',    // 0.01 USDC (6 decimals)
    currency: 'USDC',
  })(request);

  if (result.status === 402) return result.challenge;
  return result.withReceipt(Response.json({ data: 'premium content' }));
}
```

That's it. No RPC URL, no private keys, no SOL balance. Dexter's settlement API handles everything.

### Client

```typescript
import { Mppx } from 'mppx/client';
import { charge } from '@dexterai/mpp/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';

const signer = await createKeyPairSignerFromBytes(yourKeypairBytes);

Mppx.create({
  methods: [charge({ signer })],
});

// 402 responses are handled automatically.
const response = await fetch('https://api.example.com/paid-endpoint');
```

The client reads the fee payer and blockhash from the challenge — no RPC access needed.

---

## How It Works

```
Client                    Seller Server              Dexter Settlement API      Solana
  │                           │                             │                     │
  │  GET /resource            │                             │                     │
  │──────────────────────────>│  POST /mpp/prepare          │                     │
  │                           │────────────────────────────>│                     │
  │                           │  { feePayer, blockhash }    │                     │
  │                           │<────────────────────────────│                     │
  │  402 + Challenge          │                             │                     │
  │<──────────────────────────│                             │                     │
  │                           │                             │                     │
  │  Build + sign tx          │                             │                     │
  │                           │                             │                     │
  │  GET /resource + cred     │                             │                     │
  │──────────────────────────>│  POST /mpp/settle           │                     │
  │                           │────────────────────────────>│  validate           │
  │                           │                             │  co-sign            │
  │                           │                             │  simulate ─────────>│
  │                           │                             │  broadcast ────────>│
  │                           │                             │  confirm <──────────│
  │                           │  { success, signature }     │                     │
  │                           │<────────────────────────────│                     │
  │  200 + Receipt + content  │                             │                     │
  │<──────────────────────────│                             │                     │
```

1. Seller server calls Dexter's `/mpp/prepare` to get the fee payer public key and a fresh blockhash
2. MPP sends a 402 challenge to the client with these details
3. Client builds a `TransferChecked` transaction, sets Dexter as fee payer, partially signs
4. Seller server forwards the signed transaction to Dexter's `/mpp/settle`
5. Dexter validates (program allowlist, compute caps, fee payer isolation), co-signs, simulates, broadcasts, confirms, and verifies on-chain
6. Seller server returns the content with an MPP receipt

---

## Prerequisites

**Recipients must have an existing USDC token account (ATA).** Dexter's security policy does not allow transaction-time ATA creation — this prevents a class of rent-drain attacks on the fee payer. In practice, any wallet that has ever held USDC already has an ATA. If the recipient's ATA doesn't exist, the settlement will fail with a clear simulation error.

Buyers need only USDC. No SOL required — Dexter sponsors all transaction fees.

---

## Server Options

```typescript
charge({
  recipient: string;       // Required. Solana wallet to receive payments.
  apiUrl?: string;         // Dexter API URL. Default: https://x402.dexter.cash
  network?: string;        // Solana network. Default: mainnet-beta
  splToken?: string;       // SPL token mint. Default: USDC
  decimals?: number;       // Token decimals. Default: 6
})
```

### Devnet

```typescript
charge({
  recipient: 'YourDevnetWallet...',
  network: 'devnet',
})
```

### Custom Dexter Instance

```typescript
charge({
  recipient: 'YourWallet...',
  apiUrl: 'http://localhost:4072',
})
```

---

## Client Options

```typescript
charge({
  signer: TransactionSigner;   // Required. Any @solana/kit TransactionSigner.
  computeUnitPrice?: bigint;   // Priority fee in micro-lamports. Default: 1
  computeUnitLimit?: number;   // Compute unit limit. Default: 50,000
  onProgress?: (event) => void // Optional. Called at each step of the payment flow.
})
```

The `onProgress` callback receives events as the transaction is built and signed: `{ type: "building" }`, `{ type: "signing" }`, `{ type: "signed", transaction }`.

Works with:
- `createKeyPairSignerFromBytes()` from `@solana/kit` for headless agents
- ConnectorKit's `useTransactionSigner()` for browser wallets
- Any `TransactionSigner` implementation

---

## Package Exports

```typescript
// Shared schema (method name, intent, Zod schemas)
import { charge } from '@dexterai/mpp';

// Server method (delegates settlement to Dexter API)
import { charge } from '@dexterai/mpp/server';

// Client method (builds + signs Solana transactions)
import { charge } from '@dexterai/mpp/client';

// HTTP client and types (for direct API access)
import { DexterSettlementClient, SettlementError } from '@dexterai/mpp/api';

// Constants (USDC mints, token programs, default API URL)
import { USDC_MINTS, TOKEN_PROGRAM, DEFAULT_DEXTER_API_URL } from '@dexterai/mpp/constants';
```

---

## Dexter Settlement API

The settlement endpoints are open — no API keys, no accounts. Backpressure is tracked per recipient wallet address.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mpp/prepare` | Returns fee payer pubkey, recent blockhash, lastValidBlockHeight, and token config |
| POST | `/mpp/settle` | Full settlement: validate, co-sign, simulate, broadcast, confirm |

Settlement errors include typed error codes (e.g., `policy:program_not_allowed`, `no_transfer_instruction`, backpressure codes). The `SettlementError` class from `@dexterai/mpp/api` preserves these for programmatic handling.

Production: **https://x402.dexter.cash/mpp/**

These endpoints run on the same infrastructure as Dexter's x402 facilitator — the same security validation, backpressure controls, and Sentry observability.

---

## Why Not Run Settlement Yourself?

The [Solana MPP SDK](https://github.com/solana-foundation/solana-mpp-sdk) lets you embed settlement directly in your server. That works, but it means you operate:

- Solana RPC connections and failover
- A fee payer wallet funded with SOL
- Transaction simulation and retry logic
- Blockhash management and expiry handling
- Key security for the signing wallet
- Fee payer balance monitoring

`@dexterai/mpp` delegates all of that to Dexter. You install a package and set your recipient address.

---

## Troubleshooting

| Error code | Cause | Fix |
|---|---|---|
| `policy:program_not_allowed` | Transaction contains a program not in the facilitator's allowlist (e.g., ATA creation, System program) | Remove non-standard instructions. Only ComputeBudget, SPL Token, Token-2022, Lighthouse, and Memo are allowed. |
| `no_transfer_instruction` | Transaction has no `TransferChecked` instruction | The transaction must contain a USDC `TransferChecked`. Check your client is building the payment correctly. |
| `policy:fee_payer_not_isolated` | Fee payer address appears in an instruction's accounts | The fee payer can only sign for gas — it must not be referenced in any instruction. This prevents rent drain attacks. |
| `invalid_transaction_encoding` | The base64 transaction couldn't be deserialized | Verify the client is sending a valid base64-encoded Solana VersionedTransaction. |
| `settlement_recipient_mismatch` | Facilitator settled to a different address than the challenge specified | This indicates a facilitator bug. Contact Dexter support. |
| `settlement_amount_mismatch` | Facilitator settled a different amount than the challenge specified | Same as above — facilitator-side issue. |
| `global_settle_cap_exceeded` | Too many settlements globally — backpressure triggered | Wait and retry. The facilitator rate-limits to protect fee payer balance. |
| `seller_settle_cap_exceeded` | Too many settlements for this recipient — backpressure triggered | Your endpoint is receiving high traffic. Contact Dexter about tier upgrades. |
| Timeout after 10s on prepare | Facilitator unreachable or slow | Check that the facilitator is running and the `apiUrl` is correct. Default: `https://x402.dexter.cash` |
| Timeout after 30s on settle | Settlement took too long (Solana congestion, RPC issues) | Retry. If persistent, check Solana network status. |
| Simulation failure | The transaction would fail on-chain (insufficient USDC, ATA doesn't exist, etc.) | Verify the buyer has USDC and the recipient has a USDC token account (ATA). |

---

## Security Model

Dexter managed settlement is a trust-delegated model — similar to using Stripe for card payments. The seller trusts Dexter to settle payments correctly.

Two verification layers protect against facilitator bugs:

1. **Settlement proof (default):** Every successful settlement response includes the verified `recipient`, `amount`, `asset`, and `feePayer`. The SDK checks these match the original challenge before issuing a receipt.

2. **On-chain verification (opt-in):** Pass `verifyRpcUrl` to independently fetch and verify the transaction on-chain after settlement. Adds ~1-2s latency but is fully trustless.

The settlement API is HTTPS in production (`https://x402.dexter.cash`). In local development over HTTP, ensure your network is trusted.

---

## Development

```bash
npm install
npm run build        # Compile to dist/
npm run typecheck    # TypeScript checks
npm test             # Unit tests
npm run test:devnet  # Real payment on Solana devnet (requires facilitator running)
```

The devnet test exercises the complete flow with real on-chain transactions: ephemeral buyer and seller keypairs, real USDC transfers, full settlement through the live facilitator, and on-chain verification that the correct amount moved to the correct recipient with the correct fee payer.

---

## Related

- [dexter-facilitator](https://github.com/Dexter-DAO/dexter-facilitator) — Settlement API and x402 facilitator
- [@dexterai/x402](https://github.com/Dexter-DAO/dexter-x402-sdk) — Full-stack x402 SDK
- [MPP Protocol](https://mpp.dev) — Machine Payments Protocol specification
- [Solana MPP SDK](https://github.com/solana-foundation/solana-mpp-sdk) — Self-hosted Solana MPP (if you prefer to run your own settlement)

---

## License

MIT — see [LICENSE](./LICENSE)

---

<p align="center">
  <a href="https://x402.dexter.cash">Dexter Settlement API</a> ·
  <a href="https://mpp.dev">MPP Protocol</a> ·
  <a href="https://dexter.cash">Dexter</a>
</p>
