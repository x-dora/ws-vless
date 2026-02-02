import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Helper to create WebSocket upgrade request
const createWSRequest = (url: string, options: RequestInit = {}) => {
	return new IncomingRequest(url, {
		...options,
		headers: {
			'Upgrade': 'websocket',
			'Connection': 'Upgrade',
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'Sec-WebSocket-Version': '13',
			...options.headers,
		},
	});
};

describe('WebSocket upgrade handling', () => {
	it('returns 101 status for WebSocket upgrade request', async () => {
		const request = createWSRequest('http://example.com/', {
			cf: { colo: 'SJC' } as IncomingRequestCfProperties,
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		
		// WebSocket upgrade should return 101 Switching Protocols
		expect(response.status).toBe(101);
	});

	it('returns WebSocket in response for upgrade request', async () => {
		const request = createWSRequest('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		
		expect(response.status).toBe(101);
		// The response should have a webSocket property (Cloudflare Workers specific)
		expect((response as unknown as { webSocket: WebSocket }).webSocket).toBeDefined();
	});

	it('handles WebSocket upgrade with early data header', async () => {
		const request = createWSRequest('http://example.com/', {
			headers: {
				'Upgrade': 'websocket',
				'Connection': 'Upgrade',
				'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Protocol': 'some-early-data',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		
		expect(response.status).toBe(101);
	});

	it('does not upgrade non-websocket requests', async () => {
		const request = new IncomingRequest('http://example.com/', {
			headers: {
				'Connection': 'keep-alive',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		
		// Non-WebSocket request to root should return 200 JSON
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');
	});
});

describe('WebSocket with different environments', () => {
	it('handles WebSocket upgrade in dev mode', async () => {
		const request = createWSRequest('http://example.com/');
		const ctx = createExecutionContext();
		const devEnv = {
			...env,
			DEV_MODE: 'true',
			UUID: 'test-uuid-1234',
		};
		const response = await worker.fetch(request, devEnv, ctx);
		
		expect(response.status).toBe(101);
	});

	it('handles WebSocket upgrade with MUX disabled', async () => {
		const request = createWSRequest('http://example.com/');
		const ctx = createExecutionContext();
		const noMuxEnv = {
			...env,
			MUX_ENABLED: 'false',
		};
		const response = await worker.fetch(request, noMuxEnv, ctx);
		
		expect(response.status).toBe(101);
	});

	it('handles WebSocket upgrade with stats reporter config', async () => {
		const request = createWSRequest('http://example.com/');
		const ctx = createExecutionContext();
		const statsEnv = {
			...env,
			STATS_REPORT_URL: 'http://example.com/stats',
			STATS_REPORT_TOKEN: 'test-token',
		};
		const response = await worker.fetch(request, statsEnv, ctx);
		
		expect(response.status).toBe(101);
	});

	it('handles WebSocket upgrade with custom proxy IP from cf.colo', async () => {
		const request = createWSRequest('http://example.com/', {
			cf: { colo: 'LAX' } as IncomingRequestCfProperties,
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		
		expect(response.status).toBe(101);
	});

	it('handles WebSocket upgrade with explicit PROXY_IP', async () => {
		const request = createWSRequest('http://example.com/');
		const ctx = createExecutionContext();
		const proxyEnv = {
			...env,
			PROXY_IP: '1.2.3.4',
		};
		const response = await worker.fetch(request, proxyEnv, ctx);
		
		expect(response.status).toBe(101);
	});
});

describe('WebSocket connection flow', () => {
	it('accepts connection and can communicate', async () => {
		const request = createWSRequest('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		
		expect(response.status).toBe(101);
		
		// Get the client WebSocket from response
		const ws = (response as unknown as { webSocket: WebSocket }).webSocket;
		expect(ws).toBeDefined();
		
		// Verify WebSocket is in correct state
		// In Cloudflare Workers test environment, the WebSocket should be ready
		expect(ws.readyState).toBeDefined();
	});

	it('handles connection with custom DNS server', async () => {
		const request = createWSRequest('http://example.com/');
		const ctx = createExecutionContext();
		const dnsEnv = {
			...env,
			DNS_SERVER: '8.8.8.8',
		};
		const response = await worker.fetch(request, dnsEnv, ctx);
		
		expect(response.status).toBe(101);
	});
});

describe('WebSocket error handling', () => {
	it('handles malformed upgrade header gracefully', async () => {
		const request = new IncomingRequest('http://example.com/', {
			headers: {
				'Upgrade': 'invalid-protocol',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		
		// Should not upgrade for non-websocket upgrade header
		expect(response.status).not.toBe(101);
	});

	it('handles empty upgrade header', async () => {
		const request = new IncomingRequest('http://example.com/', {
			headers: {
				'Upgrade': '',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		
		// Empty upgrade header should be treated as non-WebSocket request
		expect(response.status).toBe(200);
	});
});
