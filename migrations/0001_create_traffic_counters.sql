CREATE TABLE IF NOT EXISTS traffic_counters (
  uuid TEXT NOT NULL,
  inbound_tag TEXT NOT NULL,
  outbound_tag TEXT NOT NULL,
  uplink INTEGER NOT NULL DEFAULT 0,
  downlink INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uuid, inbound_tag, outbound_tag)
);

CREATE INDEX IF NOT EXISTS idx_traffic_inbound_tag ON traffic_counters(inbound_tag);
CREATE INDEX IF NOT EXISTS idx_traffic_outbound_tag ON traffic_counters(outbound_tag);
