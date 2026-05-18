import { createLogger } from '../utils/logger';
import { isSubrequestBudgetExceededError, type SubrequestBudget } from '../utils/subrequest-budget';
import type { TrafficStats, TrafficType } from './stats-reporter';

const log = createLogger('TrafficD1');

export const WS_INBOUND_TAG = 'VLESS_WS';
export const XHTTP_INBOUND_TAG = 'VLESS_XHTTP';
export const DEFAULT_OUTBOUND_TAG = 'DIRECT';

const CREATE_COUNTERS_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS traffic_counters (uuid TEXT NOT NULL, inbound_tag TEXT NOT NULL, outbound_tag TEXT NOT NULL, uplink INTEGER NOT NULL DEFAULT 0, downlink INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (uuid, inbound_tag, outbound_tag))';
const CREATE_NODE_COUNTERS_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS traffic_node_counters (direction TEXT NOT NULL, tag TEXT NOT NULL, uplink INTEGER NOT NULL DEFAULT 0, downlink INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (direction, tag))';
const CREATE_INBOUND_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_traffic_inbound_tag ON traffic_counters(inbound_tag)';
const CREATE_OUTBOUND_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_traffic_outbound_tag ON traffic_counters(outbound_tag)';
const CREATE_NODE_DIRECTION_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_traffic_node_direction ON traffic_node_counters(direction)';

interface TrafficCounterRow {
  uuid: string;
  inboundTag: string;
  outboundTag: string;
  uplink: number;
  downlink: number;
}

interface TrafficNodeCounterRow {
  direction: 'inbound' | 'outbound';
  tag: string;
  uplink: number;
  downlink: number;
}

export interface RemnawaveUserStat {
  username: string;
  uplink: number;
  downlink: number;
}

export interface RemnawaveTaggedStat {
  uplink: number;
  downlink: number;
}

export interface RemnawaveCombinedStats {
  inbounds: Array<{ inbound: string; uplink: number; downlink: number }>;
  outbounds: Array<{ outbound: string; uplink: number; downlink: number }>;
}

export class TrafficStore {
  private initialized = false;

  constructor(private readonly db?: D1Database) {}

  get isAvailable(): boolean {
    return Boolean(this.db);
  }

  async record(stats: TrafficStats, budget?: SubrequestBudget): Promise<boolean> {
    const db = this.db;
    if (!db || (stats.uplink === 0 && stats.downlink === 0)) {
      return true;
    }

    try {
      await this.ensureTable(budget);
      const inboundTag = resolveInboundTag(stats.type);
      const outboundTag = stats.outboundTag ?? DEFAULT_OUTBOUND_TAG;
      const now = Date.now();

      budget?.consume(3, 'D1.batch traffic record');
      await db.batch([
        db
          .prepare(`
            INSERT INTO traffic_counters (
              uuid, inbound_tag, outbound_tag, uplink, downlink, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(uuid, inbound_tag, outbound_tag) DO UPDATE SET
              uplink = uplink + excluded.uplink,
              downlink = downlink + excluded.downlink,
              updated_at = excluded.updated_at
          `)
          .bind(stats.uuid, inboundTag, outboundTag, stats.uplink, stats.downlink, now),
        db
          .prepare(`
            INSERT INTO traffic_node_counters (
              direction, tag, uplink, downlink, updated_at
            )
            VALUES ('inbound', ?, ?, ?, ?)
            ON CONFLICT(direction, tag) DO UPDATE SET
              uplink = uplink + excluded.uplink,
              downlink = downlink + excluded.downlink,
              updated_at = excluded.updated_at
          `)
          .bind(inboundTag, stats.uplink, stats.downlink, now),
        db
          .prepare(`
            INSERT INTO traffic_node_counters (
              direction, tag, uplink, downlink, updated_at
            )
            VALUES ('outbound', ?, ?, ?, ?)
            ON CONFLICT(direction, tag) DO UPDATE SET
              uplink = uplink + excluded.uplink,
              downlink = downlink + excluded.downlink,
              updated_at = excluded.updated_at
          `)
          .bind(outboundTag, stats.uplink, stats.downlink, now),
      ]);
      return true;
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      log.warn('traffic record failed', error);
      return false;
    }
  }

  async getUsersStats(reset: boolean, budget?: SubrequestBudget): Promise<RemnawaveUserStat[]> {
    const rows = await this.readCounters(budget);
    const users = new Map<string, { uplink: number; downlink: number }>();

    for (const row of rows) {
      const current = users.get(row.uuid) ?? { uplink: 0, downlink: 0 };
      current.uplink += row.uplink;
      current.downlink += row.downlink;
      users.set(row.uuid, current);
    }

    if (reset && rows.length > 0) {
      await this.clearRows(rows, budget);
    }

    return Array.from(users.entries()).map(([username, stat]) => ({
      username,
      uplink: stat.uplink,
      downlink: stat.downlink,
    }));
  }

  async getCombinedStats(
    reset: boolean,
    budget?: SubrequestBudget,
  ): Promise<RemnawaveCombinedStats> {
    const rows = await this.readNodeCounters(budget);
    const inbounds = new Map<string, RemnawaveTaggedStat>();
    const outbounds = new Map<string, RemnawaveTaggedStat>();

    for (const row of rows) {
      addTaggedStat(row.direction === 'inbound' ? inbounds : outbounds, row.tag, row);
    }

    if (reset && rows.length > 0) {
      await this.clearNodeRows(rows, budget);
    }

    return {
      inbounds: mapInboundStats(inbounds),
      outbounds: mapOutboundStats(outbounds),
    };
  }

  async getInboundStats(
    tag: string | undefined,
    reset: boolean,
    budget?: SubrequestBudget,
  ): Promise<{ inbound: string; uplink: number; downlink: number }> {
    const target = tag || WS_INBOUND_TAG;
    const rows = (await this.readNodeCounters(budget)).filter(
      (row) => row.direction === 'inbound' && row.tag === target,
    );
    const total = sumRows(rows);
    if (reset && rows.length > 0) {
      await this.clearNodeRows(rows, budget);
    }
    return { inbound: target, ...total };
  }

  async getOutboundStats(
    tag: string | undefined,
    reset: boolean,
    budget?: SubrequestBudget,
  ): Promise<{ outbound: string; uplink: number; downlink: number }> {
    const target = tag || DEFAULT_OUTBOUND_TAG;
    const rows = (await this.readNodeCounters(budget)).filter(
      (row) => row.direction === 'outbound' && row.tag === target,
    );
    const total = sumRows(rows);
    if (reset && rows.length > 0) {
      await this.clearNodeRows(rows, budget);
    }
    return { outbound: target, ...total };
  }

  async getAllInboundStats(
    reset: boolean,
    budget?: SubrequestBudget,
  ): Promise<Array<{ inbound: string; uplink: number; downlink: number }>> {
    const rows = (await this.readNodeCounters(budget)).filter((row) => row.direction === 'inbound');
    const inbounds = new Map<string, RemnawaveTaggedStat>();
    for (const row of rows) {
      addTaggedStat(inbounds, row.tag, row);
    }

    if (reset && rows.length > 0) {
      await this.clearNodeRows(rows, budget);
    }

    return mapInboundStats(inbounds);
  }

  async getAllOutboundStats(
    reset: boolean,
    budget?: SubrequestBudget,
  ): Promise<Array<{ outbound: string; uplink: number; downlink: number }>> {
    const rows = (await this.readNodeCounters(budget)).filter(
      (row) => row.direction === 'outbound',
    );
    const outbounds = new Map<string, RemnawaveTaggedStat>();
    for (const row of rows) {
      addTaggedStat(outbounds, row.tag, row);
    }

    if (reset && rows.length > 0) {
      await this.clearNodeRows(rows, budget);
    }

    return mapOutboundStats(outbounds);
  }

  private async ensureTable(budget?: SubrequestBudget): Promise<void> {
    const db = this.db;
    if (!db || this.initialized) {
      return;
    }

    budget?.consume(5, 'D1.batch traffic ensureTable');
    await db.batch([
      db.prepare(CREATE_COUNTERS_TABLE_SQL),
      db.prepare(CREATE_NODE_COUNTERS_TABLE_SQL),
      db.prepare(CREATE_INBOUND_INDEX_SQL),
      db.prepare(CREATE_OUTBOUND_INDEX_SQL),
      db.prepare(CREATE_NODE_DIRECTION_INDEX_SQL),
    ]);
    this.initialized = true;
  }

  private async readCounters(budget?: SubrequestBudget): Promise<TrafficCounterRow[]> {
    const db = this.db;
    if (!db) {
      return [];
    }

    try {
      await this.ensureTable(budget);
      budget?.consume(1, 'D1.all traffic counters');
      const result = await db
        .prepare(`
          SELECT
            uuid,
            inbound_tag AS inboundTag,
            outbound_tag AS outboundTag,
            uplink,
            downlink
          FROM traffic_counters
          WHERE uplink > 0 OR downlink > 0
        `)
        .all<TrafficCounterRow>();
      return result.results ?? [];
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      log.warn('traffic counters read failed', error);
      return [];
    }
  }

  private async readNodeCounters(budget?: SubrequestBudget): Promise<TrafficNodeCounterRow[]> {
    const db = this.db;
    if (!db) {
      return [];
    }

    try {
      await this.ensureTable(budget);
      budget?.consume(1, 'D1.all traffic node counters');
      const result = await db
        .prepare(`
          SELECT direction, tag, uplink, downlink
          FROM traffic_node_counters
          WHERE uplink > 0 OR downlink > 0
        `)
        .all<TrafficNodeCounterRow>();
      return result.results ?? [];
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      log.warn('traffic node counters read failed', error);
      return [];
    }
  }

  private async clearRows(rows: TrafficCounterRow[], budget?: SubrequestBudget): Promise<void> {
    const db = this.db;
    if (!db || rows.length === 0) {
      return;
    }

    try {
      await this.ensureTable(budget);
      budget?.consume(rows.length, 'D1.batch traffic reset');
      await db.batch(
        rows.map((row) =>
          db
            .prepare(`
            UPDATE traffic_counters
            SET uplink = 0, downlink = 0, updated_at = ?
            WHERE uuid = ? AND inbound_tag = ? AND outbound_tag = ?
          `)
            .bind(Date.now(), row.uuid, row.inboundTag, row.outboundTag),
        ),
      );
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      log.warn('traffic counters reset failed', error);
    }
  }

  private async clearNodeRows(
    rows: TrafficNodeCounterRow[],
    budget?: SubrequestBudget,
  ): Promise<void> {
    const db = this.db;
    if (!db || rows.length === 0) {
      return;
    }

    try {
      await this.ensureTable(budget);
      budget?.consume(rows.length, 'D1.batch traffic node reset');
      await db.batch(
        rows.map((row) =>
          db
            .prepare(`
            UPDATE traffic_node_counters
            SET uplink = 0, downlink = 0, updated_at = ?
            WHERE direction = ? AND tag = ?
          `)
            .bind(Date.now(), row.direction, row.tag),
        ),
      );
    } catch (error) {
      if (isSubrequestBudgetExceededError(error)) {
        throw error;
      }
      log.warn('traffic node counters reset failed', error);
    }
  }
}

function resolveInboundTag(type: TrafficType | undefined): string {
  return type === 'xhttp' ? XHTTP_INBOUND_TAG : WS_INBOUND_TAG;
}

function addTaggedStat(
  target: Map<string, RemnawaveTaggedStat>,
  tag: string,
  row: Pick<TrafficCounterRow, 'uplink' | 'downlink'>,
): void {
  const current = target.get(tag) ?? { uplink: 0, downlink: 0 };
  current.uplink += row.uplink;
  current.downlink += row.downlink;
  target.set(tag, current);
}

function mapInboundStats(
  stats: Map<string, RemnawaveTaggedStat>,
): Array<{ inbound: string; uplink: number; downlink: number }> {
  return Array.from(stats.entries()).map(([tag, value]) => ({
    inbound: tag,
    uplink: value.uplink,
    downlink: value.downlink,
  }));
}

function mapOutboundStats(
  stats: Map<string, RemnawaveTaggedStat>,
): Array<{ outbound: string; uplink: number; downlink: number }> {
  return Array.from(stats.entries()).map(([tag, value]) => ({
    outbound: tag,
    uplink: value.uplink,
    downlink: value.downlink,
  }));
}

function sumRows(rows: Array<Pick<TrafficCounterRow, 'uplink' | 'downlink'>>): RemnawaveTaggedStat {
  return rows.reduce(
    (sum, row) => ({
      uplink: sum.uplink + row.uplink,
      downlink: sum.downlink + row.downlink,
    }),
    { uplink: 0, downlink: 0 },
  );
}
