import { describe, expect, it } from 'vitest';

const REMNAWAVE_GET_PLACEHOLDERS = [
  'health',
  'node/stats/get-system-stats',
  'node/xray/healthcheck',
  'node/xray/start',
  'node/xray/status',
  'node/xray/stop',
];

const DYNAMIC_STATS_ENDPOINTS = [
  'node/stats/get-users-stats',
  'node/stats/get-combined-stats',
  'node/stats/get-inbound-stats',
  'node/stats/get-outbound-stats',
  'node/stats/get-all-inbounds-stats',
  'node/stats/get-all-outbounds-stats',
];

const publicAssets = import.meta.glob('../public/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

describe('Remnawave public assets', () => {
  it('keeps static GET placeholders as valid JSON files', () => {
    for (const assetPath of REMNAWAVE_GET_PLACEHOLDERS) {
      const content = publicAssets[`../public/${assetPath}`];

      expect(content, `${assetPath} should stay in public/`).toBeDefined();
      expect(() => JSON.parse(content)).not.toThrow();
    }
  });

  it('keeps dynamic stats POST endpoints out of public assets', () => {
    for (const assetPath of DYNAMIC_STATS_ENDPOINTS) {
      expect(
        publicAssets[`../public/${assetPath}`],
        `${assetPath} should be handled by Worker routes`,
      ).toBeUndefined();
    }
  });
});
