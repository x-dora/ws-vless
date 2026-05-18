CREATE TABLE IF NOT EXISTS traffic_node_counters (
  direction TEXT NOT NULL,
  tag TEXT NOT NULL,
  uplink INTEGER NOT NULL DEFAULT 0,
  downlink INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (direction, tag)
);

CREATE INDEX IF NOT EXISTS idx_traffic_node_direction ON traffic_node_counters(direction);
