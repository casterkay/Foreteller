import {
  createSecureClient,
  OrderSide,
  OrderType,
  type AssetType,
  type ClobTrade,
  type OpenOrder,
  type OrderResponse,
  type SecureClient,
} from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";

import type { AppConfig } from "../config.js";
import type { FillRecord } from "../domain/types.js";
import type {
  FakMarketBuy,
  VenueOrderReference,
  VenueOrderResult,
  VenueTrader,
} from "./executor.js";

type TradingClient = SecureClient;
const collateralAssetType = "COLLATERAL" as AssetType;

export async function createPolymarketVenueTrader(
  config: AppConfig,
): Promise<PolymarketVenueTrader> {
  if (!config.polymarketPrivateKey || !config.polymarketFunderAddress) {
    throw new Error("Polymarket wallet credentials are required for live trading");
  }
  const client = await createSecureClient({
    wallet: config.polymarketFunderAddress,
    signer: privateKey(config.polymarketPrivateKey),
  });
  return new PolymarketVenueTrader(client);
}

export class PolymarketVenueTrader implements VenueTrader {
  public constructor(private readonly client: TradingClient) {}

  public async availableBalance(_signal: AbortSignal): Promise<number> {
    const response = await fetchBalanceAllowance(this.client, {
      assetType: collateralAssetType,
    });
    return Number(response.balance) / 1_000_000;
  }

  public async accountStatus(): Promise<{
    readonly balance: number;
    readonly allowances: readonly number[];
  }> {
    const response = await fetchBalanceAllowance(this.client, {
      assetType: collateralAssetType,
    });
    return Object.freeze({
      balance: Number(response.balance) / 1_000_000,
      allowances: Object.freeze(
        Object.values(response.allowances).map((allowance) => Number(allowance) / 1_000_000),
      ),
    });
  }

  public async submitFakMarketBuy(
    order: FakMarketBuy,
    _signal: AbortSignal,
  ): Promise<VenueOrderResult> {
    const response = await this.client.placeMarketOrder({
      assetId: order.tokenId,
      amount: order.notional,
      maxPrice: order.maxPrice,
      orderType: OrderType.FAK,
      side: OrderSide.BUY,
    });
    return this.resolvePlacement(order, response);
  }

  public async reconcileOrder(
    reference: VenueOrderReference,
    _signal: AbortSignal,
  ): Promise<VenueOrderResult> {
    if (!reference.venueOrderId) {
      return {
        status: "unknown",
        reason:
          "The venue does not expose lookup by local intent ID; inspect account trades before resolving this order",
      };
    }

    try {
      const order = await this.client.fetchOrder({ orderId: reference.venueOrderId });
      const fills = await this.fetchTrades(order.associateTrades, reference.clientOrderId);
      if (fills.length > 0) {
        return {
          status: isFullyMatched(order) ? "filled" : "partially_filled",
          venueOrderId: order.id,
          fills,
        };
      }
      if (isTerminalOrderStatus(order.status)) {
        return { status: "cancelled", venueOrderId: order.id, reason: order.status };
      }
      return { status: "submitted", venueOrderId: order.id, reason: order.status };
    } catch (error) {
      return {
        status: "unknown",
        venueOrderId: reference.venueOrderId,
        reason: error instanceof Error ? error.message : "Venue reconciliation failed",
      };
    }
  }

  private async resolvePlacement(
    order: FakMarketBuy,
    response: OrderResponse,
  ): Promise<VenueOrderResult> {
    if (!response.ok) {
      return { status: "rejected", reason: `${response.code}: ${response.message}` };
    }
    if (response.tradeIds.length === 0) {
      return {
        status: response.status === "matched" ? "unknown" : "submitted",
        venueOrderId: response.orderId,
        reason: `venue status ${response.status} returned no trade IDs`,
      };
    }

    try {
      const fills = await this.fetchTrades(response.tradeIds, order.clientOrderId);
      if (fills.length !== response.tradeIds.length) {
        return {
          status: "submitted",
          venueOrderId: response.orderId,
          fills,
          reason: "not all placement fills were visible yet",
        };
      }
      const spent = Number(response.makingAmount);
      return {
        status: spent + 1e-6 >= order.notional ? "filled" : "partially_filled",
        venueOrderId: response.orderId,
        fills,
      };
    } catch (error) {
      return {
        status: "submitted",
        venueOrderId: response.orderId,
        reason: error instanceof Error ? error.message : "Placement fill lookup failed",
      };
    }
  }

  private async fetchTrades(
    tradeIds: readonly string[],
    intentId: string,
  ): Promise<readonly FillRecord[]> {
    const pages = await Promise.all(
      tradeIds.map((id) => this.client.listAccountTrades({ id }).firstPage()),
    );
    return pages.flatMap((page) =>
      page.items.map((trade) => mapTradeToFill(trade, intentId)),
    );
  }
}

function mapTradeToFill(trade: ClobTrade, intentId: string): FillRecord {
  const price = Number(trade.price);
  const shares = Number(trade.size);
  const feeRate = Number(trade.feeRateBps) / 10_000;
  return Object.freeze({
    venueTradeId: trade.id,
    venueOrderId: trade.takerOrderId,
    intentId,
    price,
    shares,
    fee: feeRate * price * (1 - price) * shares,
    status: trade.status === "CONFIRMED" ? "confirmed" : "matched",
    occurredAtMs: Date.parse(trade.matchedAt),
  });
}

function isFullyMatched(order: OpenOrder): boolean {
  return Number(order.sizeMatched) + 1e-9 >= Number(order.originalSize);
}

function isTerminalOrderStatus(status: string): boolean {
  return ["CANCELED", "CANCELLED", "UNMATCHED", "FAILED"].includes(
    status.toUpperCase(),
  );
}
