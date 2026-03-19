import { DEFAULT_DEXTER_API_URL } from "./constants.js";

export type PrepareRequest = {
  network?: string;
};

export type PrepareResponse = {
  feePayer: string;
  recentBlockhash: string;
  network: string;
  splToken: string;
  decimals: number;
  tokenProgram: string;
};

export type SettleRequest = {
  transaction: string;
  recipient: string;
  amount: string;
  asset: string;
  network: string;
};

export type SettleResponse = {
  success: boolean;
  signature?: string;
  payer?: string;
  network?: string;
  error?: string;
  detail?: string;
};

export class DexterSettlementClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? DEFAULT_DEXTER_API_URL).replace(/\/+$/, "");
  }

  async prepare(params: PrepareRequest): Promise<PrepareResponse> {
    const res = await fetch(`${this.baseUrl}/mpp/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Dexter prepare failed (${res.status}): ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<PrepareResponse>;
  }

  async settle(params: SettleRequest): Promise<SettleResponse> {
    const res = await fetch(`${this.baseUrl}/mpp/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Dexter settle failed (${res.status}): ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<SettleResponse>;
  }
}
