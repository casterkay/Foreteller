import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

const executeFile = promisify(execFile);

const metadataSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  channel_id: z.string().min(1),
  channel: z.string().min(1).optional(),
  live_status: z.enum(["is_upcoming", "is_live", "was_live", "not_live", "post_live"]),
  release_timestamp: z.number().optional(),
  timestamp: z.number().optional(),
  duration: z.number().nullable().optional(),
});

export interface YouTubeMetadata {
  readonly videoId: string;
  readonly title: string;
  readonly channelId: string;
  readonly channelName?: string;
  readonly liveStatus:
    | "is_upcoming"
    | "is_live"
    | "was_live"
    | "not_live"
    | "post_live";
  readonly scheduledStartMs?: number;
  readonly durationSeconds?: number;
}

export class YouTubeProbe {
  public constructor(private readonly timeoutMs = 20_000) {}

  public async inspect(url: string): Promise<YouTubeMetadata> {
    const parsedUrl = new URL(url);
    if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
      throw new Error("YouTube URL must use HTTP or HTTPS");
    }

    const { stdout } = await executeFile(
      "yt-dlp",
      ["--dump-single-json", "--no-download", "--no-warnings", url],
      { timeout: this.timeoutMs, maxBuffer: 2 * 1024 * 1024 },
    );
    const metadata = metadataSchema.parse(JSON.parse(stdout) as unknown);
    const startTimestamp = metadata.release_timestamp ?? metadata.timestamp;

    return Object.freeze({
      videoId: metadata.id,
      title: metadata.title,
      channelId: metadata.channel_id,
      ...(metadata.channel === undefined ? {} : { channelName: metadata.channel }),
      liveStatus: metadata.live_status,
      ...(startTimestamp === undefined
        ? {}
        : { scheduledStartMs: startTimestamp * 1_000 }),
      ...(metadata.duration == null ? {} : { durationSeconds: metadata.duration }),
    });
  }
}
