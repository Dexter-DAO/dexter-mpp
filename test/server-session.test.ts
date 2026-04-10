import { describe, it, expect } from "vitest";
import { createSessionServer } from "../src/server/session.js";
import type { SessionVoucherResponse } from "../src/api.js";

// ── Helper to build a valid voucher response ──────────────────────────────

function makeVoucher(overrides: Partial<{
  channelId: string;
  recipient: string;
  cumulativeAmount: string;
  sequence: number;
  signer: string;
  units: string;
}>): SessionVoucherResponse {
  return {
    success: true,
    voucher: {
      channelId: overrides.channelId ?? "ch_test",
      payer: "BuyerWallet",
      recipient: overrides.recipient ?? "SellerWallet1111111111111111111111111111111111",
      cumulativeAmount: overrides.cumulativeAmount ?? "10000",
      sequence: overrides.sequence ?? 1,
      meter: "request",
      units: overrides.units ?? "1",
      serverNonce: "nonce-123",
      chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      channelProgram: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
    },
    signature: "ed25519sig-base64",
    signer: overrides.signer ?? "SessionPubkey111",
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
      recipient: "SellerWallet1111111111111111111111111111111111",
      pricePerUnit: "10000",
    });

    const challenge = server.getChallenge();

    expect(challenge.type).toBe("mpp-session");
    expect(challenge.recipient).toBe("SellerWallet1111111111111111111111111111111111");
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
  const RECIPIENT = "SellerWallet1111111111111111111111111111111111";

  function makeServer(pricePerUnit = "10000") {
    return createSessionServer({ recipient: RECIPIENT, pricePerUnit });
  }

  it("accepts a valid first voucher", () => {
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

  it("rejects voucher with wrong recipient", () => {
    const server = makeServer();
    const result = server.verifyVoucher(
      makeVoucher({ recipient: "WrongRecipient" }),
    );

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
        signer: "OriginalSigner",
      }),
    );

    const result = server.verifyVoucher(
      makeVoucher({
        recipient: RECIPIENT,
        cumulativeAmount: "20000",
        sequence: 2,
        signer: "DifferentSigner",
      }),
    );

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
  const RECIPIENT = "SellerWallet1111111111111111111111111111111111";

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
    expect(ctx!.sessionPubkey).toBe("SessionPubkey111");
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
  const RECIPIENT = "SellerWallet1111111111111111111111111111111111";

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
