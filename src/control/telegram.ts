import { Bot, type Context } from "grammy";

import type { Logger } from "../core/log.js";

export interface OperatorCommands {
  watch(eventId: string, videoUrl: string): Promise<string>;
  confirm(): Promise<string>;
  halt(): Promise<string>;
  status(): Promise<string>;
}

export function createOperatorBot(
  token: string,
  operatorId: number,
  commands: OperatorCommands,
  logger: Logger,
): Bot {
  const bot = new Bot(token);

  bot.use(async (context, next) => {
    if (context.from?.id !== operatorId) {
      logger.warn("Ignored Telegram update from unauthorized user", {
        userId: context.from?.id,
      });
      return;
    }
    await next();
  });

  bot.command("watch", async (context) => {
    const [eventId, videoUrl, ...extra] = commandArguments(context);
    if (!eventId || !videoUrl || extra.length > 0) {
      await context.reply("Usage: /watch <event_id> <youtube_url>");
      return;
    }
    await replyWithResult(context, () => commands.watch(eventId, videoUrl));
  });

  bot.command("go", async (context) => {
    await replyWithResult(context, () => commands.confirm());
  });
  bot.command("halt", async (context) => {
    await replyWithResult(context, () => commands.halt());
  });
  bot.command("status", async (context) => {
    await replyWithResult(context, () => commands.status());
  });
  bot.command("start", async (context) => {
    await context.reply(
      "Commands: /watch <event_id> <youtube_url>, /go, /status, /halt",
    );
  });

  bot.catch((error) => {
    logger.error("Telegram bot update failed", {
      updateId: error.ctx.update.update_id,
      error: error.error instanceof Error ? error.error.message : String(error.error),
    });
  });

  return bot;
}

function commandArguments(context: Context): string[] {
  const match = context.match;
  const text = typeof match === "string" ? match : "";
  return text.trim().split(/\s+/u).filter(Boolean);
}

async function replyWithResult(
  context: Context,
  operation: () => Promise<string>,
): Promise<void> {
  try {
    await context.reply(await operation());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    await context.reply(`Unable to complete command: ${message}`);
  }
}
