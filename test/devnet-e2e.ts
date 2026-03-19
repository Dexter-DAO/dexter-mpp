/**
 * Devnet end-to-end integration test for @dexterai/mpp.
 *
 * Exercises the complete MPP payment flow against the live Dexter facilitator
 * on Solana devnet with real on-chain transactions. Three distinct keypairs:
 *
 *   Buyer     — ephemeral, generated fresh, funded with SOL airdrop + USDC transfer
 *   Seller    — ephemeral, generated fresh, receives the USDC payment
 *   Fee payer — the facilitator's devnet key, only co-signs for gas sponsorship
 *
 * Prerequisites:
 *   - dexter-facilitator running on localhost:4072 with devnet configured
 *   - ../dexter-facilitator/.env contains SOLANA_DEVNET_PRIVATE_KEY
 *
 * Run: npm run test:devnet
 */

import { config as loadEnv } from "dotenv";
import path from "node:path";
import http from "node:http";
import express from "express";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  type KeyPairSigner,
} from "@solana/kit";
import bs58 from "bs58";

const DEVNET_RPC = "https://api.devnet.solana.com";
const FACILITATOR_URL = "http://localhost:4072";
const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PAYMENT_AMOUNT = 10_000; // 0.01 USDC

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`  [e2e] ${msg}`);
}

function fail(msg: string): never {
  console.error(`  [e2e] FAIL: ${msg}`);
  process.exit(1);
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) fail(msg);
}


async function transferUsdc(
  connection: Connection,
  fromKeypair: Keypair,
  toPublicKey: PublicKey,
  amount: number,
) {
  const fromAta = await getAssociatedTokenAddress(DEVNET_USDC_MINT, fromKeypair.publicKey);
  const toAta = await getAssociatedTokenAddress(DEVNET_USDC_MINT, toPublicKey);

  const instructions: TransactionInstruction[] = [];

  try {
    await getAccount(connection, toAta);
  } catch {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        fromKeypair.publicKey,
        toAta,
        toPublicKey,
        DEVNET_USDC_MINT,
      ),
    );
  }

  instructions.push(
    createTransferCheckedInstruction(
      fromAta,
      DEVNET_USDC_MINT,
      toAta,
      fromKeypair.publicKey,
      amount,
      6,
    ),
  );

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: fromKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([fromKeypair]);

  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function getUsdcBalance(connection: Connection, owner: PublicKey): Promise<number> {
  try {
    const ata = await getAssociatedTokenAddress(DEVNET_USDC_MINT, owner);
    const account = await getAccount(connection, ata);
    return Number(account.amount);
  } catch {
    return 0;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  @dexterai/mpp — Devnet End-to-End Test\n");

  // Load facilitator's devnet private key
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  loadEnv({ path: path.resolve(thisDir, "../../dexter-facilitator/.env") });
  const devnetKeyBase58 = process.env.SOLANA_DEVNET_PRIVATE_KEY;
  assert(devnetKeyBase58, "SOLANA_DEVNET_PRIVATE_KEY not found in ../dexter-facilitator/.env");

  const connection = new Connection(DEVNET_RPC, "confirmed");
  const funderKeypair = Keypair.fromSecretKey(bs58.decode(devnetKeyBase58));
  log(`Fee payer / funder: ${funderKeypair.publicKey.toBase58()}`);

  // Verify facilitator is running with devnet
  const prepareRes = await fetch(`${FACILITATOR_URL}/mpp/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ network: "devnet" }),
  });
  assert(prepareRes.ok, `Facilitator /mpp/prepare failed: ${prepareRes.status}`);
  const prepareData = await prepareRes.json() as { feePayer: string; network: string };
  assert(prepareData.network === "devnet", `Facilitator not on devnet: ${prepareData.network}`);
  log(`Facilitator devnet ready, fee payer: ${prepareData.feePayer}`);

  // ── Step 1: Generate ephemeral buyer and seller ───────────────────────

  const buyerSigner = await generateKeyPairSigner();
  const sellerSigner = await generateKeyPairSigner();

  const buyerLegacyPubkey = new PublicKey(buyerSigner.address);
  const sellerLegacyPubkey = new PublicKey(sellerSigner.address);

  log(`Buyer:  ${buyerSigner.address} (ephemeral)`);
  log(`Seller: ${sellerSigner.address} (ephemeral)`);

  // ── Step 2: Fund buyer and seller with USDC ────────────────────────────
  // Both wallets get real USDC transfers to establish ATAs — mirrors production
  // where both parties are existing USDC holders. Buyer needs zero SOL;
  // Dexter sponsors all gas during the actual payment.

  log("Transferring 0.1 USDC to buyer...");
  const buyerFundSig = await transferUsdc(connection, funderKeypair, buyerLegacyPubkey, 100_000);
  log(`Buyer fund tx: ${buyerFundSig}`);
  const buyerUsdc = await getUsdcBalance(connection, buyerLegacyPubkey);
  assert(buyerUsdc >= PAYMENT_AMOUNT, `Buyer USDC balance too low: ${buyerUsdc}`);
  log(`Buyer USDC balance: ${(buyerUsdc / 1e6).toFixed(6)}`);

  log("Transferring 0.000001 USDC to seller (establishes ATA like a real seller)...");
  const sellerFundSig = await transferUsdc(connection, funderKeypair, sellerLegacyPubkey, 1);
  log(`Seller fund tx: ${sellerFundSig}`);

  const sellerUsdcBefore = await getUsdcBalance(connection, sellerLegacyPubkey);
  assert(sellerUsdcBefore > 0, "Seller ATA not created");
  log(`Seller USDC balance before payment: ${(sellerUsdcBefore / 1e6).toFixed(6)}`);

  // ── Step 3: Start seller server with @dexterai/mpp ────────────────────

  const { Mppx } = await import("mppx/server");
  const { charge } = await import("../src/server/charge.js");

  const sellerSecretKey = (crypto as any).randomBytes
    ? (await import("node:crypto")).randomBytes(32).toString("hex")
    : Math.random().toString(36).repeat(3);

  const mppx = Mppx.create({
    secretKey: sellerSecretKey,
    methods: [
      charge({
        recipient: sellerSigner.address,
        apiUrl: FACILITATOR_URL,
        network: "devnet",
      }),
    ],
  });

  const app = express();
  app.use(express.json());

  app.get("/paid", async (req, res) => {
    const webReq = new Request(`http://localhost${req.originalUrl}`, {
      method: req.method,
      headers: new Headers(req.headers as Record<string, string>),
    });

    const result = await (mppx as any).charge({
      amount: String(PAYMENT_AMOUNT),
      currency: "USDC",
      description: "Devnet E2E test payment",
    })(webReq);

    if (result.status === 402) {
      const challenge = result.challenge as Response;
      for (const [key, value] of challenge.headers) {
        res.setHeader(key, value);
      }
      res.status(challenge.status).send(await challenge.text());
      return;
    }

    const response = result.withReceipt(
      Response.json({ paid: true, data: "premium devnet content" }),
    ) as Response;
    for (const [key, value] of response.headers) {
      res.setHeader(key, value);
    }
    res.status(response.status).send(await response.text());
  });

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  log(`Seller server running on port ${port}`);

  // ── Step 4: Make MPP payment as buyer ─────────────────────────────────

  try {
    const { Mppx: ClientMppx } = await import("mppx/client");
    const { charge: clientCharge } = await import("../src/client/charge.js");

    log("Creating MPP client with buyer signer...");
    const progressEvents: string[] = [];
    const clientMethod = clientCharge({
      signer: buyerSigner,
      onProgress: (event) => {
        progressEvents.push(event.type);
        log(`  client progress: ${event.type}`);
      },
    });

    const clientMppx = ClientMppx.create({
      methods: [clientMethod],
      polyfill: false,
    });

    log("Making paid request to seller...");
    const response = await clientMppx.fetch(`http://localhost:${port}/paid`);

    // ── Step 5: Verify everything ─────────────────────────────────────────

    log(`Response status: ${response.status}`);
    assert(response.status === 200, `Expected 200, got ${response.status}`);

    const body = await response.json();
    assert(body.paid === true, `Response body missing paid:true — got: ${JSON.stringify(body)}`);
    log("Response body: OK");

    const receiptHeader = response.headers.get("payment-receipt");
    assert(receiptHeader, "Missing payment-receipt header");
    log("Payment-Receipt header: present");

    const { Receipt } = await import("mppx");
    const receipt = Receipt.deserialize(receiptHeader);
    assert(receipt, "Failed to deserialize receipt");
    assert(receipt.method === "dexter", `Receipt method: ${receipt.method}, expected "dexter"`);
    assert(receipt.status === "success", `Receipt status: ${receipt.status}, expected "success"`);
    assert(receipt.reference && receipt.reference.length > 20, `Receipt reference too short: ${receipt.reference}`);
    log(`Receipt: method=${receipt.method} status=${receipt.status} ref=${receipt.reference.slice(0, 20)}...`);

    assert(progressEvents.includes("building"), "Missing 'building' progress event");
    assert(progressEvents.includes("signing"), "Missing 'signing' progress event");
    assert(progressEvents.includes("signed"), "Missing 'signed' progress event");
    log(`Progress events: ${progressEvents.join(" → ")}`);

    // On-chain verification
    const txSig = receipt.reference;
    log(`Verifying on-chain transaction: ${txSig}`);

    await new Promise((r) => setTimeout(r, 2000));

    const txInfo = await connection.getTransaction(txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert(txInfo, `Transaction not found on-chain: ${txSig}`);
    assert(!txInfo.meta?.err, `Transaction failed on-chain: ${JSON.stringify(txInfo.meta?.err)}`);
    log("On-chain: transaction confirmed, no errors");

    const accountKeys = txInfo.transaction.message.getAccountKeys().staticAccountKeys;
    const feePayer = accountKeys[0].toBase58();
    assert(
      feePayer === prepareData.feePayer,
      `Fee payer mismatch: ${feePayer} !== ${prepareData.feePayer}`,
    );
    log(`On-chain: fee payer is facilitator (${feePayer.slice(0, 8)}...) — not buyer or seller`);

    assert(
      feePayer !== buyerSigner.address,
      "Fee payer is the buyer — this should not happen",
    );
    assert(
      feePayer !== sellerSigner.address,
      "Fee payer is the seller — this should not happen",
    );

    // Verify USDC balance changed
    await new Promise((r) => setTimeout(r, 1000));
    const sellerUsdcAfter = await getUsdcBalance(connection, sellerLegacyPubkey);
    log(`Seller USDC balance after: ${(sellerUsdcAfter / 1e6).toFixed(6)}`);
    assert(
      sellerUsdcAfter >= sellerUsdcBefore + PAYMENT_AMOUNT,
      `Seller USDC didn't increase: before=${sellerUsdcBefore} after=${sellerUsdcAfter} expected+=${PAYMENT_AMOUNT}`,
    );
    log(`Seller received ${((sellerUsdcAfter - sellerUsdcBefore) / 1e6).toFixed(6)} USDC`);

    console.log("\n  ALL CHECKS PASSED\n");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("\n  [e2e] FATAL:", err);
  process.exit(1);
});
