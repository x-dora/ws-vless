import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Root path handler', () => {
	it('returns JSON response with cf info (unit style)', async () => {
		const request = new IncomingRequest('http://example.com/', {
			cf: { colo: 'SJC', country: 'US' } as IncomingRequestCfProperties,
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');
		
		const json = await response.json();
		expect(json).toHaveProperty('colo', 'SJC');
		expect(json).toHaveProperty('country', 'US');
	});

	it('returns fallback JSON when no cf object (unit style)', async () => {
		const request = new IncomingRequest('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');
		
		const json = await response.json();
		expect(json).toHaveProperty('message', 'Tunnel Worker Running');
	});

	it('returns JSON response (integration style)', async () => {
		const response = await SELF.fetch('https://example.com/');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');
		
		const json = await response.json();
		// In integration test, cf object should exist
		expect(json).toBeDefined();
	});
});

describe('404 handler', () => {
	it('returns 404 for unknown paths', async () => {
		const request = new IncomingRequest('http://example.com/unknown-path');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not Found');
	});

	it('returns 404 for invalid UUID paths', async () => {
		const request = new IncomingRequest('http://example.com/not-a-uuid');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
	});
});
