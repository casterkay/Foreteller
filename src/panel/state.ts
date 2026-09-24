import type { ForecastAnswer } from "../domain/types.js";
import type { ForecastMarket } from "../forecast/index.js";
import type { PanelMarketSnapshot, PanelSnapshot } from "./types.js";

interface MutablePanelMarket {
  readonly marketId: string;
  readonly term: string;
  polymarketYesPrice: number | null;
  polymarketUpdatedAtMs: number | null;
  jevProbability: number | null;
  jevUpdatedAtMs: number | null;
}

export class PanelState {
  private status: PanelSnapshot["status"] = "idle";
  private mode: PanelSnapshot["mode"] = null;
  private title = "Foreteller";
  private startedAtMs: number | null = null;
  private transcriptUpdatedAtMs: number | null = null;
  private error: string | null = null;
  private comparisonCoverage: PanelSnapshot["comparisonCoverage"] = null;
  private readonly markets = new Map<string, MutablePanelMarket>();
  private readonly retiredMarketIds = new Set<string>();
  private readonly forecastCompletions: number[] = [];

  public begin(
    mode: Exclude<PanelSnapshot["mode"], null>,
    title: string,
    markets: readonly ForecastMarket[],
    startedAtMs: number,
    comparisonCoverage: Exclude<PanelSnapshot["comparisonCoverage"], null>,
  ): void {
    this.status = "starting";
    this.mode = mode;
    this.title = title;
    this.startedAtMs = startedAtMs;
    this.transcriptUpdatedAtMs = null;
    this.error = null;
    this.comparisonCoverage = comparisonCoverage;
    this.markets.clear();
    this.retiredMarketIds.clear();
    this.forecastCompletions.length = 0;
    for (const market of markets) {
      this.markets.set(market.marketId, {
        marketId: market.marketId,
        term: market.term.label,
        polymarketYesPrice: null,
        polymarketUpdatedAtMs: null,
        jevProbability: null,
        jevUpdatedAtMs: null,
      });
    }
  }

  public markLive(): void {
    this.status = "live";
  }

  public recordTranscript(receivedAtMs: number): void {
    this.transcriptUpdatedAtMs = receivedAtMs;
  }

  public recordPrice(marketId: string, price: number | null, receivedAtMs: number): void {
    const market = this.activeMarket(marketId);
    if (market === undefined) return;
    market.polymarketYesPrice = price;
    market.polymarketUpdatedAtMs = receivedAtMs;
  }

  public recordForecasts(forecasts: readonly ForecastAnswer[], completedAtMs: number): void {
    let updated = false;
    for (const forecast of forecasts) {
      const market = this.activeMarket(forecast.marketId);
      if (market === undefined) continue;
      market.jevProbability = forecast.probability;
      market.jevUpdatedAtMs = completedAtMs;
      updated = true;
    }
    if (!updated) return;
    this.forecastCompletions.push(completedAtMs);
    if (this.forecastCompletions.length > 8) this.forecastCompletions.shift();
  }

  public fail(message: string): void {
    this.status = "error";
    this.error = message;
  }

  public end(): void {
    this.status = "ended";
  }

  public removeMarket(marketId: string): void {
    if (!this.markets.delete(marketId)) throw new Error(`Unknown panel market ${marketId}`);
    this.retiredMarketIds.add(marketId);
  }

  public reset(): void {
    this.status = "idle";
    this.mode = null;
    this.title = "Foreteller";
    this.startedAtMs = null;
    this.transcriptUpdatedAtMs = null;
    this.error = null;
    this.comparisonCoverage = null;
    this.markets.clear();
    this.retiredMarketIds.clear();
    this.forecastCompletions.length = 0;
  }

  public snapshot(): PanelSnapshot {
    const markets: readonly PanelMarketSnapshot[] = Object.freeze(
      [...this.markets.values()].map((market) => Object.freeze({ ...market })),
    );
    return Object.freeze({
      status: this.status,
      mode: this.mode,
      title: this.title,
      startedAtMs: this.startedAtMs,
      transcriptUpdatedAtMs: this.transcriptUpdatedAtMs,
      forecastUpdateHz: this.forecastUpdateHz(),
      comparisonCoverage: this.comparisonCoverage,
      markets,
      error: this.error,
    });
  }

  private forecastUpdateHz(): number {
    if (this.forecastCompletions.length < 2) return 0;
    const first = this.forecastCompletions[0];
    const last = this.forecastCompletions.at(-1);
    if (first === undefined || last === undefined || last <= first) return 0;
    return (this.forecastCompletions.length - 1) / ((last - first) / 1_000);
  }

  private activeMarket(marketId: string): MutablePanelMarket | undefined {
    const market = this.markets.get(marketId);
    if (market !== undefined || this.retiredMarketIds.has(marketId)) return market;
    throw new Error(`Unknown panel market ${marketId}`);
  }
}
