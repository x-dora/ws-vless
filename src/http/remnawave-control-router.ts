const WORKER_NODE_VERSION = '2.7.0';
const XRAY_VERSION = '25.3.6';

export class RemnawaveControlRouter {
  canHandle(request: Request): boolean {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/node/')) {
      return false;
    }

    return CONTROL_RESPONSES.has(`${request.method.toUpperCase()} ${url.pathname}`);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const response = CONTROL_RESPONSES.get(`${request.method.toUpperCase()} ${url.pathname}`);
    if (!response) {
      return this.json({ error: 'Not Found' }, 404);
    }

    return this.json(response);
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

const CONTROL_RESPONSES = new Map<string, unknown>([
  [
    'POST /node/xray/start',
    {
      response: {
        isStarted: true,
        version: XRAY_VERSION,
        error: null,
        nodeInformation: {
          version: WORKER_NODE_VERSION,
        },
        system: getStaticSystem(),
      },
    },
  ],
  [
    'GET /node/xray/stop',
    {
      response: {
        isStopped: true,
      },
    },
  ],
  [
    'POST /node/xray/stop',
    {
      response: {
        isStopped: true,
      },
    },
  ],
  ['POST /node/handler/add-user', genericSuccess()],
  ['POST /node/handler/add-users', genericSuccess()],
  ['POST /node/handler/remove-user', genericSuccess()],
  ['POST /node/handler/remove-users', genericSuccess()],
  [
    'POST /node/handler/drop-users-connections',
    {
      response: {
        success: true,
      },
    },
  ],
  [
    'POST /node/handler/drop-ips',
    {
      response: {
        success: true,
      },
    },
  ],
  [
    'POST /node/handler/get-inbound-users-count',
    {
      response: {
        count: 0,
      },
    },
  ],
  [
    'POST /node/handler/get-inbound-users',
    {
      response: {
        users: [],
      },
    },
  ],
  [
    'POST /node/plugin/sync',
    {
      response: {
        accepted: true,
      },
    },
  ],
  [
    'POST /node/plugin/torrent-blocker/collect',
    {
      response: {
        reports: [],
      },
    },
  ],
  ['POST /node/plugin/nftables/block-ips', accepted()],
  ['POST /node/plugin/nftables/unblock-ips', accepted()],
  ['POST /node/plugin/nftables/recreate-tables', accepted()],
]);

function genericSuccess() {
  return {
    response: {
      success: true,
      error: null,
    },
  };
}

function accepted() {
  return {
    response: {
      accepted: true,
    },
  };
}

function getStaticSystem() {
  return {
    info: {
      arch: 'worker',
      cpus: 1,
      cpuModel: 'Cloudflare Workers',
      memoryTotal: 0,
      hostname: 'cloudflare-worker',
      platform: 'workers',
      release: WORKER_NODE_VERSION,
      type: 'worker',
      version: WORKER_NODE_VERSION,
      networkInterfaces: [],
    },
    stats: {
      memoryFree: 0,
      memoryUsed: 0,
      uptime: 1,
      loadAvg: [0, 0, 0],
      interface: null,
    },
  };
}
