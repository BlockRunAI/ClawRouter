import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_PAYMENT_ASSET,
  fetchBasePaymentAsset,
  fetchBasePaymentAssets,
  normalizeBasePaymentAsset,
  normalizeBasePaymentAssets,
} from "./payment-asset.js";

describe("payment asset helpers", () => {
  it("normalizes a valid flat response", () => {
    const asset = normalizeBasePaymentAsset({
      asset: "0x1111111111111111111111111111111111111111",
      symbol: "eurc",
      decimals: 6,
      name: "Euro Coin",
      transferMethod: "eip3009",
    });

    expect(asset).toEqual({
      chain: "base",
      asset: "0x1111111111111111111111111111111111111111",
      symbol: "EURC",
      decimals: 6,
      name: "Euro Coin",
      transferMethod: "eip3009",
    });
  });

  it("rejects non-eip3009 assets", () => {
    const asset = normalizeBasePaymentAsset({
      asset: "0x1111111111111111111111111111111111111111",
      symbol: "USDT",
      decimals: 6,
      name: "Tether",
      transferMethod: "permit2",
    });

    expect(asset).toBeUndefined();
  });

  it("parses nested paymentAsset responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          paymentAsset: {
            asset: "0x2222222222222222222222222222222222222222",
            symbol: "EURC",
            decimals: 6,
            name: "Euro Coin",
            transferMethod: "eip3009",
          },
        }),
        { status: 200 },
      ),
    );

    const asset = await fetchBasePaymentAsset(
      "https://blockrun.ai/api",
      mockFetch as unknown as typeof fetch,
    );
    expect(asset?.asset).toBe("0x2222222222222222222222222222222222222222");
    expect(asset?.symbol).toBe("EURC");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://blockrun.ai/api/v1/payment-metadata?chain=base",
      expect.any(Object),
    );
  });

  it("falls back to the default asset for invalid metadata responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ paymentAsset: { symbol: "EURC" } }), { status: 200 }),
    );

    const asset = await fetchBasePaymentAsset(
      "https://blockrun.ai/api",
      mockFetch as unknown as typeof fetch,
    );
    expect(asset).toEqual(DEFAULT_BASE_PAYMENT_ASSET);
  });

  it("parses and sorts multiple assets by priority", () => {
    const assets = normalizeBasePaymentAssets({
      paymentAssets: [
        {
          asset: "0x3333333333333333333333333333333333333333",
          symbol: "FXUSD",
          decimals: 18,
          name: "fxUSD",
          transferMethod: "eip3009",
          priority: 2,
        },
        {
          asset: "0x1111111111111111111111111111111111111111",
          symbol: "USDC",
          decimals: 6,
          name: "USD Coin",
          transferMethod: "eip3009",
          priority: 1,
        },
      ],
    });

    expect(assets.map((asset) => asset.symbol)).toEqual(["USDC", "FXUSD"]);
  });

  it("fetches multiple payment assets", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          paymentAssets: [
            {
              asset: "0x1111111111111111111111111111111111111111",
              symbol: "USDC",
              decimals: 6,
              name: "USD Coin",
              transferMethod: "eip3009",
              priority: 1,
            },
            {
              asset: "0x2222222222222222222222222222222222222222",
              symbol: "EURC",
              decimals: 6,
              name: "Euro Coin",
              transferMethod: "eip3009",
              priority: 2,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const assets = await fetchBasePaymentAssets(
      "https://blockrun.ai/api",
      mockFetch as unknown as typeof fetch,
    );
    expect(assets).toHaveLength(2);
    expect(assets[0]?.symbol).toBe("USDC");
    expect(assets[1]?.symbol).toBe("EURC");
  });

  it("keeps USDC as the safe default asset", () => {
    expect(DEFAULT_BASE_PAYMENT_ASSET.symbol).toBe("USDC");
    expect(DEFAULT_BASE_PAYMENT_ASSET.transferMethod).toBe("eip3009");
  });

  it("normalizes fxUSD with 18 decimals correctly", () => {
    const asset = normalizeBasePaymentAsset({
      asset: "0x55380fe7a1910dff29a47b622057ab4139da42c5",
      symbol: "fxusd",
      decimals: 18,
      name: "fxUSD",
      transferMethod: "eip3009",
    });

    expect(asset).toEqual({
      chain: "base",
      asset: "0x55380fe7a1910dff29a47b622057ab4139da42c5",
      symbol: "FXUSD",
      decimals: 18,
      name: "fxUSD",
      transferMethod: "eip3009",
    });
  });

  it("handles mixed-decimal assets in normalizeBasePaymentAssets", () => {
    const assets = normalizeBasePaymentAssets({
      paymentAssets: [
        {
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          symbol: "USDC",
          decimals: 6,
          name: "USD Coin",
          transferMethod: "eip3009",
          priority: 1,
        },
        {
          asset: "0x55380fe7a1910dff29a47b622057ab4139da42c5",
          symbol: "FXUSD",
          decimals: 18,
          name: "fxUSD",
          transferMethod: "eip3009",
          priority: 2,
        },
        {
          asset: "0x0000000000000000000000000000000000000000",
          symbol: "DISABLED",
          decimals: 6,
          name: "Disabled Token",
          transferMethod: "eip3009",
          enabled: false,
        },
      ],
    });

    expect(assets).toHaveLength(2);
    expect(assets[0]?.symbol).toBe("USDC");
    expect(assets[0]?.decimals).toBe(6);
    expect(assets[1]?.symbol).toBe("FXUSD");
    expect(assets[1]?.decimals).toBe(18);
  });

  it("accepts the real fxUSD Base contract address", () => {
    const asset = normalizeBasePaymentAsset({
      asset: "0x55380fe7A1910dFf29a47B622057AB4139DA42C5",
      symbol: "FXUSD",
      decimals: 18,
      name: "fxUSD",
      transferMethod: "eip3009",
    });

    expect(asset).toBeDefined();
    expect(asset?.asset).toBe("0x55380fe7A1910dFf29a47B622057AB4139DA42C5");
  });
});
