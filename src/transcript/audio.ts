import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";

const executeFile = promisify(execFile);

export interface AudioChunk {
  readonly data: Uint8Array;
  readonly receivedAtMs: number;
  readonly sourceTimestampMs: number | null;
  readonly sourceAgeMs: number | null;
}

export interface AudioSource {
  run(
    onChunk: (chunk: AudioChunk) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface YoutubeAudioSourceOptions {
  readonly videoUrl: string;
  readonly ytDlpPath?: string;
  readonly ffmpegPath?: string;
  readonly archivePath?: string;
  readonly clock?: Clock;
}

function processFailure(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const status = signal === null ? `code ${String(code)}` : `signal ${signal}`;
  const detail = stderr.trim();
  return new Error(
    `${command} exited with ${status}${detail.length === 0 ? "" : `: ${detail}`}`,
  );
}

function appendTail(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-4_096);
}

function stop(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000);
    forceKill.unref();
  }
}

export class YoutubeAudioSource implements AudioSource {
  readonly #videoUrl: string;
  readonly #ytDlpPath: string;
  readonly #ffmpegPath: string;
  readonly #clock: Clock;
  readonly #archivePath: string | undefined;

  constructor(options: YoutubeAudioSourceOptions) {
    this.#videoUrl = options.videoUrl;
    this.#ytDlpPath = options.ytDlpPath ?? "yt-dlp";
    this.#ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.#clock = options.clock ?? systemClock;
    this.#archivePath = options.archivePath;
  }

  async run(
    onChunk: (chunk: AudioChunk) => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.#archivePath !== undefined) {
      await mkdir(dirname(this.#archivePath), { recursive: true });
    }

    const { stdout } = await executeFile(
      this.#ytDlpPath,
      [
        "--no-playlist",
        "--quiet",
        "-f",
        "bestaudio/best[height<=480]/best",
        "--get-url",
        this.#videoUrl,
      ],
      { timeout: 20_000, maxBuffer: 64 * 1024, signal },
    );
    const mediaUrls = stdout.split("\n").map((value) => value.trim()).filter(Boolean);
    if (mediaUrls.length !== 1) {
      throw new Error("yt-dlp did not resolve exactly one media URL");
    }
    const mediaUrl = mediaUrls[0];
    if (mediaUrl === undefined) throw new Error("yt-dlp did not resolve a media URL");

    const ffmpegArguments = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-allowed_extensions",
      "ALL",
      "-i",
      mediaUrl,
      "-vn",
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "pipe:1",
      ...(this.#archivePath === undefined
        ? []
        : ["-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "flac", "-n", this.#archivePath]),
    ];
    const ffmpeg = spawn(
      this.#ffmpegPath,
      ffmpegArguments,
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      let ffmpegStderr = "";

      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        failure ??= error;
        stop(ffmpeg);
      };
      const onAbort = (): void => {
        stop(ffmpeg);
      };

      signal.addEventListener("abort", onAbort, { once: true });
      ffmpeg.stderr.on("data", (chunk: Buffer) => {
        ffmpegStderr = appendTail(ffmpegStderr, chunk);
      });
      ffmpeg.stdout.on("data", (data: Buffer) => {
        try {
          onChunk(
            Object.freeze({
              data: new Uint8Array(data),
              receivedAtMs: this.#clock.now(),
              sourceTimestampMs: null,
              sourceAgeMs: null,
            }),
          );
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new Error("Audio chunk consumer failed", { cause: error }),
          );
        }
      });
      ffmpeg.on("error", fail);
      ffmpeg.on("close", (code, processSignal) => {
        cleanup();
        if (!signal.aborted && code !== 0) {
          reject(processFailure(this.#ffmpegPath, code, processSignal, ffmpegStderr));
        } else if (failure !== undefined) {
          reject(failure);
        } else if (signal.aborted) {
          reject(signal.reason);
        } else {
          resolve();
        }
      });
    });
  }
}
