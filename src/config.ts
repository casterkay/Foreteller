import "dotenv/config";

import { resolve } from "node:path";

import { z } from "zod";

const optionalSecret = z.string().trim().min(1).optional();

const environmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: optionalSecret,
  TELEGRAM_OPERATOR_ID: z.coerce.number().int().positive().optional(),
  DEEPGRAM_API_KEY: optionalSecret,
  TYPESAFE_API_KEY: optionalSecret,
  POLYMARKET_PRIVATE_KEY: optionalSecret,
  POLYMARKET_FUNDER_ADDRESS: optionalSecret,
  DATABASE_PATH: z.string().default("./data/foreteller.sqlite"),
  SESSION_DATA_DIR: z.string().default("./data/sessions"),
  LIVE_TRADING: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEEPGRAM_PRIMARY_SPEAKER: z.coerce.number().int().nonnegative().default(0),
});

export interface Limits {
  readonly forecastNotional: number;
  readonly forecastMarketAllowance: number;
  readonly forecastMinimumEdge: number;
  readonly forecastPriceFloor: number;
  readonly forecastPriceCeiling: number;
  readonly forecastCooldownMs: number;
  readonly sniperMarketAllowance: number;
  readonly sniperPriceCap: number;
  readonly sniperSlippage: number;
  readonly sniperCooldownMs: number;
  readonly sniperMaximumAttempts: number;
  readonly minimumWordConfidence: number;
  readonly eventNotionalLimit: number;
  readonly dailyNotionalLimit: number;
  readonly maximumSourceAgeMs: number;
  readonly maximumForecastAgeMs: number;
  readonly minimumForecastIntervalMs: number;
}

export const defaultLimits: Limits = Object.freeze({
  forecastNotional: 5,
  forecastMarketAllowance: 15,
  forecastMinimumEdge: 0.12,
  forecastPriceFloor: 0.05,
  forecastPriceCeiling: 0.9,
  forecastCooldownMs: 60_000,
  sniperMarketAllowance: 20,
  sniperPriceCap: 0.99,
  sniperSlippage: 0.01,
  sniperCooldownMs: 5_000,
  sniperMaximumAttempts: 5,
  minimumWordConfidence: 0.8,
  eventNotionalLimit: 120,
  dailyNotionalLimit: 250,
  maximumSourceAgeMs: 45_000,
  maximumForecastAgeMs: 20_000,
  minimumForecastIntervalMs: 5_000,
});

export interface AppConfig {
  readonly telegramBotToken?: string;
  readonly telegramOperatorId?: number;
  readonly deepgramApiKey?: string;
  readonly typeSafeApiKey?: string;
  readonly polymarketPrivateKey?: string;
  readonly polymarketFunderAddress?: string;
  readonly databasePath: string;
  readonly sessionDataDirectory: string;
  readonly liveTrading: boolean;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly deepgramPrimarySpeaker: number;
  readonly limits: Limits;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);

  if (
    parsed.LIVE_TRADING === "true" &&
    (!parsed.POLYMARKET_PRIVATE_KEY || !parsed.POLYMARKET_FUNDER_ADDRESS)
  ) {
    throw new Error(
      "LIVE_TRADING requires POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS",
    );
  }

  return Object.freeze({
    ...(parsed.TELEGRAM_BOT_TOKEN === undefined
      ? {}
      : { telegramBotToken: parsed.TELEGRAM_BOT_TOKEN }),
    ...(parsed.TELEGRAM_OPERATOR_ID === undefined
      ? {}
      : { telegramOperatorId: parsed.TELEGRAM_OPERATOR_ID }),
    ...(parsed.DEEPGRAM_API_KEY === undefined
      ? {}
      : { deepgramApiKey: parsed.DEEPGRAM_API_KEY }),
    ...(parsed.TYPESAFE_API_KEY === undefined
      ? {}
      : { typeSafeApiKey: parsed.TYPESAFE_API_KEY }),
    ...(parsed.POLYMARKET_PRIVATE_KEY === undefined
      ? {}
      : { polymarketPrivateKey: parsed.POLYMARKET_PRIVATE_KEY }),
    ...(parsed.POLYMARKET_FUNDER_ADDRESS === undefined
      ? {}
      : { polymarketFunderAddress: parsed.POLYMARKET_FUNDER_ADDRESS }),
    databasePath: resolve(parsed.DATABASE_PATH),
    sessionDataDirectory: resolve(parsed.SESSION_DATA_DIR),
    liveTrading: parsed.LIVE_TRADING === "true",
    logLevel: parsed.LOG_LEVEL,
    deepgramPrimarySpeaker: parsed.DEEPGRAM_PRIMARY_SPEAKER,
    limits: defaultLimits,
  });
}
