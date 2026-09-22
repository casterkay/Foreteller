import type {
  FakMarketBuy,
  VenueOrderReference,
  VenueOrderResult,
  VenueTrader,
} from "./executor.js";

export class DisabledVenueTrader implements VenueTrader {
  public availableBalance(): Promise<number> {
    return Promise.resolve(0);
  }

  public submitFakMarketBuy(_order: FakMarketBuy): Promise<VenueOrderResult> {
    return Promise.reject(new Error("venue submission is disabled"));
  }

  public reconcileOrder(_reference: VenueOrderReference): Promise<VenueOrderResult> {
    return Promise.resolve({
      status: "unknown",
      reason: "live venue access is disabled; reconciliation requires live credentials",
    });
  }
}
