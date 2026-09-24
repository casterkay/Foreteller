import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { YoutubeAudioSource } from "../../src/transcript/audio.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));
vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
}));

class FakeFfmpegProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(_signal?: NodeJS.Signals): boolean {
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

const processes: FakeFfmpegProcess[] = [];
const spawnArguments: string[][] = [];

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined);
  mocks.execFile.mockReset();
  mocks.spawn.mockReset();
  processes.length = 0;
  spawnArguments.length = 0;

  let urlCount = 0;
  mocks.execFile.mockImplementation((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: null, result: { stdout: string; stderr: string }) => void,
  ) => {
    urlCount += 1;
    callback(null, { stdout: `https://media.example/url-${urlCount}`, stderr: "" });
  });
  mocks.spawn.mockImplementation((_path: string, args: string[]) => {
    const process = new FakeFfmpegProcess();
    processes.push(process);
    spawnArguments.push(args);
    return process;
  });
});

describe("YoutubeAudioSource", () => {
  it("reconnects after a transient drop and reports a gap", async () => {
    const source = new YoutubeAudioSource({
      videoUrl: "https://youtube.test/live",
      archivePath: "/tmp/archive/audio.flac",
      maximumReconnects: 1,
      reconnectBaseDelayMs: 0,
    });
    const onDiscontinuity = vi.fn();
    const runPromise = source.run(vi.fn(), new AbortController().signal, onDiscontinuity);

    await vi.waitFor(() => expect(processes).toHaveLength(1));
    expect(onDiscontinuity).not.toHaveBeenCalled();

    processes[0]!.stderr.emit("data", Buffer.from("Stream ends prematurely"));
    processes[0]!.exit(255, null);

    await vi.waitFor(() => expect(processes).toHaveLength(2));
    expect(onDiscontinuity).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    expect(archivePathFrom(spawnArguments[0]!)).toBe("/tmp/archive/audio.flac");
    expect(archivePathFrom(spawnArguments[1]!)).toBe("/tmp/archive/audio-attempt-2.flac");

    processes[1]!.exit(0, null);
    await expect(runPromise).resolves.toBeUndefined();
  });

  it("rethrows once reconnects are exhausted", async () => {
    const source = new YoutubeAudioSource({
      videoUrl: "https://youtube.test/live",
      maximumReconnects: 2,
      reconnectBaseDelayMs: 0,
    });
    const runPromise = source.run(vi.fn(), new AbortController().signal);

    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.exit(255, null);
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    processes[1]!.exit(255, null);
    await vi.waitFor(() => expect(processes).toHaveLength(3));
    processes[2]!.exit(255, null);

    await expect(runPromise).rejects.toThrow(/exited with code 255/);
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
    expect(mocks.spawn).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once the signal is aborted", async () => {
    const controller = new AbortController();
    const source = new YoutubeAudioSource({
      videoUrl: "https://youtube.test/live",
      maximumReconnects: 5,
      reconnectBaseDelayMs: 1_000,
    });
    const runPromise = source.run(vi.fn(), controller.signal);

    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.exit(255, null);
    controller.abort();

    await expect(runPromise).rejects.toBeTruthy();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});

function archivePathFrom(args: string[]): string | undefined {
  const index = args.indexOf("-n");
  return index === -1 ? undefined : args[index + 1];
}
