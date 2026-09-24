import { describe, expect, it, vi } from "vitest";

import { SessionController, type SessionJournal, type SessionRuntime } from "../../src/control/session.js";
import type { EventProposal } from "../../src/control/proposal.js";
import type { SessionBinding } from "../../src/domain/types.js";
import type { YouTubeMetadata } from "../../src/media/youtube.js";

const timestamp = Date.UTC(2026, 8, 22, 12);

describe("SessionController", () => {
  it("rechecks rules before persisting and starting a confirmed session", async () => {
    const journal = new Journal();
    const runtime = runtimeStub();
    const proposer = {
      propose: vi.fn()
        .mockResolvedValueOnce(proposal("first"))
        .mockResolvedValueOnce(proposal("first")),
    };
    const controller = controllerFor({ journal, runtime, proposer });

    await expect(controller.watch("event-1", "https://youtube.test/live", "Jane Doe"))
      .resolves.toContain("Alpha");
    await expect(controller.confirm()).resolves.toContain("Session confirmed");

    expect(journal.statuses).toEqual(["waiting"]);
    expect(journal.bindings).toHaveLength(1);
    expect(journal.bindings[0]?.speaker).toBe("Jane Doe");
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ rulesHash: "first" }));
    await expect(controller.status()).resolves.toContain("waiting");
    await expect(controller.halt()).resolves.toBe("Session halted.");
    expect(journal.statuses).toEqual(["waiting", "halted"]);
    expect(runtime.halt).toHaveBeenCalledOnce();
  });

  it("invalidates a draft when venue rules change before confirmation", async () => {
    const journal = new Journal();
    const runtime = runtimeStub();
    const proposer = {
      propose: vi.fn()
        .mockResolvedValueOnce(proposal("first"))
        .mockResolvedValueOnce(proposal("changed")),
    };
    const controller = controllerFor({ journal, runtime, proposer });

    await controller.watch("event-1", "https://youtube.test/live", "Jane Doe");
    await expect(controller.confirm()).rejects.toThrow(/rules changed/);

    expect(journal.statuses).toEqual([]);
    expect(runtime.start).not.toHaveBeenCalled();
    await expect(controller.status()).resolves.toBe("No draft or active session.");
  });

  it("does not accept recorded video as a live feed", async () => {
    const controller = controllerFor({
      journal: new Journal(),
      runtime: runtimeStub(),
      proposer: { propose: async () => proposal("first") },
      video: { ...video(), liveStatus: "was_live" },
    });

    await expect(controller.watch("event-1", "https://youtube.test/live", "Jane Doe"))
      .rejects.toThrow(/live or upcoming/);
  });

  it("does not accept an event after its qualifying window", async () => {
    const expired = {
      ...proposal("first"),
      expectedEndMs: timestamp,
    };
    const controller = controllerFor({
      journal: new Journal(),
      runtime: runtimeStub(),
      proposer: { propose: async () => expired },
    });

    await expect(controller.watch("event-1", "https://youtube.test/live", "Jane Doe"))
      .rejects.toThrow(/window has ended/);
  });

  it("journals live state and releases a naturally ended session", async () => {
    const journal = new Journal();
    const runtime = runtimeStub();
    runtime.status
      .mockResolvedValueOnce("live")
      .mockResolvedValueOnce("ended");
    const proposer = { propose: vi.fn(async () => proposal("first")) };
    const controller = controllerFor({ journal, runtime, proposer });

    await controller.watch("event-1", "https://youtube.test/live", "Jane Doe");
    await controller.confirm();
    await expect(controller.status()).resolves.toContain("live");

    await expect(controller.watch("event-2", "https://youtube.test/next", "Jane Doe"))
      .resolves.toContain("Draft ready");
    expect(journal.statuses).toEqual(["waiting", "live", "ended"]);
  });
});

function controllerFor({
  journal,
  runtime,
  proposer,
  video: videoMetadata = video(),
}: {
  readonly journal: SessionJournal;
  readonly runtime: SessionRuntime;
  readonly proposer: { propose(eventId: string): Promise<EventProposal> };
  readonly video?: YouTubeMetadata;
}): SessionController {
  return new SessionController({
    journal,
    runtime,
    proposer,
    videoInspector: { inspect: async () => videoMetadata },
    clock: { now: () => timestamp },
    createSessionId: () => "session-1",
  });
}

function proposal(rulesHash: string): EventProposal {
  return {
    eventId: "event-1",
    eventTitle: "Speech",
    expectedStartMs: timestamp,
    expectedEndMs: timestamp + 60_000,
    rulesHash,
    markets: [
      {
        eventId: "event-1",
        marketId: "market-1",
        question: "Will the speaker say Alpha?",
        description: "Single mention.",
        yesTokenId: "yes-token",
        noTokenId: "no-token",
        tickSize: 0.01,
        minimumOrderSize: 1,
        negRisk: false,
        acceptingOrders: true,
        feeRate: 0,
        term: {
          marketId: "market-1",
          label: "Alpha",
          acceptedForms: ["Alpha"],
          excludedForms: [],
          speakerScope: "primary",
          windowStartMs: timestamp,
          windowEndMs: timestamp + 60_000,
          mentionThreshold: 1,
        },
      },
    ],
  };
}

function video(): YouTubeMetadata {
  return {
    videoId: "video-1",
    title: "Live stream",
    channelId: "channel-1",
    liveStatus: "is_live",
  };
}

function runtimeStub(): SessionRuntime & {
  readonly start: ReturnType<typeof vi.fn<(binding: SessionBinding) => Promise<void>>>;
  readonly halt: ReturnType<typeof vi.fn<(binding: SessionBinding) => Promise<void>>>;
  readonly status: ReturnType<typeof vi.fn<(binding: SessionBinding) => Promise<"waiting" | "live" | "halted" | "ended">>>;
} {
  return {
    start: vi.fn(async () => undefined),
    halt: vi.fn(async () => undefined),
    status: vi.fn(async () => "waiting"),
  };
}

class Journal implements SessionJournal {
  public readonly statuses: string[] = [];
  public readonly bindings: SessionBinding[] = [];

  public recordSession(_sessionId: string, status: "draft" | "waiting" | "live" | "halted" | "ended"): void {
    this.statuses.push(status);
  }

  public recordSessionStatus(
    _sessionId: string,
    status: "draft" | "waiting" | "live" | "halted" | "ended",
  ): void {
    this.statuses.push(status);
  }

  public recordBinding(binding: SessionBinding): void {
    this.bindings.push(binding);
  }
}
