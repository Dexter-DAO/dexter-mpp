import { describe, it, expect } from "vitest";
import { createSessionServer } from "../src/server/session.js";
import type { SessionVoucherResponse } from "../src/api.js";
import nacl from "tweetnacl";

// ── Real Ed25519 signing for tests ──────────────────────────────────────

const BS58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const b of bytes) num = num * 256n + BigInt(b);
  let encoded = "";
  while (num > 0n) { encoded = BS58_CHARS[Number(num % 58n)] + encoded; num /= 58n; }
  for (const b of bytes) { if (b !== 0) break; encoded = "1" + encoded; }
  return encoded || "1";
}

const DOMAIN_SEPARATOR = "solana-mpp-session-voucher-v1:";

function canonicalize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== undefined) sorted[key] = canonicalize(val);
  }
  return sorted;
}

// Deterministic test keypair
const TEST_KEYPAIR = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
const TEST_SIGNER = encodeBase58(TEST_KEYPAIR.publicKey);

function signVoucher(voucher: SessionVoucherResponse["voucher"]): string {
  const canonical = canonicalize(voucher);
  const message = DOMAIN_SEPARATOR + JSON.stringify(canonical);
  const messageBytes = new TextEncoder().encode(message);
  const sig = nacl.sign.detached(messageBytes, TEST_KEYPAIR.secretKey);
  return btoa(String.fromCharCode(...sig));
}

// ── Helper to build a signed voucher response ───────────────────────────

const RECIPIENT = "SellerWallet1111111111111111111111111111111111";

function makeVoucher(overrides: Partial<{
  channelId: string;
  recipient: string;
  cumulativeAmount: string;
  sequence: number;
  signer: string;
  units: string;
}>): SessionVoucherResponse {
  const voucher = {
    channelId: overrides.channelId ?? "ch_test",
    payer: "BuyerWallet",
    recipient: overrides.recipient ?? RECIPIENT,
    cumulativeAmount: overrides.cumulativeAmount ?? "10000",
    sequence: overrides.sequence ?? 1,
    meter: "request",
    units: overrides.units ?? "1",
    serverNonce: "nonce-123",
    chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    channelProgram: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
  };

  const useSigner = overrides.signer ?? TEST_SIGNER;
  // If using a custom signer (not our test key), signature will be invalid
  // — this is intentional for tests that check signer_changed_mid_session
  const signature = useSigner === TEST_SIGNER ? signVoucher(voucher) : "invalid-sig";

  return {
    success: true,
    voucher,
    signature,
    signer: useSigner,
    signatureType: "ed25519",
  };
}

// ── Validation ────────────────────────────────────────────────────────────

describe("createSessionServer — validation", () => {
  it("throws on missing recipient", () => {
    expect(() =>
      createSessionServer({ recipient: "", pricePerUnit: "10000" }),
    ).toThrow("non-empty 'recipient'");
  });

  it("throws on whitespace-only recipient", () => {
    expect(() =>
      createSessionServer({ recipient: "   ", pricePerUnit: "10000" }),
    ).toThrow("non-empty 'recipient'");
  });

  it("throws on missing pricePerUnit", () => {
    expect(() =>
      createSessionServer({ recipient: "Wallet", pricePerUnit: "" as any }),
    ).toThrow("'pricePerUnit'");
  });

  it("throws on non-string pricePerUnit", () => {
    expect(() =>
      createSessionServer({ recipient: "Wallet", pricePerUnit: 10000 as any }),
    ).toThrow("'pricePerUnit'");
  });
});

// ── getChallenge ──────────────────────────────────────────────────────────

describe("createSessionServer — getChallenge", () => {
  it("returns challenge with correct fields", () => {
    const server = createSessionServer({
      recipient: RECIPIENT,
      pricePerUnit: "10000",
    });

    const challenge = server.getChallenge();

    expect(challenge.type).toBe("mpp-session");
    expect(challenge.recipient).toBe(RECIPIENT);
    expect(challenge.pricePerUnit).toBe("10000");
    expect(challenge.network).toBe("mainnet-beta");
    expect(challenge.meter).toBe("request");
    expect(challenge.channelProgram).toBe("swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB");
  });

  it("computes default suggestedDeposit as 100x pricePerUnit", () => {
    const server = createSessionServer({
      recipient: "Wallet",
      pricePerUnit: "10000",
    });

    expect(server.getChallenge().suggestedDeposit).toBe("1000000");
  });

  it("uses custom suggestedDeposit when provided", () => {
    const server = createSessionServer({
      recipient: "Wallet",
      pricePerUnit: "10000",
      suggestedDeposit: "5000000",
    });

    expect(server.getChallenge().suggestedDeposit).toBe("5000000");
  });

  it("uses custom meter when provided", () => {
    const server = createSessionServer({
      recipient: "Wallet",
      pricePerUnit: "500",
      meter: "tokens",
    });

    expect(server.getChallenge().meter).toBe("tokens");
  });

  it("uses custom network when provided", () => {
    const server = createSessionServer({
      recipient: "Wallet",
      pricePerUnit: "10000",
      network: "devnet",
    });

    expect(server.getChallenge().network).toBe("devnet");
  });
});

// ── verifyVoucher ─────────────────────────────────────────────────────────

describe("createSessionServer — verifyVoucher", () => {
  function makeServer(pricePerUnit = "10000") {
    return createSessionServer({ recipient: RECIPIENT, pricePerUnit });
  }

  it("accepts a valid first voucher with real Ed25519 signature", () => {
    const server = makeServer();
    const result = server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 }),
    );

    expect(result.valid).toBe(true);
    expect(result.amountPaid).toBe("10000");
    expect(result.voucher).toBeDefined();
    expect(result.voucher!.channelId).toBe("ch_test");
  });

  it("accepts a valid second voucher with increased amount and sequence", () => {
    const server = makeServer();

    server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 }),
    );

    const result = server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "20000", sequence: 2 }),
    );

    expect(result.valid).toBe(true);
    expect(result.amountPaid).toBe("10000"); // delta
  });

  it("rejects voucher with missing fields", () => {
    const server = makeServer();
    const result = server.verifyVoucher({
      success: true,
      voucher: null as any,
      signature: "sig",
      signer: "key",
      signatureType: "ed25519",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe("missing_voucher_fields");
  });

  it("rejects unsupported signature type", () => {
    const server = makeServer();
    const voucher = makeVoucher({ recipient: RECIPIENT });
    voucher.signatureType = "secp256k1" as any;

    const result = server.verifyVoucher(voucher);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("unsupported_signature_type");
  });

  it("rejects voucher with invalid signature", () => {
    const server = makeServer();
    const voucher = makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 });
    voucher.signature = btoa("x".repeat(64)); // wrong signature bytes

    const result = server.verifyVoucher(voucher);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("invalid_signature");
  });

  it("rejects voucher with tampered amount (signature mismatch)", () => {
    const server = makeServer();
    const voucher = makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 });
    // Tamper with the amount after signing
    voucher.voucher.cumulativeAmount = "99999";

    const result = server.verifyVoucher(voucher);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("invalid_signature");
  });

  it("rejects voucher with wrong recipient", () => {
    const server = makeServer();
    // Build a voucher signed for the wrong recipient
    const wrongRecipientVoucher = {
      channelId: "ch_test",
      payer: "BuyerWallet",
      recipient: "WrongRecipient11111111111111111111111111111111",
      cumulativeAmount: "10000",
      sequence: 1,
      meter: "request",
      units: "1",
      serverNonce: "nonce-123",
      chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      channelProgram: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
    };
    const signed: SessionVoucherResponse = {
      success: true,
      voucher: wrongRecipientVoucher,
      signature: signVoucher(wrongRecipientVoucher),
      signer: TEST_SIGNER,
      signatureType: "ed25519",
    };

    const result = server.verifyVoucher(signed);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("recipient_mismatch");
  });

  it("rejects non-monotonic amount (same amount)", () => {
    const server = makeServer();

    server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 }),
    );

    const result = server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 2 }),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("amount_not_monotonic");
  });

  it("rejects non-monotonic amount (decreased amount)", () => {
    const server = makeServer();

    server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "20000", sequence: 1 }),
    );

    const result = server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 2 }),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("amount_not_monotonic");
  });

  it("rejects non-monotonic sequence", () => {
    const server = makeServer();

    server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 5 }),
    );

    const result = server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "20000", sequence: 3 }),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("sequence_not_monotonic");
  });

  it("rejects signer change mid-session", () => {
    const server = makeServer();

    server.verifyVoucher(
      makeVoucher({
        recipient: RECIPIENT,
        cumulativeAmount: "10000",
        sequence: 1,
      }),
    );

    // Second voucher with different signer — signature will be invalid
    // but signer_changed check comes after signature check now,
    // so this will fail on invalid_signature first
    const otherKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(99));
    const otherSigner = encodeBase58(otherKeypair.publicKey);
    const voucher2 = {
      channelId: "ch_test",
      payer: "BuyerWallet",
      recipient: RECIPIENT,
      cumulativeAmount: "20000",
      sequence: 2,
      meter: "request",
      units: "1",
      serverNonce: "nonce-123",
      chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      channelProgram: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
    };
    const canonical2 = canonicalize(voucher2);
    const msg2 = new TextEncoder().encode(DOMAIN_SEPARATOR + JSON.stringify(canonical2));
    const sig2 = nacl.sign.detached(msg2, otherKeypair.secretKey);

    const result = server.verifyVoucher({
      success: true,
      voucher: voucher2,
      signature: btoa(String.fromCharCode(...sig2)),
      signer: otherSigner,
      signatureType: "ed25519",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe("signer_changed_mid_session");
  });

  it("rejects underpayment on first voucher", () => {
    const server = makeServer("10000"); // 0.01 USDC per unit

    const result = server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "5000", sequence: 1 }),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("underpaid");
  });

  it("rejects underpayment on subsequent voucher (delta too small)", () => {
    const server = makeServer("10000");

    server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 }),
    );

    const result = server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "15000", sequence: 2 }),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("underpaid");
  });

  it("accepts overpayment gracefully", () => {
    const server = makeServer("10000");

    const result = server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "50000", sequence: 1 }),
    );

    expect(result.valid).toBe(true);
    expect(result.amountPaid).toBe("50000");
  });

  it("handles multi-unit voucher correctly", () => {
    const server = makeServer("10000");

    const result = server.verifyVoucher(
      makeVoucher({
        recipient: RECIPIENT,
        cumulativeAmount: "30000",
        sequence: 1,
        units: "3",
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.amountPaid).toBe("30000");
  });

  it("rejects multi-unit voucher with insufficient amount", () => {
    const server = makeServer("10000");

    const result = server.verifyVoucher(
      makeVoucher({
        recipient: RECIPIENT,
        cumulativeAmount: "20000",
        sequence: 1,
        units: "3", // needs 30000 but got 20000
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("underpaid");
  });

  it("tracks separate channels independently", () => {
    const server = makeServer();

    const r1 = server.verifyVoucher(
      makeVoucher({ channelId: "ch_A", recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 }),
    );
    expect(r1.valid).toBe(true);

    const r2 = server.verifyVoucher(
      makeVoucher({ channelId: "ch_B", recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 }),
    );
    expect(r2.valid).toBe(true);

    // ch_A second voucher
    const r3 = server.verifyVoucher(
      makeVoucher({ channelId: "ch_A", recipient: RECIPIENT, cumulativeAmount: "20000", sequence: 2 }),
    );
    expect(r3.valid).toBe(true);
    expect(r3.amountPaid).toBe("10000");
  });
});

// ── getSessionContext ─────────────────────────────────────────────────────

describe("createSessionServer — getSessionContext", () => {
  it("returns null for unknown channel", () => {
    const server = createSessionServer({ recipient: RECIPIENT, pricePerUnit: "10000" });
    expect(server.getSessionContext("ch_unknown")).toBeNull();
  });

  it("returns context after voucher verification", () => {
    const server = createSessionServer({ recipient: RECIPIENT, pricePerUnit: "10000" });

    server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 }),
    );

    const ctx = server.getSessionContext("ch_test");
    expect(ctx).not.toBeNull();
    expect(ctx!.channelId).toBe("ch_test");
    expect(ctx!.sessionPubkey).toBe(TEST_SIGNER);
    expect(ctx!.cumulativeAmount).toBe(10000n);
    expect(ctx!.voucherCount).toBe(1);
  });

  it("updates context after multiple vouchers", () => {
    const server = createSessionServer({ recipient: RECIPIENT, pricePerUnit: "10000" });

    server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 }),
    );
    server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "20000", sequence: 2 }),
    );

    const ctx = server.getSessionContext("ch_test");
    expect(ctx!.cumulativeAmount).toBe(20000n);
    expect(ctx!.voucherCount).toBe(2);
  });
});

// ── removeSession ─────────────────────────────────────────────────────────

describe("createSessionServer — removeSession", () => {
  it("removes tracked session", () => {
    const server = createSessionServer({ recipient: RECIPIENT, pricePerUnit: "10000" });

    server.verifyVoucher(
      makeVoucher({ recipient: RECIPIENT, cumulativeAmount: "10000", sequence: 1 }),
    );

    expect(server.getSessionContext("ch_test")).not.toBeNull();
    server.removeSession("ch_test");
    expect(server.getSessionContext("ch_test")).toBeNull();
  });

  it("does not throw when removing unknown channel", () => {
    const server = createSessionServer({ recipient: RECIPIENT, pricePerUnit: "10000" });
    expect(() => server.removeSession("ch_nonexistent")).not.toThrow();
  });
});
