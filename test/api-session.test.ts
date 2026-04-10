import { describe, it, expect, vi, beforeEach } from "vitest";
import { DexterSettlementClient, SettlementError } from "../src/api.js";

describe("DexterSettlementClient — session endpoints", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── sessionOpen ────────────────────────────────────────────────────────

  describe("sessionOpen", () => {
    it("sends POST to /mpp/session/open and returns channel info", async () => {
      const mockResponse = {
        success: true,
        channel_id: "ch_abc123",
        session_pubkey: "SessionPubkey111111111111111111111111111111",
        deposit_atomic: "1000000",
        network: "mainnet-beta",
        channel_program: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.sessionOpen({
        buyer_wallet: "BuyerWallet111111111111111111111111111111111",
        buyer_swig_address: "SwigWallet111111111111111111111111111111111",
        seller_wallet: "SellerWallet11111111111111111111111111111111",
        deposit_atomic: "1000000",
      });

      expect(result.channel_id).toBe("ch_abc123");
      expect(result.session_pubkey).toBe("SessionPubkey111111111111111111111111111111");
      expect(result.deposit_atomic).toBe("1000000");
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:4072/mpp/session/open",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws SettlementError when session open fails", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, error: "insufficient_deposit", detail: "Minimum deposit is 100000" }),
          { status: 200 },
        ),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      await expect(
        client.sessionOpen({
          buyer_wallet: "Buyer",
          buyer_swig_address: "Swig",
          seller_wallet: "Seller",
          deposit_atomic: "1",
        }),
      ).rejects.toThrow(SettlementError);
    });
  });

  // ── sessionVoucher ─────────────────────────────────────────────────────

  describe("sessionVoucher", () => {
    it("sends POST to /mpp/session/voucher and returns signed voucher", async () => {
      const mockResponse = {
        success: true,
        voucher: {
          channelId: "ch_abc123",
          payer: "BuyerWallet",
          recipient: "SellerWallet",
          cumulativeAmount: "10000",
          sequence: 1,
          meter: "request",
          units: "1",
          serverNonce: "nonce-uuid-123",
          chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          channelProgram: "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
        },
        signature: "ed25519sig-base64",
        signer: "SessionPubkey111",
        signatureType: "ed25519",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.sessionVoucher({
        channel_id: "ch_abc123",
        amount: "10000",
        serverNonce: "nonce-uuid-123",
      });

      expect(result.voucher.channelId).toBe("ch_abc123");
      expect(result.voucher.cumulativeAmount).toBe("10000");
      expect(result.signature).toBe("ed25519sig-base64");
      expect(result.signatureType).toBe("ed25519");
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:4072/mpp/session/voucher",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws SettlementError when voucher signing fails", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, error: "channel_not_found", detail: "No channel ch_bad" }),
          { status: 200 },
        ),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      await expect(
        client.sessionVoucher({ channel_id: "ch_bad", amount: "10000", serverNonce: "n" }),
      ).rejects.toThrow(SettlementError);
    });
  });

  // ── sessionClose ───────────────────────────────────────────────────────

  describe("sessionClose", () => {
    it("sends POST to /mpp/session/close and returns settlement", async () => {
      const mockResponse = {
        success: true,
        channel_id: "ch_abc123",
        settlement: {
          seller: "SellerWallet",
          amount_settled: "50000",
          buyer_refund: "950000",
          voucher_count: 5,
          session_duration_seconds: 120,
        },
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.sessionClose({ channel_id: "ch_abc123" });

      expect(result.channel_id).toBe("ch_abc123");
      expect(result.settlement.amount_settled).toBe("50000");
      expect(result.settlement.buyer_refund).toBe("950000");
      expect(result.settlement.voucher_count).toBe(5);
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:4072/mpp/session/close",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws SettlementError when close fails", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, error: "channel_already_closed" }),
          { status: 200 },
        ),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      await expect(
        client.sessionClose({ channel_id: "ch_closed" }),
      ).rejects.toThrow(SettlementError);
    });
  });

  // ── sessionOnboard ─────────────────────────────────────────────────────

  describe("sessionOnboard", () => {
    it("sends POST to /api/sessions/onboard and returns ready status", async () => {
      const mockResponse = {
        status: "ready",
        swig_address: "SwigAddress111111111111111111111111111111111",
        role_id: 42,
        spend_limit_remaining: "100000000",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.sessionOnboard({
        buyer_wallet: "BuyerWallet111111111111111111111111111111111",
      });

      expect(result.status).toBe("ready");
      expect(result.swig_address).toBe("SwigAddress111111111111111111111111111111111");
      expect(result.role_id).toBe(42);
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:4072/api/sessions/onboard",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("returns transactions_required when Swig wallet needs creation", async () => {
      const mockResponse = {
        status: "transactions_required",
        swig_address: "NewSwigAddress1111111111111111111111111111111",
        transactions: [
          { type: "create_swig", tx: "base64tx1==" },
          { type: "grant_role", tx: "base64tx2==" },
        ],
        expires_at: "2026-04-10T22:00:00Z",
        next_step: "Sign and submit transactions via /api/sessions/onboard/confirm",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.sessionOnboard({
        buyer_wallet: "NewBuyer1111111111111111111111111111111111111",
      });

      expect(result.status).toBe("transactions_required");
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions![0].type).toBe("create_swig");
    });

    it("throws SettlementError on HTTP error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "invalid_wallet", detail: "Not a valid Solana address" }),
          { status: 400 },
        ),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      await expect(
        client.sessionOnboard({ buyer_wallet: "bad" }),
      ).rejects.toThrow(SettlementError);
    });
  });

  // ── sessionOnboardConfirm ──────────────────────────────────────────────

  describe("sessionOnboardConfirm", () => {
    it("sends POST with signed transactions and returns ready", async () => {
      const mockResponse = {
        status: "ready",
        swig_address: "SwigAddress111111111111111111111111111111111",
        role_id: 42,
        onboard_tx_signatures: ["sig1abc", "sig2def"],
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.sessionOnboardConfirm({
        buyer_wallet: "BuyerWallet111111111111111111111111111111111",
        signed_transactions: ["signedTx1==", "signedTx2=="],
      });

      expect(result.status).toBe("ready");
      expect(result.onboard_tx_signatures).toHaveLength(2);
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:4072/api/sessions/onboard/confirm",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws SettlementError on HTTP error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "tx_expired", detail: "Transaction blockhash expired" }),
          { status: 400 },
        ),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      await expect(
        client.sessionOnboardConfirm({
          buyer_wallet: "Buyer",
          signed_transactions: ["expired_tx"],
        }),
      ).rejects.toThrow(SettlementError);
    });
  });

  // ── sessionOnboardStatus ───────────────────────────────────────────────

  describe("sessionOnboardStatus", () => {
    it("sends GET with buyer_wallet query param", async () => {
      const mockResponse = {
        buyer_wallet: "BuyerWallet111111111111111111111111111111111",
        swig_address: "SwigAddress111111111111111111111111111111111",
        role_id: 42,
        status: "active",
        spend_limit_atomic: "100000000",
        role_expires_at: "2026-04-11T22:00:00Z",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.sessionOnboardStatus("BuyerWallet111111111111111111111111111111111");

      expect(result.status).toBe("active");
      expect(result.swig_address).toBe("SwigAddress111111111111111111111111111111111");
      expect(result.role_id).toBe(42);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/sessions/onboard/status?buyer_wallet="),
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("returns not_onboarded for unknown wallet", async () => {
      const mockResponse = {
        buyer_wallet: "UnknownWallet",
        swig_address: null,
        role_id: null,
        status: "not_onboarded",
        spend_limit_atomic: null,
        role_expires_at: null,
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.sessionOnboardStatus("UnknownWallet");

      expect(result.status).toBe("not_onboarded");
      expect(result.swig_address).toBeNull();
    });

    it("throws SettlementError on HTTP error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "server_error" }),
          { status: 500 },
        ),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      await expect(
        client.sessionOnboardStatus("Buyer"),
      ).rejects.toThrow(SettlementError);
    });
  });
});
