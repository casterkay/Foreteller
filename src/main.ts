import { loadConfig } from "./config.js";
import { PolymarketEventProposer, SessionController, createOperatorBot } from "./control/index.js";
import { createLogger } from "./core/log.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import {
  DisabledVenueTrader,
  SerializedExecutor,
  createPolymarketVenueTrader,
} from "./execution/index.js";
import { JevForecaster } from "./forecast/index.js";
import { createPolymarketReadClient } from "./market/polymarket.js";
import { createPolymarketSubscriptionClient } from "./market/subscription.js";
import { YouTubeProbe } from "./media/youtube.js";
import { PanelRuntime, PanelServer, PanelState } from "./panel/index.js";
import { formatReplayReport, formatSessionReport } from "./report.js";
import { LiveSessionRuntime, type BindingVerifier } from "./runtime/index.js";
import { SqliteStore } from "./storage/index.js";
import { DeepgramStreamingTranscriber } from "./transcript/index.js";

const command = process.argv[2] ?? "serve";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (command === "doctor") {
    const checks = await runDoctor(config);
    process.stdout.write(`${formatDoctorReport(checks)}\n`);
    process.exitCode = checks.every((check) => check.ok || !check.required) ? 0 : 1;
    return;
  }

  if (command === "report" || command === "replay") {
    const store = new SqliteStore(config.databasePath);
    try {
      const sessionId = process.argv[3];
      const output = command === "report"
        ? formatSessionReport(store, sessionId)
        : formatReplayReport(store, sessionId);
      process.stdout.write(`${output}\n`);
    } finally {
      store.close();
    }
    return;
  }

  if (command === "panel") {
    await runPanel(config, logger);
    return;
  }

  if (command !== "serve") {
    throw new Error("Usage: foreteller <serve|panel|doctor|report [session_id]|replay [session_id]>");
  }

  await serve(config, logger);
}

async function serve(
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  if (config.telegramBotToken === undefined || config.telegramOperatorId === undefined) {
    throw new Error("serve requires TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_ID");
  }
  if (config.deepgramApiKey === undefined || config.typeSafeApiKey === undefined) {
    throw new Error("serve requires DEEPGRAM_API_KEY and TYPESAFE_API_KEY");
  }

  const store = new SqliteStore(config.databasePath);
  const readClient = createPolymarketReadClient();
  const proposer = new PolymarketEventProposer(readClient);
  const videoProbe = new YouTubeProbe();
  const panelServer = createPanelServer(config, logger, proposer, videoProbe);
  const trader = config.liveTrading
    ? await createPolymarketVenueTrader(config)
    : new DisabledVenueTrader();
  const executor = new SerializedExecutor(store, trader, {
    liveTrading: config.liveTrading,
    requestTimeoutMs: 10_000,
    limits: {
      dailyNotionalLimit: config.limits.dailyNotionalLimit,
      eventNotionalLimit: config.limits.eventNotionalLimit,
      forecastMarketAllowance: config.limits.forecastMarketAllowance,
      sniperMarketAllowance: config.limits.sniperMarketAllowance,
      maximumSourceAgeMs: config.limits.maximumSourceAgeMs,
    },
  });
  await executor.reconcileStartup();
  executor.halt();
  const verifier: BindingVerifier = {
    verify: async (binding) => {
      const proposal = await proposer.propose(binding.eventId);
      return proposal.rulesHash === binding.rulesHash &&
        proposal.markets.every((market) => market.acceptingOrders);
    },
  };
  const runtime = new LiveSessionRuntime({
    store,
    subscriberClient: createPolymarketSubscriptionClient(),
    videoProbe,
    transcriber: new DeepgramStreamingTranscriber({ apiKey: config.deepgramApiKey }),
    mentionCountCoverageGraceMs: 15_000,
    sourceMaximumReconnects: config.sourceMaximumReconnects,
    sourceReconnectBaseDelayMs: config.sourceReconnectBaseDelayMs,
    forecaster: new JevForecaster({
      apiKey: config.typeSafeApiKey,
      timeoutMs: 15_000,
      maximumForecastAgeMs: config.limits.maximumForecastAgeMs,
      transcriptMaximumWords: config.transcriptMaximumWords,
    }),
    executor,
    verifier,
    limits: config.limits,
    logger,
    liveTrading: config.liveTrading,
    sessionDataDirectory: config.sessionDataDirectory,
  });
  const recoverable = store.recoverableSession();
  if (recoverable !== undefined) {
    store.recordSessionStatus(recoverable.binding.sessionId, "waiting", Date.now());
    await runtime.start(recoverable.binding);
    logger.info("Recovered persisted session", {
      sessionId: recoverable.binding.sessionId,
      previousStatus: recoverable.status,
    });
  }
  const controller = new SessionController({
    proposer,
    videoInspector: videoProbe,
    journal: store,
    runtime,
    primarySpeaker: config.deepgramPrimarySpeaker,
    ...(recoverable === undefined ? {} : { initialBinding: recoverable.binding }),
  });
  const bot = createOperatorBot(
    config.telegramBotToken,
    config.telegramOperatorId,
    controller,
    logger,
  );

  await panelServer.start();

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Stopping Foreteller", { reason });
    bot.stop();

    // A failure in one teardown step must not orphan the remaining resources.
    try {
      await panelServer.stop();
    } finally {
      try {
        await runtime.shutdown();
      } finally {
        store.close();
      }
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Foreteller operator service started", {
    liveTrading: config.liveTrading,
    audioAgeBasis: "pipeline clock unless the source provides wall-clock timestamps",
    primarySpeaker: config.deepgramPrimarySpeaker,
    panelServer: `http://127.0.0.1:${String(config.panelServerPort)}`,
  });
  try {
    await bot.start();
  } finally {
    await shutdown("bot stopped");
  }
}

async function runPanel(
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  if (config.deepgramApiKey === undefined || config.typeSafeApiKey === undefined) {
    throw new Error("panel requires DEEPGRAM_API_KEY and TYPESAFE_API_KEY");
  }
  const panelServer = createPanelServer(
    config,
    logger,
    new PolymarketEventProposer(createPolymarketReadClient()),
    new YouTubeProbe(),
  );
  await panelServer.start();
  logger.info("Foreteller panel service started", {
    address: `http://127.0.0.1:${String(config.panelServerPort)}`,
  });
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await panelServer.stop();
}

function createPanelServer(
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>,
  proposer: PolymarketEventProposer,
  videoProbe: YouTubeProbe,
): PanelServer {
  if (config.deepgramApiKey === undefined || config.typeSafeApiKey === undefined) {
    throw new Error("panel service requires DEEPGRAM_API_KEY and TYPESAFE_API_KEY");
  }
  const state = new PanelState();
  const runtime = new PanelRuntime({
    state,
    proposer,
    videoProbe,
    transcriber: new DeepgramStreamingTranscriber({ apiKey: config.deepgramApiKey }),
    forecaster: new JevForecaster({
      apiKey: config.typeSafeApiKey,
      timeoutMs: 15_000,
      maximumForecastAgeMs: config.limits.maximumForecastAgeMs,
      transcriptMaximumWords: config.transcriptMaximumWords,
    }),
    subscriberClient: createPolymarketSubscriptionClient(),
    logger,
    minimumWordConfidence: config.limits.minimumWordConfidence,
    primarySpeaker: config.deepgramPrimarySpeaker,
  });
  return new PanelServer({
    runtime,
    state,
    logger,
    port: config.panelServerPort,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
