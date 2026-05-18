import type { TrafficStatsService } from '../services/stats-reporter';
import { DEFAULT_OUTBOUND_TAG, WS_INBOUND_TAG } from '../services/traffic-store';
import type { SubrequestBudget } from '../utils/subrequest-budget';

interface RemnawaveStatsRouterOptions {
  trafficStatsService: TrafficStatsService;
}

interface StatsRequestBody {
  reset?: boolean;
  tag?: string;
}

export class RemnawaveStatsRouter {
  constructor(private readonly options: RemnawaveStatsRouterOptions) {}

  canHandle(request: Request): boolean {
    const url = new URL(request.url);
    return request.method === 'POST' && url.pathname.startsWith('/node/stats/');
  }

  async handle(request: Request, budget?: SubrequestBudget): Promise<Response> {
    const url = new URL(request.url);
    const body = await parseStatsBody(request);
    const reset = body.reset === true;

    switch (url.pathname) {
      case '/node/stats/get-users-stats':
        return this.json({
          response: {
            users: (await this.options.trafficStatsService.getUsersStats(reset, budget)) ?? [],
          },
        });

      case '/node/stats/get-combined-stats':
        return this.json({
          response:
            (await this.options.trafficStatsService.getCombinedStats(reset, budget)) ??
            emptyCombinedStats(),
        });

      case '/node/stats/get-inbound-stats':
        return this.json({
          response: (await this.options.trafficStatsService.getInboundStats(
            body.tag,
            reset,
            budget,
          )) ?? {
            inbound: body.tag || WS_INBOUND_TAG,
            uplink: 0,
            downlink: 0,
          },
        });

      case '/node/stats/get-outbound-stats':
        return this.json({
          response: (await this.options.trafficStatsService.getOutboundStats(
            body.tag,
            reset,
            budget,
          )) ?? {
            outbound: body.tag || DEFAULT_OUTBOUND_TAG,
            uplink: 0,
            downlink: 0,
          },
        });

      case '/node/stats/get-all-inbounds-stats':
        return this.json({
          response: {
            inbounds:
              (await this.options.trafficStatsService.getAllInboundStats(reset, budget)) ?? [],
          },
        });

      case '/node/stats/get-all-outbounds-stats':
        return this.json({
          response: {
            outbounds:
              (await this.options.trafficStatsService.getAllOutboundStats(reset, budget)) ?? [],
          },
        });

      default:
        return this.json({ error: 'Not Found' }, 404);
    }
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }
}

async function parseStatsBody(request: Request): Promise<StatsRequestBody> {
  try {
    const body = (await request.json()) as StatsRequestBody;
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function emptyCombinedStats() {
  return {
    inbounds: [],
    outbounds: [],
  };
}
