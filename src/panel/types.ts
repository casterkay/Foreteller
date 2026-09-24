export interface PanelConfiguration {
  readonly youtubeUrl: string;
  readonly eventUrl: string;
  readonly customTitle: string;
  readonly customTerms: readonly string[];
  readonly speaker: string;
}

export type PanelStatus = "idle" | "starting" | "live" | "ended" | "error";

export interface PanelMarketSnapshot {
  readonly marketId: string;
  readonly term: string;
  readonly polymarketYesPrice: number | null;
  readonly polymarketUpdatedAtMs: number | null;
  readonly jevProbability: number | null;
  readonly jevUpdatedAtMs: number | null;
}

export interface PanelSnapshot {
  readonly status: PanelStatus;
  readonly mode: "event" | "custom" | null;

  /**
   * The live source the single global session is monitoring, so a client can tell
   * whether these forecasts describe the video it is displaying.
   */
  readonly youtubeUrl: string | null;
  readonly title: string;
  readonly startedAtMs: number | null;
  readonly transcriptUpdatedAtMs: number | null;
  readonly forecastUpdateHz: number;
  readonly comparisonCoverage: "full_event" | "partial_event" | "jev_only" | null;
  readonly markets: readonly PanelMarketSnapshot[];
  readonly error: string | null;
}
