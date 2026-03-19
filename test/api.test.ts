import { describe, it, expect, vi, beforeEach } from "vitest";
import { DexterSettlementClient } from "../src/api.js";

describe("DexterSettlementClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("uses default URL when none provided", () => {
      const client = new DexterSettlementClient();
      expect(client).toBeDefined();
    });

    it("accepts custom URL", () => {
      const client = new DexterSettlementClient("http://localhost:4072");
      expect(client).toBeDefined();
    });

    it("strips trailing slashes from URL", () => {
      const client = new DexterSettlementClient("http://localhost:4072///");
      expect(client).toBeDefined();
    });
  });

  describe("prepare", () => {
    it("sends POST to /mpp/prepare with network", async () => {
      const mockResponse = {
        feePayer: "CKPayer123",
        recentBlockhash: "blockhash123",
        network: "mainnet-beta",
        splToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
        tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.prepare({ network: "devnet" });

      expect(result).toEqual(mockResponse);
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:4072/mpp/prepare",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ network: "devnet" }),
        }),
      );
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("bad request", { status: 400 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      await expect(client.prepare({})).rejects.toThrow("Dexter prepare failed (400)");
    });
  });

  describe("settle", () => {
    it("sends POST to /mpp/settle with transaction data", async () => {
      const mockResponse = {
        success: true,
        signature: "5wHuSignature",
        payer: "BuyerPubkey",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.settle({
        transaction: "base64tx==",
        recipient: "RecipientPubkey",
        amount: "1000000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        network: "mainnet-beta",
      });

      expect(result).toEqual(mockResponse);
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:4072/mpp/settle",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("server error", { status: 500 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      await expect(
        client.settle({
          transaction: "tx",
          recipient: "r",
          amount: "1",
          asset: "a",
          network: "devnet",
        }),
      ).rejects.toThrow("Dexter settle failed (500)");
    });

    it("returns failure response without throwing when success is false", async () => {
      const failResponse = {
        success: false,
        error: "policy:program_not_allowed",
        detail: "Transaction contains disallowed program",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(failResponse), { status: 200 }),
      );

      const client = new DexterSettlementClient("http://localhost:4072");
      const result = await client.settle({
        transaction: "tx",
        recipient: "r",
        amount: "1",
        asset: "a",
        network: "devnet",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("policy:program_not_allowed");
    });
  });
});
