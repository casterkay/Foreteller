import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("rejects live trading without wallet credentials", () => {
    expect(() => loadConfig({ LIVE_TRADING: "true" })).toThrow(
      /POLYMARKET_PRIVATE_KEY/,
    );
  });

  it("defaults to dry run with conservative limits", () => {
    const config = loadConfig({});

    expect(config.liveTrading).toBe(false);
    expect(config.limits.forecastNotional).toBe(5);
    expect(config.limits.eventNotionalLimit).toBe(120);
  });
});
