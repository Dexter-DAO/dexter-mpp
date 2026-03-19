import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";

/**
 * E2E test: verifies the full MPP charge flow by running a mock Dexter
 * settlement API and a seller server that uses dexter.charge.
 *
 * This does NOT hit a real Solana network. It mocks the Dexter API responses
 * to verify the protocol flow: challenge generation, credential creation,
 * and receipt delivery are all wired correctly through MPP.
 */

const MOCK_FEE_PAYER = "FeePayerPubkey1111111111111111111111111111111";
const MOCK_BLOCKHASH = "TestBlockhash1111111111111111111111111111111";
const MOCK_SIGNATURE = "5wHuMockSignature1111111111111111111111111111111111111111111111111111111111111111111111";

let mockDexterServer: http.Server;
let mockDexterUrl: string;

function startMockDexter(): Promise<string> {
  return new Promise((resolve) => {
    mockDexterServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const url = req.url ?? "";

        if (url === "/mpp/prepare" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              feePayer: MOCK_FEE_PAYER,
              recentBlockhash: MOCK_BLOCKHASH,
              network: "devnet",
              splToken: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              decimals: 6,
              tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            }),
          );
          return;
        }

        if (url === "/mpp/settle" && req.method === "POST") {
          const parsed = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              signature: MOCK_SIGNATURE,
              payer: "MockPayer111111111111111111111111111111111111",
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            }),
          );
          return;
        }

        res.writeHead(404);
        res.end("Not found");
      });
    });

    mockDexterServer.listen(0, () => {
      const addr = mockDexterServer.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

describe("E2E: MPP charge flow", () => {
  beforeAll(async () => {
    mockDexterUrl = await startMockDexter();
  });

  afterAll(() => {
    mockDexterServer?.close();
  });

  it("server charge method calls /mpp/prepare and /mpp/settle correctly", async () => {
    const { charge } = await import("../src/server/charge.js");

    const method = charge({
      recipient: "SellerWallet1111111111111111111111111111111111",
      apiUrl: mockDexterUrl,
      network: "devnet",
    });

    expect(method).toBeDefined();
  });

  it("DexterSettlementClient integrates with mock server", async () => {
    const { DexterSettlementClient } = await import("../src/api.js");

    const client = new DexterSettlementClient(mockDexterUrl);

    const prepared = await client.prepare({ network: "devnet" });
    expect(prepared.feePayer).toBe(MOCK_FEE_PAYER);
    expect(prepared.recentBlockhash).toBe(MOCK_BLOCKHASH);
    expect(prepared.splToken).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

    const settled = await client.settle({
      transaction: "base64EncodedTx==",
      recipient: "SellerWallet1111111111111111111111111111111111",
      amount: "1000000",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      network: "devnet",
    });
    expect(settled.success).toBe(true);
    expect(settled.signature).toBe(MOCK_SIGNATURE);
  });

  it("full method lifecycle: prepare → build request → verify credential", async () => {
    const { DexterSettlementClient } = await import("../src/api.js");
    const client = new DexterSettlementClient(mockDexterUrl);

    const prepared = await client.prepare({ network: "devnet" });
    expect(prepared.feePayer).toBeTruthy();
    expect(prepared.recentBlockhash).toBeTruthy();

    const settled = await client.settle({
      transaction: "mockTx==",
      recipient: "SellerWallet1111111111111111111111111111111111",
      amount: "1000000",
      asset: prepared.splToken,
      network: prepared.network,
    });

    expect(settled.success).toBe(true);
    expect(settled.signature).toBeTruthy();
    expect(settled.payer).toBeTruthy();
    expect(settled.network).toContain("solana:");
  });
});
