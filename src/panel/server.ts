import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { z } from "zod";

import type { Logger } from "../core/log.js";
import type { PanelState } from "./state.js";
import type { PanelConfiguration, PanelSnapshot } from "./types.js";

const MAXIMUM_BODY_BYTES = 32 * 1024;
const CONFIGURATION_TIMEOUT_MS = 30_000;
const configurationSchema = z.object({
  youtubeUrl: z.string().trim().url().max(2_048),
  eventUrl: z.string().trim().max(2_048).default(""),
  customTitle: z.string().trim().max(200).default(""),
  customTerms: z.array(z.string().trim().min(1).max(100)).max(100).default([])
    .transform((terms) => [...new Set(terms)]),
  speaker: z.string().trim().min(1).max(100).default("primary speaker"),
}).strict().superRefine((configuration, context) => {
  if (!/^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//u.test(configuration.youtubeUrl)) {
    context.addIssue({ code: "custom", path: ["youtubeUrl"], message: "A valid YouTube URL is required" });
  }
  if (
    configuration.eventUrl.length > 0 &&
    !/^https:\/\/(?:www\.)?polymarket\.com\/event\/[^/?#]+(?:[/?#]|$)/u.test(configuration.eventUrl)
  ) {
    context.addIssue({ code: "custom", path: ["eventUrl"], message: "A valid Polymarket event URL is required" });
  }
  if (configuration.eventUrl.length === 0 && configuration.customTitle.length === 0) {
    context.addIssue({ code: "custom", path: ["customTitle"], message: "Custom title is required without a Polymarket event" });
  }
  if (configuration.eventUrl.length === 0 && configuration.customTerms.length === 0) {
    context.addIssue({ code: "custom", path: ["customTerms"], message: "At least one custom term is required without a Polymarket event" });
  }
});

export interface PanelServerOptions {
  readonly runtime: {
    configure(configuration: PanelConfiguration, signal?: AbortSignal): Promise<PanelSnapshot>;
    stop(): Promise<void>;
  };
  readonly state: PanelState;
  readonly logger: Logger;
  readonly port: number;
}

export class PanelServer {
  private server: Server | undefined;
  private stopping = false;
  private readonly requestControllers = new Set<AbortController>();

  public constructor(private readonly options: PanelServerOptions) {}

  public start(): Promise<void> {
    if (this.server !== undefined) return Promise.resolve();
    this.stopping = false;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.requestTimeout = 35_000;
    server.headersTimeout = 10_000;
    this.server = server;
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, "127.0.0.1");
    });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.stopping = true;
    for (const controller of this.requestControllers) {
      controller.abort(new Error("Panel service is stopping"));
    }
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
    await this.options.runtime.stop();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setCorsHeaders(request, response);
    if (this.stopping) {
      writeJson(response, 503, { error: "Panel service is stopping" });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/panel") {
        writeJson(response, 200, this.options.state.snapshot());
        return;
      }
      if (request.method === "PUT" && url.pathname === "/v1/panel") {
        const configuration = configurationSchema.parse(await readJson(request));
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort(new ConfigurationTimeoutError());
        }, CONFIGURATION_TIMEOUT_MS);
        timeout.unref();
        this.requestControllers.add(controller);
        request.once("aborted", () => controller.abort(new Error("Panel request disconnected")));
        response.once("close", () => {
          if (!response.writableEnded) {
            controller.abort(new Error("Panel request disconnected"));
          }
        });
        let snapshot: PanelSnapshot;
        try {
          snapshot = await this.options.runtime.configure(configuration, controller.signal);
        } finally {
          clearTimeout(timeout);
          this.requestControllers.delete(controller);
        }
        if (this.stopping) {
          throw new ServiceStoppingError();
        }
        writeJson(response, 202, snapshot);
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/v1/panel") {
        await this.options.runtime.stop();
        response.writeHead(204).end();
        return;
      }
      writeJson(response, 404, { error: "Not found" });
    } catch (error: unknown) {
      const status = this.stopping || error instanceof ServiceStoppingError
        ? 503
        : error instanceof ConfigurationTimeoutError
          ? 504
        : error instanceof z.ZodError || error instanceof InvalidJsonError
        ? 400
        : 500;
      const message = error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid panel configuration"
        : errorMessage(error);
      if (status === 500) this.options.logger.warn("Panel request failed", { error: message });
      if (!response.destroyed) writeJson(response, status, { error: message });
    }
  }
}

class InvalidJsonError extends Error {}
class ServiceStoppingError extends Error {
  public constructor() {
    super("Panel service is stopping");
  }
}
class ConfigurationTimeoutError extends Error {
  public constructor() {
    super("Panel configuration timed out");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAXIMUM_BODY_BYTES) throw new InvalidJsonError("Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new InvalidJsonError("Request body must be valid JSON", { cause: error });
  }
}

function setCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (
    origin !== undefined &&
    /^chrome-extension:\/\/[a-p]{32}$/u.test(origin)
  ) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected panel request failure";
}
