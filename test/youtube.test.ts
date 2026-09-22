import { describe, expect, it } from "vitest";

import { YouTubeProbe } from "../src/media/youtube.js";

describe("YouTubeProbe", () => {
  it("rejects non-HTTP input before running yt-dlp", async () => {
    await expect(new YouTubeProbe().inspect("file:///tmp/audio.mp3")).rejects.toThrow(
      /HTTP/,
    );
  });
});
