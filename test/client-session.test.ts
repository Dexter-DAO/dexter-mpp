import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionClient } from "../src/client/session.js";
import { SettlementError } from "../src/api.js";

// ── Mock fetch helpers ────────────────────────────────────────────────────

function mockFetchResponse(data: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(data), { status }),
  );
}

function mockSessionOpenResponse(channelId = "ch_test") {
  return {
    success: true,
    channel_id: channelId,
    session_pubkey: "SessionPubkey111111111111111111111111111111",
    deposit_atomic: "1000000",
    network: "mainnet-beta",
    channel_program: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
  };
}

function mockVoucherResponse(sequence: number, cumulativeAmount: string) {
  return {
    success: true,
    voucher: {
      channelId: "ch_test",
      payer: "BuyerWallet",
      recipient: "SellerWallet",
      cumulativeAmount,
      sequence,
      meter: "request",
      units: "1",
      serverNonce: "nonce-123",
      chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      channelProgram: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
    },
    signature: "ed25519sig-base64",
    signer: "SessionPubkey111",
    signatureType: "ed25519",
  };
}

function mockCloseResponse() {
  return {
    success: true,
    channel_id: "ch_test",
    settlement: {
      seller: "SellerWallet",
      amount_settled: "50000",
      buyer_refund: "950000",
      voucher_count: 5,
      session_duration_seconds: 120,
    },
  };
}

// ── Validation ────────────────────────────────────────────────────────────

describe("createSessionClient — validation", () => {
  it("throws on missing buyerWallet", () => {
    expect(() =>
      createSessionClient({
        buyerWallet: "",
        buyerSwigAddress: "SwigAddress",
      }),
    ).toThrow("'buyerWallet'");
  });

  it("throws on missing buyerSwigAddress", () => {
    expect(() =>
      createSessionClient({
        buyerWallet: "BuyerWallet",
        buyerSwigAddress: "",
      }),
    ).toThrow("'buyerSwigAddress'");
  });
});

// ── open ──────────────────────────────────────────────────────────────────

describe("createSessionClient — open", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a session and returns channel info", async () => {
    mockFetchResponse(mockSessionOpenResponse());

    const client = createSessionClient({
      buyerWallet: "BuyerWallet111111111111111111111111111111111",
      buyerSwigAddress: "SwigAddress111111111111111111111111111111111",
      apiUrl: "http://localhost:4072",
    });

    const result = await client.open({
      seller: "SellerWallet11111111111111111111111111111111",
      deposit: "1000000",
    });

    expect(result.channel_id).toBe("ch_test");
    expect(result.session_pubkey).toBe("SessionPubkey111111111111111111111111111111");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4072/mpp/session/open",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("tracks opened session in listSessions", async () => {
    mockFetchResponse(mockSessionOpenResponse());

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    expect(client.listSessions()).toHaveLength(0);

    await client.open({ seller: "Seller", deposit: "1000000" });

    expect(client.listSessions()).toHaveLength(1);
    expect(client.getSession("ch_test")).not.toBeNull();
    expect(client.getSession("ch_test")!.seller).toBe("Seller");
  });

  it("fires onProgress opening and opened events", async () => {
    mockFetchResponse(mockSessionOpenResponse());

    const events: string[] = [];
    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
      onProgress: (e) => events.push(e.type),
    });

    await client.open({ seller: "Seller", deposit: "1000000" });

    expect(events).toEqual(["opening", "opened"]);
  });

  it("throws SettlementError when open fails", async () => {
    mockFetchResponse({ success: false, error: "seller_not_registered" });

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await expect(
      client.open({ seller: "BadSeller", deposit: "1000000" }),
    ).rejects.toThrow(SettlementError);
  });
});

// ── pay ───────────────────────────────────────────────────────────────────

describe("createSessionClient — pay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requests a voucher for an active session", async () => {
    // open first
    mockFetchResponse(mockSessionOpenResponse());

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await client.open({ seller: "Seller", deposit: "1000000" });

    // then pay
    mockFetchResponse(mockVoucherResponse(1, "10000"));

    const voucher = await client.pay("ch_test", {
      amount: "10000",
      serverNonce: "nonce-123",
    });

    expect(voucher.voucher.cumulativeAmount).toBe("10000");
    expect(voucher.voucher.sequence).toBe(1);
    expect(voucher.signatureType).toBe("ed25519");
  });

  it("tracks cumulative amount and voucher count", async () => {
    mockFetchResponse(mockSessionOpenResponse());

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await client.open({ seller: "Seller", deposit: "1000000" });

    mockFetchResponse(mockVoucherResponse(1, "10000"));
    await client.pay("ch_test", { amount: "10000", serverNonce: "n1" });

    mockFetchResponse(mockVoucherResponse(2, "20000"));
    await client.pay("ch_test", { amount: "20000", serverNonce: "n2" });

    const session = client.getSession("ch_test");
    expect(session!.cumulativeAmount).toBe(20000n);
    expect(session!.voucherCount).toBe(2);
  });

  it("fires onProgress voucher event", async () => {
    mockFetchResponse(mockSessionOpenResponse());

    const events: string[] = [];
    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
      onProgress: (e) => events.push(e.type),
    });

    await client.open({ seller: "Seller", deposit: "1000000" });
    events.length = 0; // clear open events

    mockFetchResponse(mockVoucherResponse(1, "10000"));
    await client.pay("ch_test", { amount: "10000", serverNonce: "n" });

    expect(events).toEqual(["voucher"]);
  });

  it("throws SettlementError for unknown channel", async () => {
    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await expect(
      client.pay("ch_nonexistent", { amount: "10000", serverNonce: "n" }),
    ).rejects.toThrow(SettlementError);
  });
});

// ── close ─────────────────────────────────────────────────────────────────

describe("createSessionClient — close", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("closes a session and returns settlement info", async () => {
    mockFetchResponse(mockSessionOpenResponse());

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await client.open({ seller: "Seller", deposit: "1000000" });

    mockFetchResponse(mockCloseResponse());

    const result = await client.close("ch_test");

    expect(result.settlement.amount_settled).toBe("50000");
    expect(result.settlement.buyer_refund).toBe("950000");
    expect(result.settlement.voucher_count).toBe(5);
  });

  it("removes session from tracking after close", async () => {
    mockFetchResponse(mockSessionOpenResponse());

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await client.open({ seller: "Seller", deposit: "1000000" });
    expect(client.getSession("ch_test")).not.toBeNull();

    mockFetchResponse(mockCloseResponse());
    await client.close("ch_test");

    expect(client.getSession("ch_test")).toBeNull();
    expect(client.listSessions()).toHaveLength(0);
  });

  it("fires onProgress closing and closed events", async () => {
    mockFetchResponse(mockSessionOpenResponse());

    const events: string[] = [];
    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
      onProgress: (e) => events.push(e.type),
    });

    await client.open({ seller: "Seller", deposit: "1000000" });
    events.length = 0;

    mockFetchResponse(mockCloseResponse());
    await client.close("ch_test");

    expect(events).toEqual(["closing", "closed"]);
  });

  it("throws SettlementError for unknown channel", async () => {
    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await expect(client.close("ch_nonexistent")).rejects.toThrow(SettlementError);
  });
});

// ── Full lifecycle ────────────────────────────────────────────────────────

describe("createSessionClient — full lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("open → pay × 3 → close", async () => {
    const events: string[] = [];

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
      onProgress: (e) => events.push(e.type),
    });

    // open
    mockFetchResponse(mockSessionOpenResponse());
    await client.open({ seller: "Seller", deposit: "1000000" });

    // pay 3 times
    for (let i = 1; i <= 3; i++) {
      mockFetchResponse(mockVoucherResponse(i, String(i * 10000)));
      await client.pay("ch_test", { amount: String(i * 10000), serverNonce: `n${i}` });
    }

    // verify tracking
    const session = client.getSession("ch_test");
    expect(session!.cumulativeAmount).toBe(30000n);
    expect(session!.voucherCount).toBe(3);

    // close
    mockFetchResponse(mockCloseResponse());
    await client.close("ch_test");

    expect(client.listSessions()).toHaveLength(0);
    expect(events).toEqual([
      "opening", "opened",
      "voucher", "voucher", "voucher",
      "closing", "closed",
    ]);
  });
});

// ── onboard ───────────────────────────────────────────────────────────────

// Mock signing callbacks that satisfy SIWx requirements
const mockOnboardCallbacks = {
  signTransaction: async (tx: string) => tx,
  signMessage: async (_message: Uint8Array) => new Uint8Array(64),
  publicKey: "BuyerWallet",
};

describe("createSessionClient — onboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns immediately when status is ready", async () => {
    mockFetchResponse({
      status: "ready",
      swig_address: "SwigAddress111",
      role_id: 42,
    });

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    const result = await client.onboard(mockOnboardCallbacks);

    expect(result.status).toBe("ready");
    expect(result.swigAddress).toBe("SwigAddress111");
    expect(result.roleId).toBe(42);
  });

  it("sends SIGN-IN-WITH-X header with onboard request", async () => {
    // Capture the actual fetch call args
    let capturedHeaders: Record<string, string> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ status: "ready", swig_address: "Swig", role_id: 1 }),
        { status: 200 },
      );
    });

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await client.onboard(mockOnboardCallbacks);

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["SIGN-IN-WITH-X"]).toBeDefined();
    expect(typeof capturedHeaders!["SIGN-IN-WITH-X"]).toBe("string");
    // SIWx header is base64-encoded JSON — should be substantial length
    expect(capturedHeaders!["SIGN-IN-WITH-X"].length).toBeGreaterThan(50);
  });

  it("throws when neither signer nor signTransaction provided", async () => {
    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await expect(client.onboard({})).rejects.toThrow(SettlementError);
  });

  it("throws when signTransaction provided without signMessage", async () => {
    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await expect(
      client.onboard({ signTransaction: async (tx) => tx }),
    ).rejects.toThrow("signMessage");
  });

  it("throws when signMessage provided without publicKey", async () => {
    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await expect(
      client.onboard({
        signTransaction: async (tx) => tx,
        signMessage: async (_msg) => new Uint8Array(64),
      }),
    ).rejects.toThrow("publicKey");
  });

  it("throws on not_eligible status", async () => {
    mockFetchResponse({
      status: "not_eligible",
      swig_address: "",
    });

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await expect(
      client.onboard(mockOnboardCallbacks),
    ).rejects.toThrow("not_eligible");
  });

  it("throws on temporarily_unavailable status", async () => {
    mockFetchResponse({
      status: "temporarily_unavailable",
      swig_address: "",
    });

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    await expect(
      client.onboard(mockOnboardCallbacks),
    ).rejects.toThrow("temporarily_unavailable");
  });

  it("handles transactions_required → sign → confirm → ready", async () => {
    // First call: needs transactions
    mockFetchResponse({
      status: "transactions_required",
      swig_address: "NewSwig111",
      transactions: [
        { type: "create_swig", tx: "dW5zaWduZWRUeDE=" },
        { type: "grant_role", tx: "dW5zaWduZWRUeDI=" },
      ],
      expires_at: "2026-04-10T22:00:00Z",
      next_step: "Sign and submit",
    });

    // Confirm response
    mockFetchResponse({
      status: "ready",
      swig_address: "NewSwig111",
      role_id: 99,
      onboard_tx_signatures: ["sig1", "sig2"],
    });

    const signedTxs: string[] = [];
    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    const result = await client.onboard({
      signTransaction: async (txBase64) => {
        signedTxs.push(txBase64);
        return `signed_${txBase64}`;
      },
      signMessage: async (_msg) => new Uint8Array(64),
      publicKey: "BuyerWallet",
    });

    expect(result.status).toBe("ready");
    expect(result.swigAddress).toBe("NewSwig111");
    expect(result.roleId).toBe(99);
    expect(signedTxs).toHaveLength(2);
  });

  it("handles two-round onboarding (needs_swig then grant_role)", async () => {
    // Round 1: create wallet
    mockFetchResponse({
      status: "transactions_required",
      swig_address: "NewSwig",
      transactions: [{ type: "create_swig", tx: "dHgx" }],
    });

    // Round 1 confirm: still pending (wallet created, needs role)
    mockFetchResponse({
      status: "pending",
      swig_address: "NewSwig",
    });

    // Round 2: grant role
    mockFetchResponse({
      status: "transactions_required",
      swig_address: "NewSwig",
      transactions: [{ type: "grant_role", tx: "dHgy" }],
    });

    // Round 2 confirm: ready
    mockFetchResponse({
      status: "ready",
      swig_address: "NewSwig",
      role_id: 7,
    });

    const client = createSessionClient({
      buyerWallet: "BuyerWallet",
      buyerSwigAddress: "SwigAddress",
      apiUrl: "http://localhost:4072",
    });

    const result = await client.onboard({
      signTransaction: async (tx) => `signed_${tx}`,
      signMessage: async (_msg) => new Uint8Array(64),
      publicKey: "BuyerWallet",
    });

    expect(result.status).toBe("ready");
    expect(result.roleId).toBe(7);
  });
});
