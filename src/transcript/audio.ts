import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";

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

function stop(process: ChildProcess): void {
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (process.exitCode === null && process.signalCode === null) {
        process.kill("SIGKILL");
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

    const ytDlp = spawn(
      this.#ytDlpPath,
      ["--no-playlist", "--quiet", "-f", "bestaudio", "-o", "-", this.#videoUrl],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const ffmpegArguments = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
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
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    ytDlp.stdout.pipe(ffmpeg.stdin);

    await new Promise<void>((resolve, reject) => {
      let ytDlpClosed = false;
      let ffmpegClosed = false;
      let failure: Error | undefined;
      let ytDlpStderr = "";
      let ffmpegStderr = "";

      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        ytDlp.stdout.unpipe(ffmpeg.stdin);
      };
      const finish = (): void => {
        if (!ytDlpClosed || !ffmpegClosed) return;
        cleanup();
        if (failure !== undefined) reject(failure);
        else if (signal.aborted) reject(signal.reason);
        else resolve();
      };
      const fail = (error: Error): void => {
        failure ??= error;
        stop(ytDlp);
        stop(ffmpeg);
      };
      const onAbort = (): void => {
        stop(ytDlp);
        stop(ffmpeg);
      };

      signal.addEventListener("abort", onAbort, { once: true });
      ytDlp.stderr.on("data", (chunk: Buffer) => {
        ytDlpStderr = appendTail(ytDlpStderr, chunk);
      });
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
      ytDlp.on("error", fail);
      ffmpeg.on("error", fail);
      ytDlp.on("close", (code, processSignal) => {
        ytDlpClosed = true;
        if (!signal.aborted && code !== 0) {
          fail(processFailure(this.#ytDlpPath, code, processSignal, ytDlpStderr));
        }
        finish();
      });
      ffmpeg.on("close", (code, processSignal) => {
        ffmpegClosed = true;
        if (!signal.aborted && code !== 0) {
          fail(processFailure(this.#ffmpegPath, code, processSignal, ffmpegStderr));
        } else if (!ytDlpClosed) {
          stop(ytDlp);
        }
        finish();
      });
    });
  }
}
