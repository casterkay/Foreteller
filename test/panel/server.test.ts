import { createServer } from "node:net";
import { WebSocket } from "ws";

import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("pushes every state update and sends current state again on reconnect", async () => {
    const port = await unusedPort();
    const state = new PanelState();
    server = new PanelServer({ state, port, logger: silentLogger, runtime: {
      configure: async () => state.snapshot(), stop: async () => undefined,
    } });
    await server.start();
    const received: PanelSnapshot[] = [];
    const connect = (): WebSocket => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/panel/stream`);
      socket.on("message", (message) => received.push(JSON.parse(message.toString()) as PanelSnapshot));
      return socket;
    };
    const first = connect();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    state.recordTranscript(10);
    state.recordTranscript(20);
    await vi.waitFor(() => expect(received.map((snapshot) => snapshot.transcriptUpdatedAtMs)).toEqual([null, 10, 20]));
    first.terminate();
    const second = connect();
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received[3]?.transcriptUpdatedAtMs).toBe(20);
    second.terminate();
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

  it("aborts in-flight configuration before stopping the runtime", async () => {
    const port = await unusedPort();
    const state = new PanelState();
    let configureSignal: AbortSignal | undefined;
    let resolveConfigure: (() => void) | undefined;
    const runtime = {
      configure: async (_configuration: PanelConfiguration, signal?: AbortSignal) => {
        configureSignal = signal;
        await new Promise<void>((resolve) => { resolveConfigure = resolve; });
        signal?.throwIfAborted();
        return state.snapshot();
      },
      stop: () => Promise.resolve(),
    };
    server = new PanelServer({ state, runtime, logger: silentLogger, port });
    await server.start();
    const request = fetch(`http://127.0.0.1:${String(port)}/v1/panel`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youtubeUrl: "https://www.youtube.com/watch?v=video",
        customTitle: "Speech",
        customTerms: ["alpha"],
        speaker: "Ada",
      }),
    });
    await vi.waitFor(() => expect(configureSignal).toBeDefined());
    const stopping = server.stop();
    await vi.waitFor(() => expect(configureSignal?.aborted).toBe(true));
    resolveConfigure?.();
    await stopping;
    server = undefined;
    await expect(request).resolves.toMatchObject({ status: 503 });
  });

  it("does not accept a new configuration after shutdown starts", async () => {
    const port = await unusedPort();
    const state = new PanelState();
    let resolveStop: (() => void) | undefined;
    let configureCalls = 0;
    const runtime = {
      configure: (_configuration: PanelConfiguration) => {
        configureCalls += 1;
        return Promise.resolve(state.snapshot());
      },
      stop: () => new Promise<void>((resolve) => { resolveStop = resolve; }),
    };
    server = new PanelServer({ state, runtime, logger: silentLogger, port });
    await server.start();
    const stopping = server.stop();
    await vi.waitFor(() => expect(resolveStop).toBeDefined());

    await expect(fetch(`http://127.0.0.1:${String(port)}/v1/panel`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youtubeUrl: "https://www.youtube.com/watch?v=video",
        customTitle: "Speech",
        customTerms: ["alpha"],
        speaker: "Ada",
      }),
    })).rejects.toThrow();
    expect(configureCalls).toBe(0);
    resolveStop?.();
    await stopping;
    server = undefined;
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
