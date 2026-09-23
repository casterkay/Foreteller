import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { Logger } from "../../src/core/log.js";
import {
  PanelServer,
  PanelState,
  type PanelConfiguration,
  type PanelSnapshot,
} from "../../src/panel/index.js";

describe("PanelServer", () => {
  let server: PanelServer | undefined;

  afterEach(async () => {
    await server?.stop();
  });

  it("validates configuration before starting a panel session", async () => {
    const port = await unusedPort();
    const state = new PanelState();
    let received: PanelConfiguration | undefined;
    const runtime = {
      configure: (configuration: PanelConfiguration): Promise<PanelSnapshot> => {
        received = configuration;
        return Promise.resolve(state.snapshot());
      },
      stop: () => Promise.resolve(),
    };
    server = new PanelServer({ state, runtime, logger: silentLogger, port });
    await server.start();

    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/panel`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youtubeUrl: "https://www.youtube.com/watch?v=video",
        eventUrl: "",
        customTitle: "Speech",
        customTerms: ["alpha", "alpha", "beta"],
        speaker: "Ada",
      }),
    });

    expect(response.status).toBe(202);
    expect(received?.customTerms).toEqual(["alpha", "beta"]);
  });

  it("rejects unrecognized configuration fields", async () => {
    const port = await unusedPort();
    const state = new PanelState();
    const runtime = {
      configure: (_configuration: PanelConfiguration) => Promise.resolve(state.snapshot()),
      stop: () => Promise.resolve(),
    };
    server = new PanelServer({ state, runtime, logger: silentLogger, port });
    await server.start();

    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/panel`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youtubeUrl: "https://www.youtube.com/watch?v=video",
        customTitle: "Speech",
        customTerms: ["alpha"],
        speaker: "Ada",
        apiKey: "must-not-be-accepted",
      }),
    });

    expect(response.status).toBe(400);
  });
});

const silentLogger: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("No TCP address");
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}
