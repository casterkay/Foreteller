import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type {
  BookSnapshot,
  FillRecord,
  ForecastAnswer,
  OrderIntent,
  OrderIntentStatus,
  SessionBinding,
  SessionStatus,
  Strategy,
  TranscriptSegment,
} from "../domain/types.js";
import { migrations } from "./schema.js";

const MICROS_PER_UNIT = 1_000_000;
const activeReservationStatuses: readonly OrderIntentStatus[] = [
  "reserved",
  "submitted",
  "unknown",
];

export interface BudgetLimits {
  readonly daily: number;
  readonly event: number;
  readonly strategyMarket: number;
  readonly walletAvailable: number;
}

export interface ReservationResult {
  readonly accepted: boolean;
  readonly reason?: ReservationRejectionReason;
}

type ReservationRejectionReason =
  | "daily_limit"
  | "event_limit"
  | "strategy_market_limit"
  | "wallet_limit";

export interface StoredOrder {
  readonly intent: OrderIntent;
  readonly status: OrderIntentStatus;
  readonly venueOrderId?: string;
  readonly reason?: string;
}

export interface DecisionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly marketId: string;
  readonly strategy: Strategy;
  readonly accepted: boolean;
  readonly reason: string;
  readonly evidenceJson: string;
  readonly createdAtMs: number;
}

export type MarketOutcome = "yes" | "no" | "void" | "unresolved";

interface ExposureRow {
  readonly total_micros: number;
}

interface StoredOrderRow {
  readonly id: string;
  readonly session_id: string;
  readonly event_id: string;
  readonly market_id: string;
  readonly token_id: string;
  readonly strategy: Strategy;
  readonly notional_micros: number;
  readonly max_price: number;
  readonly evidence_json: string;
  readonly created_at_ms: number;
  readonly status: OrderIntentStatus;
  readonly venue_order_id: string | null;
  readonly reason: string | null;
}

function toMicros(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return Math.round(value * MICROS_PER_UNIT);
}

function utcDay(timestampMs: number): string {
  const date = new Date(timestampMs);
  if (!Number.isFinite(timestampMs) || Number.isNaN(date.valueOf())) {
    throw new RangeError("timestamp must be valid");
  }
  return date.toISOString().slice(0, 10);
}

function assertPositiveIntent(intent: OrderIntent): void {
  if (!Number.isFinite(intent.notional) || intent.notional <= 0) {
    throw new RangeError("intent notional must be positive");
  }
  if (!Number.isFinite(intent.maxPrice) || intent.maxPrice <= 0 || intent.maxPrice > 1) {
    throw new RangeError("intent maxPrice must be in (0, 1]");
  }
}

export class SqliteStore {
  private readonly database: Database.Database;

  public constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (path !== ":memory:") {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
    }
    this.migrate();
  }

  public close(): void {
    this.database.close();
  }

  public recordSession(id: string, status: SessionStatus, occurredAtMs: number): void {
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO sessions (id, created_at_ms) VALUES (?, ?)")
        .run(id, occurredAtMs);
      this.database.prepare(`
        INSERT INTO session_status_events (session_id, status, occurred_at_ms)
        VALUES (?, ?, ?)
      `).run(id, status, occurredAtMs);
    })();
  }

  public recordSessionStatus(sessionId: string, status: SessionStatus, occurredAtMs: number): void {
    this.database.prepare(`
      INSERT INTO session_status_events (session_id, status, occurred_at_ms)
      VALUES (?, ?, ?)
    `).run(sessionId, status, occurredAtMs);
  }

  public recordBinding(binding: SessionBinding): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO bindings
        (session_id, event_id, rules_hash, binding_json, confirmed_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      binding.sessionId,
      binding.eventId,
      binding.rulesHash,
      JSON.stringify(binding),
      binding.confirmedAtMs,
    );
  }

  public recordTranscript(sessionId: string, segment: TranscriptSegment): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO transcript_segments
        (session_id, segment_id, segment_json, source_start_ms, source_end_ms,
         received_at_ms, is_final)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      segment.id,
      JSON.stringify(segment),
      segment.sourceStartMs,
      segment.sourceEndMs,
      segment.receivedAtMs,
      segment.isFinal ? 1 : 0,
    );
    return result.changes === 1;
  }

  public recordBookSnapshot(sessionId: string, marketId: string, snapshot: BookSnapshot): void {
    this.database.prepare(`
      INSERT INTO book_snapshots (session_id, market_id, snapshot_json, received_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, marketId, JSON.stringify(snapshot), snapshot.receivedAtMs);
  }

  public recordForecast(sessionId: string, forecast: ForecastAnswer, recordedAtMs: number): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO forecasts
        (session_id, market_id, forecast_json, snapshot_at_ms, recorded_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      forecast.marketId,
      JSON.stringify(forecast),
      forecast.snapshotAtMs,
      recordedAtMs,
    );
    return result.changes === 1;
  }

  public recordDecision(decision: DecisionRecord): void {
    this.database.prepare(`
      INSERT INTO decisions
        (id, session_id, event_id, market_id, strategy, accepted, reason,
         evidence_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id,
      decision.sessionId,
      decision.eventId,
      decision.marketId,
      decision.strategy,
      decision.accepted ? 1 : 0,
      decision.reason,
      decision.evidenceJson,
      decision.createdAtMs,
    );
  }

  public reserveOrder(
    intent: OrderIntent,
    feeReserve: number,
    limits: BudgetLimits,
  ): ReservationResult {
    assertPositiveIntent(intent);
    const notionalMicros = toMicros(intent.notional, "intent notional");
    const feeReserveMicros = toMicros(feeReserve, "fee reserve");
    const walletReservationMicros = notionalMicros + feeReserveMicros;
    const day = utcDay(intent.createdAtMs);

    return this.database.transaction((): ReservationResult => {
      const checks: readonly [ReservationRejectionReason, number, string, readonly unknown[]][] = [
        ["daily_limit", limits.daily, "i.utc_day = ?", [day]],
        ["event_limit", limits.event, "i.event_id = ?", [intent.eventId]],
        [
          "strategy_market_limit",
          limits.strategyMarket,
          "i.market_id = ? AND i.strategy = ?",
          [intent.marketId, intent.strategy],
        ],
      ];

      for (const [reason, limit, predicate, parameters] of checks) {
        const existingMicros = this.exposureMicros(predicate, parameters);
        if (existingMicros + notionalMicros > toMicros(limit, reason)) {
          return { accepted: false, reason };
        }
      }

      if (
        this.outstandingReservationMicros() + walletReservationMicros >
        toMicros(limits.walletAvailable, "wallet limit")
      ) {
        return { accepted: false, reason: "wallet_limit" };
      }

      this.database.prepare(`
        INSERT INTO order_intents
          (id, session_id, event_id, market_id, token_id, strategy,
           notional_micros, fee_reserve_micros, max_price, evidence_json,
           created_at_ms, utc_day)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        intent.id,
        intent.sessionId,
        intent.eventId,
        intent.marketId,
        intent.tokenId,
        intent.strategy,
        notionalMicros,
        feeReserveMicros,
        intent.maxPrice,
        intent.evidenceJson,
        intent.createdAtMs,
        day,
      );
      this.insertOrderEvent(intent.id, "reserved", intent.createdAtMs);
      return { accepted: true };
    }).immediate();
  }

  public recordOrderEvent(
    intentId: string,
    status: OrderIntentStatus,
    occurredAtMs: number,
    details: { readonly venueOrderId?: string; readonly reason?: string } = {},
  ): void {
    const current = this.getOrder(intentId);
    if (current === undefined) throw new Error(`unknown order intent: ${intentId}`);
    if (current.status === "filled" && status !== "filled") {
      throw new Error(`filled order intent ${intentId} cannot transition to ${status}`);
    }
    this.insertOrderEvent(
      intentId,
      status,
      occurredAtMs,
      details.venueOrderId ?? current.venueOrderId,
      details.reason,
    );
  }

  public ingestFill(fill: FillRecord, ingestedAtMs: number): boolean {
    if (!Number.isFinite(fill.price) || fill.price <= 0 || fill.price > 1) {
      throw new RangeError("fill price must be in (0, 1]");
    }
    if (!Number.isFinite(fill.shares) || fill.shares <= 0) {
      throw new RangeError("fill shares must be positive");
    }
    const feeMicros = toMicros(fill.fee, "fill fee");
    const notionalMicros = toMicros(fill.price * fill.shares, "fill notional");

    return this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT intent_id, venue_order_id, price, shares, fee_micros, notional_micros
        FROM fills WHERE venue_trade_id = ? LIMIT 1
      `).get(fill.venueTradeId) as
        | {
            intent_id: string;
            venue_order_id: string;
            price: number;
            shares: number;
            fee_micros: number;
            notional_micros: number;
          }
        | undefined;
      if (
        existing !== undefined &&
        (existing.intent_id !== fill.intentId ||
          existing.venue_order_id !== fill.venueOrderId ||
          existing.price !== fill.price ||
          existing.shares !== fill.shares ||
          existing.fee_micros !== feeMicros ||
          existing.notional_micros !== notionalMicros)
      ) {
        throw new Error(`conflicting fill facts for venue trade ${fill.venueTradeId}`);
      }

      const result = this.database.prepare(`
        INSERT OR IGNORE INTO fills
          (venue_trade_id, venue_order_id, intent_id, price, shares, fee_micros,
           notional_micros, status, occurred_at_ms, ingested_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fill.venueTradeId,
        fill.venueOrderId,
        fill.intentId,
        fill.price,
        fill.shares,
        feeMicros,
        notionalMicros,
        fill.status,
        fill.occurredAtMs,
        ingestedAtMs,
      );
      return result.changes === 1;
    })();
  }

  public recordOutcome(marketId: string, outcome: MarketOutcome, observedAtMs: number): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO outcomes (market_id, outcome, observed_at_ms)
      VALUES (?, ?, ?)
    `).run(marketId, outcome, observedAtMs);
    return result.changes === 1;
  }

  public getOrder(intentId: string): StoredOrder | undefined {
    const row = this.orderQuery("WHERE i.id = ?").get(intentId) as StoredOrderRow | undefined;
    return row === undefined ? undefined : this.mapOrder(row);
  }

  public listUnresolvedOrders(): readonly StoredOrder[] {
    const placeholders = activeReservationStatuses.map(() => "?").join(", ");
    const rows = this.orderQuery(`WHERE latest.status IN (${placeholders})`)
      .all(...activeReservationStatuses) as StoredOrderRow[];
    return rows.map((row) => this.mapOrder(row));
  }

  public exposure(filter: {
    readonly utcDay?: string;
    readonly eventId?: string;
    readonly marketId?: string;
    readonly strategy?: Strategy;
  } = {}): number {
    const predicates: string[] = [];
    const parameters: unknown[] = [];
    if (filter.utcDay !== undefined) {
      predicates.push("i.utc_day = ?");
      parameters.push(filter.utcDay);
    }
    if (filter.eventId !== undefined) {
      predicates.push("i.event_id = ?");
      parameters.push(filter.eventId);
    }
    if (filter.marketId !== undefined) {
      predicates.push("i.market_id = ?");
      parameters.push(filter.marketId);
    }
    if (filter.strategy !== undefined) {
      predicates.push("i.strategy = ?");
      parameters.push(filter.strategy);
    }
    const predicate = predicates.length === 0 ? "1 = 1" : predicates.join(" AND ");
    return this.exposureMicros(predicate, parameters) / MICROS_PER_UNIT;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      ) STRICT
    `);
    const current = this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    for (let index = current.version; index < migrations.length; index += 1) {
      const sql = migrations[index];
      if (sql === undefined) throw new Error(`missing migration ${index + 1}`);
      this.database.transaction(() => {
        this.database.exec(sql);
        this.database.prepare("INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)")
          .run(index + 1, Date.now());
      })();
    }
  }

  private insertOrderEvent(
    intentId: string,
    status: OrderIntentStatus,
    occurredAtMs: number,
    venueOrderId?: string,
    reason?: string,
  ): void {
    this.database.prepare(`
      INSERT INTO order_events
        (intent_id, status, venue_order_id, reason, occurred_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(intentId, status, venueOrderId ?? null, reason ?? null, occurredAtMs);
  }

  private exposureMicros(predicate: string, parameters: readonly unknown[]): number {
    const row = this.database.prepare(`
      WITH latest_order_events AS (
        SELECT oe.intent_id, oe.status
        FROM order_events oe
        JOIN (
          SELECT intent_id, MAX(id) AS event_id
          FROM order_events GROUP BY intent_id
        ) current ON current.event_id = oe.id
      ),
      latest_fill_events AS (
        SELECT f.*
        FROM fills f
        JOIN (
          SELECT venue_trade_id, MAX(id) AS fill_id
          FROM fills GROUP BY venue_trade_id
        ) current ON current.fill_id = f.id
      ),
      fill_totals AS (
        SELECT intent_id,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 0 ELSE notional_micros END), 0)
            AS filled_micros
        FROM latest_fill_events GROUP BY intent_id
      )
      SELECT COALESCE(SUM(
        CASE WHEN latest.status IN ('reserved', 'submitted', 'unknown')
          THEN MAX(i.notional_micros, COALESCE(f.filled_micros, 0))
          ELSE COALESCE(f.filled_micros, 0)
        END
      ), 0) AS total_micros
      FROM order_intents i
      JOIN latest_order_events latest ON latest.intent_id = i.id
      LEFT JOIN fill_totals f ON f.intent_id = i.id
      WHERE ${predicate}
    `).get(...parameters) as ExposureRow;
    return row.total_micros;
  }

  private outstandingReservationMicros(): number {
    const row = this.database.prepare(`
      WITH latest_order_events AS (
        SELECT oe.intent_id, oe.status
        FROM order_events oe
        JOIN (
          SELECT intent_id, MAX(id) AS event_id
          FROM order_events GROUP BY intent_id
        ) current ON current.event_id = oe.id
      ),
      latest_fill_events AS (
        SELECT f.*
        FROM fills f
        JOIN (
          SELECT venue_trade_id, MAX(id) AS fill_id
          FROM fills GROUP BY venue_trade_id
        ) current ON current.fill_id = f.id
      ),
      fill_totals AS (
        SELECT intent_id,
          COALESCE(SUM(
            CASE WHEN status = 'failed' THEN 0 ELSE notional_micros + fee_micros END
          ), 0) AS filled_micros
        FROM latest_fill_events GROUP BY intent_id
      )
      SELECT COALESCE(SUM(
        MAX(i.notional_micros + i.fee_reserve_micros - COALESCE(f.filled_micros, 0), 0)
      ), 0) AS total_micros
      FROM order_intents i
      JOIN latest_order_events latest ON latest.intent_id = i.id
      LEFT JOIN fill_totals f ON f.intent_id = i.id
      WHERE latest.status IN ('reserved', 'submitted', 'unknown')
    `).get() as ExposureRow;
    return row.total_micros;
  }

  private orderQuery(whereClause: string): Database.Statement {
    return this.database.prepare(`
      WITH latest_order_events AS (
        SELECT oe.*
        FROM order_events oe
        JOIN (
          SELECT intent_id, MAX(id) AS event_id
          FROM order_events GROUP BY intent_id
        ) current ON current.event_id = oe.id
      )
      SELECT i.id, i.session_id, i.event_id, i.market_id, i.token_id,
        i.strategy, i.notional_micros, i.max_price, i.evidence_json,
        i.created_at_ms, latest.status, latest.venue_order_id, latest.reason
      FROM order_intents i
      JOIN latest_order_events latest ON latest.intent_id = i.id
      ${whereClause}
      ORDER BY i.created_at_ms, i.id
    `);
  }

  private mapOrder(row: StoredOrderRow): StoredOrder {
    return {
      intent: {
        id: row.id,
        sessionId: row.session_id,
        eventId: row.event_id,
        marketId: row.market_id,
        tokenId: row.token_id,
        strategy: row.strategy,
        notional: row.notional_micros / MICROS_PER_UNIT,
        maxPrice: row.max_price,
        evidenceJson: row.evidence_json,
        createdAtMs: row.created_at_ms,
      },
      status: row.status,
      ...(row.venue_order_id === null ? {} : { venueOrderId: row.venue_order_id }),
      ...(row.reason === null ? {} : { reason: row.reason }),
    };
  }
}
