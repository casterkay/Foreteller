import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createPublicClient } from "@polymarket/client";
import { TypeSafeClient } from "@typesafe-ai/sdk";

import type { AppConfig } from "./config.js";
import { withTimeout } from "./core/async.js";
import { createPolymarketVenueTrader } from "./execution/polymarket.js";

const executeFile = promisify(execFile);

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly required: boolean;
}

export async function runDoctor(config: AppConfig): Promise<readonly DoctorCheck[]> {
  const checks = await Promise.all([
    checkBinary("yt-dlp", ["--version"]),
    checkBinary("ffmpeg", ["-version"]),
    checkPolymarket(),
    checkTypeSafe(config),
    checkWallet(config),
    Promise.resolve(checkConfiguration(config)),
  ]);
  return Object.freeze(checks);
}

async function checkWallet(config: AppConfig): Promise<DoctorCheck> {
  if (!config.liveTrading) {
    return {
      name: "wallet",
      ok: true,
      detail: "skipped in dry-run mode",
      required: false,
    };
  }
  try {
    const trader = await createPolymarketVenueTrader(config);
    const status = await withTimeout(
      () => trader.accountStatus(),
      10_000,
      "wallet check",
    );
    const allowancesReady = status.allowances.length > 0 && status.allowances.every((value) => value > 0);
    return {
      name: "wallet",
      ok: status.balance > 0 && allowancesReady,
      detail: `$${status.balance.toFixed(2)} collateral; ${String(status.allowances.length)} allowance(s)${allowancesReady ? " ready" : " missing"}`,
      required: true,
    };
  } catch (error) {
    return {
      name: "wallet",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: true,
    };
  }
}

async function checkBinary(
  command: string,
  arguments_: readonly string[],
): Promise<DoctorCheck> {
  try {
    const { stdout } = await executeFile(command, [...arguments_], { timeout: 5_000 });
    const firstLine = stdout.trim().split("\n", 1)[0] ?? "available";
    return { name: command, ok: true, detail: firstLine, required: true };
  } catch (error) {
    return {
      name: command,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: true,
    };
  }
}

async function checkPolymarket(): Promise<DoctorCheck> {
  try {
    const client = createPublicClient();
    const page = await withTimeout(
      () =>
        client
          .listEvents({ closed: false, pageSize: 1, tagSlug: "mention-markets" })
          .firstPage(),
      10_000,
      "Polymarket check",
    );
    return {
      name: "polymarket",
      ok: true,
      detail: `${page.items.length} Mentions event fetched`,
      required: true,
    };
  } catch (error) {
    return {
      name: "polymarket",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: true,
    };
  }
}

async function checkTypeSafe(config: AppConfig): Promise<DoctorCheck> {
  if (!config.typeSafeApiKey) {
    return {
      name: "typesafe",
      ok: false,
      detail: "TYPESAFE_API_KEY is not configured",
      required: true,
    };
  }

  try {
    const client = new TypeSafeClient({ apiKey: config.typeSafeApiKey, timeout: 10_000 });
    const models = await client.models.list({ timeout: 10_000 });
    return {
      name: "typesafe",
      ok: models.length > 0,
      detail: `${models.length} model(s) available`,
      required: true,
    };
  } catch (error) {
    return {
      name: "typesafe",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: true,
    };
  }
}

function checkConfiguration(config: AppConfig): DoctorCheck {
  const missing = [
    ["TELEGRAM_BOT_TOKEN", config.telegramBotToken],
    ["TELEGRAM_OPERATOR_ID", config.telegramOperatorId],
    ["DEEPGRAM_API_KEY", config.deepgramApiKey],
  ]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  return {
    name: "configuration",
    ok: missing.length === 0,
    detail: missing.length === 0 ? "operator services configured" : `missing ${missing.join(", ")}`,
    required: true,
  };
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  return checks
    .map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`)
    .join("\n");
}
