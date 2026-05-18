import { describe, expect, it } from 'vitest';
import type { TrafficStats } from '../src/services/stats-reporter';
import { TrafficStore } from '../src/services/traffic-store';

interface CounterRow {
  uuid: string;
  inboundTag: string;
  outboundTag: string;
  uplink: number;
  downlink: number;
  updatedAt: number;
}

interface NodeCounterRow {
  direction: 'inbound' | 'outbound';
  tag: string;
  uplink: number;
  downlink: number;
  updatedAt: number;
}

class FakeD1Database {
  readonly rows = new Map<string, CounterRow>();
  readonly nodeRows = new Map<string, NodeCounterRow>();

  async exec(): Promise<D1ExecResult> {
    return { count: 0, duration: 0 };
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeD1PreparedStatement(this, query) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.run<T>());
    }
    return results;
  }
}

class FakeD1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): FakeD1PreparedStatement {
    this.values = values;
    return this;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (this.query.includes('INSERT INTO traffic_counters')) {
      const [uuid, inboundTag, outboundTag, uplink, downlink, updatedAt] = this.values as [
        string,
        string,
        string,
        number,
        number,
        number,
      ];
      const key = makeKey(uuid, inboundTag, outboundTag);
      const current = this.db.rows.get(key);
      this.db.rows.set(key, {
        uuid,
        inboundTag,
        outboundTag,
        uplink: (current?.uplink ?? 0) + uplink,
        downlink: (current?.downlink ?? 0) + downlink,
        updatedAt,
      });
    }

    if (this.query.includes('INSERT INTO traffic_node_counters')) {
      const [tag, uplink, downlink, updatedAt] = this.values as [string, number, number, number];
      const direction = this.query.includes("VALUES ('inbound'") ? 'inbound' : 'outbound';
      const key = makeNodeKey(direction, tag);
      const current = this.db.nodeRows.get(key);
      this.db.nodeRows.set(key, {
        direction,
        tag,
        uplink: (current?.uplink ?? 0) + uplink,
        downlink: (current?.downlink ?? 0) + downlink,
        updatedAt,
      });
    }

    if (this.query.includes('UPDATE traffic_counters')) {
      const [updatedAt, uuid, inboundTag, outboundTag] = this.values as [
        number,
        string,
        string,
        string,
      ];
      const row = this.db.rows.get(makeKey(uuid, inboundTag, outboundTag));
      if (row) {
        row.uplink = 0;
        row.downlink = 0;
        row.updatedAt = updatedAt;
      }
    }

    if (this.query.includes('UPDATE traffic_node_counters')) {
      const [updatedAt, direction, tag] = this.values as [number, 'inbound' | 'outbound', string];
      const row = this.db.nodeRows.get(makeNodeKey(direction, tag));
      if (row) {
        row.uplink = 0;
        row.downlink = 0;
        row.updatedAt = updatedAt;
      }
    }

    return {
      success: true,
      meta: {},
      results: [],
    } as D1Result<T>;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.query.includes('FROM traffic_node_counters')
      ? this.db.nodeRows.values()
      : this.db.rows.values();
    return {
      success: true,
      meta: {},
      results: Array.from(rows).filter((row) => row.uplink > 0 || row.downlink > 0) as T[],
    } as D1Result<T>;
  }
}

function makeKey(uuid: string, inboundTag: string, outboundTag: string): string {
  return `${uuid}:${inboundTag}:${outboundTag}`;
}

function makeNodeKey(direction: string, tag: string): string {
  return `${direction}:${tag}`;
}

describe('TrafficStore', () => {
  it('records websocket and xhttp traffic under distinct inbound tags', async () => {
    const db = new FakeD1Database();
    const store = new TrafficStore(db as unknown as D1Database);

    await store.record(stats({ type: 'tcp', uplink: 100, downlink: 200 }));
    await store.record(stats({ type: 'xhttp', uplink: 50, downlink: 75 }));

    const combined = await store.getCombinedStats(false);

    expect(combined.inbounds).toEqual([
      { inbound: 'VLESS_WS', uplink: 100, downlink: 200 },
      { inbound: 'VLESS_XHTTP', uplink: 50, downlink: 75 },
    ]);
    expect(combined.outbounds).toEqual([{ outbound: 'DIRECT', uplink: 150, downlink: 275 }]);
  });

  it('aggregates user stats and clears returned rows when reset is true', async () => {
    const db = new FakeD1Database();
    const store = new TrafficStore(db as unknown as D1Database);

    await store.record(stats({ uuid: 'user-1', uplink: 100, downlink: 200 }));
    await store.record(stats({ uuid: 'user-1', uplink: 25, downlink: 50, type: 'xhttp' }));
    await store.record(stats({ uuid: 'user-2', uplink: 10, downlink: 20 }));

    await expect(store.getUsersStats(false)).resolves.toEqual([
      { username: 'user-1', uplink: 125, downlink: 250 },
      { username: 'user-2', uplink: 10, downlink: 20 },
    ]);

    await expect(store.getUsersStats(true)).resolves.toEqual([
      { username: 'user-1', uplink: 125, downlink: 250 },
      { username: 'user-2', uplink: 10, downlink: 20 },
    ]);
    await expect(store.getUsersStats(false)).resolves.toEqual([]);
  });

  it('keeps node counters independent from user counter reset', async () => {
    const db = new FakeD1Database();
    const store = new TrafficStore(db as unknown as D1Database);

    await store.record(stats({ uuid: 'user-1', uplink: 100, downlink: 200 }));

    await expect(store.getUsersStats(true)).resolves.toEqual([
      { username: 'user-1', uplink: 100, downlink: 200 },
    ]);
    await expect(store.getCombinedStats(false)).resolves.toEqual({
      inbounds: [{ inbound: 'VLESS_WS', uplink: 100, downlink: 200 }],
      outbounds: [{ outbound: 'DIRECT', uplink: 100, downlink: 200 }],
    });

    await expect(store.getCombinedStats(true)).resolves.toEqual({
      inbounds: [{ inbound: 'VLESS_WS', uplink: 100, downlink: 200 }],
      outbounds: [{ outbound: 'DIRECT', uplink: 100, downlink: 200 }],
    });
    await expect(store.getCombinedStats(false)).resolves.toEqual({
      inbounds: [],
      outbounds: [],
    });
  });

  it('resets all inbound and outbound node counters independently', async () => {
    const db = new FakeD1Database();
    const store = new TrafficStore(db as unknown as D1Database);

    await store.record(stats({ type: 'tcp', uplink: 100, downlink: 200 }));
    await store.record(stats({ type: 'xhttp', uplink: 25, downlink: 50 }));

    await expect(store.getAllInboundStats(true)).resolves.toEqual([
      { inbound: 'VLESS_WS', uplink: 100, downlink: 200 },
      { inbound: 'VLESS_XHTTP', uplink: 25, downlink: 50 },
    ]);
    await expect(store.getAllOutboundStats(false)).resolves.toEqual([
      { outbound: 'DIRECT', uplink: 125, downlink: 250 },
    ]);
    await expect(store.getAllInboundStats(false)).resolves.toEqual([]);

    await expect(store.getAllOutboundStats(true)).resolves.toEqual([
      { outbound: 'DIRECT', uplink: 125, downlink: 250 },
    ]);
    await expect(store.getAllOutboundStats(false)).resolves.toEqual([]);
  });
});

function stats(overrides: Partial<TrafficStats> = {}): TrafficStats {
  return {
    uuid: 'user-1',
    uplink: 0,
    downlink: 0,
    type: 'tcp',
    ...overrides,
  };
}
