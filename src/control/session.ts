import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { SessionBinding, SessionStatus } from "../domain/types.js";
import type { YouTubeMetadata } from "../media/youtube.js";
import type { EventProposal } from "./proposal.js";
import type { OperatorCommands } from "./telegram.js";

export interface EventProposer {
  propose(eventId: string): Promise<EventProposal>;
}

export interface VideoInspector {
  inspect(videoUrl: string): Promise<YouTubeMetadata>;
}

export interface SessionJournal {
  recordSession(sessionId: string, status: SessionStatus, occurredAtMs: number): void;
  recordSessionStatus(sessionId: string, status: SessionStatus, occurredAtMs: number): void;
  recordBinding(binding: SessionBinding): void;
}

export interface SessionRuntime {
  start(binding: SessionBinding): Promise<void>;
  halt(binding: SessionBinding): Promise<void>;
  status(binding: SessionBinding): Promise<Exclude<SessionStatus, "draft">>;
}

export interface SessionControllerDependencies {
  readonly proposer: EventProposer;
  readonly videoInspector: VideoInspector;
  readonly journal: SessionJournal;
  readonly runtime: SessionRuntime;
  readonly clock?: Clock;
  readonly createSessionId?: () => string;
  readonly primarySpeaker?: number;
  readonly initialBinding?: SessionBinding;
}

interface DraftSession {
  readonly eventId: string;
  readonly videoUrl: string;
  readonly speaker: string;
  readonly video: YouTubeMetadata;
  readonly proposal: EventProposal;
}

export class SessionController implements OperatorCommands {
  private readonly clock: Clock;
  private readonly createSessionId: () => string;
  private operationTail: Promise<void> = Promise.resolve();
  private draft: DraftSession | undefined;
  private active:
    | { readonly binding: SessionBinding; readonly status: "waiting" | "live" | "halted" }
    | undefined;

  public constructor(private readonly dependencies: SessionControllerDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.createSessionId = dependencies.createSessionId ?? randomUUID;
    if (dependencies.initialBinding !== undefined) {
      this.active = Object.freeze({
        binding: dependencies.initialBinding,
        status: "waiting",
      });
    }
  }

  public watch(eventId: string, videoUrl: string, speaker: string): Promise<string> {
    return this.runExclusive(async () => {
      await this.refreshActive();
      if (this.active !== undefined) {
        throw new Error("A session is still active or halting");
      }
      const confirmedSpeaker = requireText(speaker, "speaker name");
      const [video, proposal] = await Promise.all([
        this.dependencies.videoInspector.inspect(videoUrl),
        this.dependencies.proposer.propose(eventId),
      ]);
      validateLiveVideo(video);
      this.draft = Object.freeze({
        eventId,
        videoUrl,
        speaker: confirmedSpeaker,
        video,
        proposal,
      });
      return formatDraft(this.draft);
    });
  }

  public confirm(): Promise<string> {
    return this.runExclusive(async () => {
      await this.refreshActive();
      if (this.active !== undefined) throw new Error("A session is already active or halting");
      const draft = this.draft;
      if (draft === undefined) throw new Error("No draft session. Run /watch first");

      const currentProposal = await this.dependencies.proposer.propose(draft.eventId);
      if (currentProposal.rulesHash !== draft.proposal.rulesHash) {
        this.draft = undefined;
        throw new Error("Event rules changed. Review a new draft with /watch");
      }

      const confirmedAtMs = this.clock.now();
      const binding = Object.freeze({
        sessionId: this.createSessionId(),
        eventId: currentProposal.eventId,
        eventTitle: currentProposal.eventTitle,
        rulesHash: currentProposal.rulesHash,
        videoUrl: draft.videoUrl,
        videoId: draft.video.videoId,
        channelId: draft.video.channelId,
        speaker: draft.speaker,
        primarySpeaker: this.dependencies.primarySpeaker ?? 0,
        expectedStartMs: currentProposal.expectedStartMs,
        expectedEndMs: currentProposal.expectedEndMs,
        markets: currentProposal.markets,
        confirmedAtMs,
      });

      this.dependencies.journal.recordSession(binding.sessionId, "waiting", confirmedAtMs);
      this.dependencies.journal.recordBinding(binding);
      this.active = Object.freeze({ binding, status: "waiting" });
      this.draft = undefined;

      try {
        await this.dependencies.runtime.start(binding);
      } catch (error) {
        this.dependencies.journal.recordSessionStatus(binding.sessionId, "halted", this.clock.now());
        this.active = Object.freeze({ binding, status: "halted" });
        try {
          await this.dependencies.runtime.halt(binding);
        } catch (haltError) {
          throw new Error(
            `Session start failed and halt needs attention: ${errorMessage(error)}; ${errorMessage(haltError)}`,
          );
        }
        this.active = undefined;
        throw new Error(`Session start failed and was halted: ${errorMessage(error)}`);
      }
      return `Session confirmed for ${binding.eventTitle}; waiting for the feed window.`;
    });
  }

  public halt(): Promise<string> {
    return this.runExclusive(async () => {
      await this.refreshActive();
      if (this.active === undefined) {
        if (this.draft === undefined) return "No draft or active session.";
        this.draft = undefined;
        return "Draft discarded.";
      }

      const active = this.active;
      if (active.status !== "halted") {
        this.dependencies.journal.recordSessionStatus(active.binding.sessionId, "halted", this.clock.now());
        this.active = Object.freeze({ binding: active.binding, status: "halted" });
      }
      try {
        await this.dependencies.runtime.halt(active.binding);
      } catch (error) {
        throw new Error(`Halt recorded, but workers still need attention: ${errorMessage(error)}`);
      }
      this.active = undefined;
      return "Session halted.";
    });
  }

  public status(): Promise<string> {
    return this.runExclusive(async () => {
      const completedStatus = await this.refreshActive();
      if (this.active !== undefined) {
        return this.active.status === "halted"
          ? `Halt requested for ${this.active.binding.eventTitle}.`
          : `Watching ${this.active.binding.eventTitle}; session is ${this.active.status}.`;
      }
      if (completedStatus === "ended") return "Session ended.";
      if (completedStatus === "halted") return "Session halted.";
      if (this.draft !== undefined) return `Draft ready for ${this.draft.proposal.eventTitle}; send /go to confirm.`;
      return "No draft or active session.";
    });
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async refreshActive(): Promise<"halted" | "ended" | undefined> {
    const active = this.active;
    if (active === undefined) return undefined;

    const status = await this.dependencies.runtime.status(active.binding);
    if (status !== active.status) {
      this.dependencies.journal.recordSessionStatus(active.binding.sessionId, status, this.clock.now());
    }
    if (status === "halted" || status === "ended") {
      this.active = undefined;
      return status;
    }
    this.active = Object.freeze({ binding: active.binding, status });
    return undefined;
  }
}

function validateLiveVideo(video: YouTubeMetadata): void {
  if (video.liveStatus !== "is_live" && video.liveStatus !== "is_upcoming") {
    throw new Error("YouTube video must be live or upcoming");
  }
}

function formatDraft(draft: DraftSession): string {
  const channel = draft.video.channelName ?? "confirmed channel";
  const start = new Date(draft.proposal.expectedStartMs).toISOString();
  const end = new Date(draft.proposal.expectedEndMs).toISOString();
  const terms = draft.proposal.markets.map((market) => {
    const accepted = market.term.acceptedForms.join(" / ");
    const excluded = market.term.excludedForms.length === 0
      ? "none"
      : market.term.excludedForms.join(" / ");
    return `${market.term.label} [accepted: ${accepted}; excluded: ${excluded}; scope: ${market.term.speakerScope}]`;
  }).join("\n");
  const message = `Draft ready: ${draft.proposal.eventTitle}.\nFeed: ${draft.video.title} (${channel}).\nSpeaker: ${draft.speaker}.\nWindow: ${start} to ${end}.\nTerms (${String(draft.proposal.markets.length)}):\n${terms}\nSend /go to confirm these exact rules.`;
  if (message.length > 4_000) {
    throw new Error("Event has too many terms for a reviewable Telegram draft");
  }
  return message;
}

function requireText(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} is required`);
  return trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unexpected failure";
}
