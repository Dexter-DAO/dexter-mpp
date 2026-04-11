# Examples

Six examples demonstrating different integration patterns for `@dexterai/mpp`.

## server-express

Express server with three paid endpoints at different price points. The standard integration pattern for most sellers. No blockchain infrastructure needed.

```bash
cd server-express
RECIPIENT=YourSolanaWallet npx tsx server.ts
```

## server-hono

Same concept using Hono — MPP's reference framework. Demonstrates that Hono's native Web API Request/Response model needs no adapter for `mppx`.

```bash
cd server-hono
RECIPIENT=YourSolanaWallet npx tsx server.ts
```

## client-headless

Headless agent client that pays for resources automatically. No browser, no wallet UI. Uses a Solana keypair directly. The client needs zero SOL — only USDC.

```bash
cd client-headless
SOLANA_PRIVATE_KEY=base58... SERVER_URL=http://localhost:3000 npx tsx client.ts
```

## client-with-verification

Seller server with independent on-chain verification. After every settlement, the server fetches the transaction from its own RPC and verifies the `TransferChecked` instruction matches. For high-value endpoints where trustless verification matters.

```bash
cd client-with-verification
RECIPIENT=YourWallet SOLANA_RPC_URL=https://api.mainnet-beta.solana.com npx tsx client.ts
```

## server-session

Express server accepting session-based streaming payments. Two endpoints with different metering models: per-request data lookups and per-token streaming. Sellers verify vouchers locally with Ed25519 signature checks — no blockchain calls, microsecond latency.

```bash
cd server-session
RECIPIENT=YourSolanaWallet npx tsx server.ts
```

## client-session

Buyer agent running the full session lifecycle: onboard (provision Swig wallet), open a session, make multiple paid requests with vouchers, close and settle. Only two on-chain transactions for the entire session regardless of how many requests are made.

```bash
cd client-session
SOLANA_PRIVATE_KEY=base58... SERVER_URL=http://localhost:3000 npx tsx client.ts
```

## Running the Charge Examples Together

Terminal 1 — start the seller:
```bash
cd server-express
RECIPIENT=YourSolanaWallet NETWORK=devnet DEXTER_API_URL=http://localhost:4072 npx tsx server.ts
```

Terminal 2 — run the client:
```bash
cd client-headless
SOLANA_PRIVATE_KEY=base58... SERVER_URL=http://localhost:3000 npx tsx client.ts
```

The client will make three paid requests, each settled on-chain via Dexter's facilitator.

## Running the Session Examples Together

Terminal 1 — start the session seller:
```bash
cd server-session
RECIPIENT=YourSolanaWallet npx tsx server.ts
```

Terminal 2 — run the session client:
```bash
cd client-session
SOLANA_PRIVATE_KEY=base58... SERVER_URL=http://localhost:3000 npx tsx client.ts
```

The client will onboard (once), open a session, make five paid requests with vouchers (off-chain, microseconds each), then close the session. Only two on-chain transactions for all five requests.
