import { describe, expect, it } from "vitest";

import { createCoinbaseOnrampUrl } from "./onramp.js";

describe("createCoinbaseOnrampUrl", () => {
  it("rejects amounts outside Coinbase's supported range before touching the wallet", async () => {
    await expect(createCoinbaseOnrampUrl(0)).rejects.toThrow(/between \$1 and \$2,500/i);
    await expect(createCoinbaseOnrampUrl(2_500.01)).rejects.toThrow(/between \$1 and \$2,500/i);
    await expect(createCoinbaseOnrampUrl(Number.NaN)).rejects.toThrow(/between \$1 and \$2,500/i);
  });
});
