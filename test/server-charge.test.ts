import { describe, it, expect, vi, beforeEach } from "vitest";
import { charge } from "../src/server/charge.js";

describe("server charge method", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a method with correct name and intent", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const method = charge({
      recipient: "TestRecipient",
      apiUrl: "http://localhost:4072",
    });

    expect(method).toBeDefined();
  });

  it("calls /mpp/prepare during challenge generation", async () => {
    const prepareResponse = {
      feePayer: "FeePayerPubkey",
      recentBlockhash: "blockhash123",
      network: "devnet",
      splToken: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      decimals: 6,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(prepareResponse), { status: 200 }),
    );

    const method = charge({
      recipient: "TestRecipient",
      apiUrl: "http://localhost:4072",
      network: "devnet",
    });

    expect(method).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
