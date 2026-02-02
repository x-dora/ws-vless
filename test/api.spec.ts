import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Mock environment with API_KEY
const createEnvWithApiKey = (apiKey: string) => ({
	...env,
	API_KEY: apiKey,
	DEV_MODE: 'true',
	UUID: 'test-uuid-1234-5678-9abc-def012345678',
});

describe('API authentication', () => {
	const testApiKey = 'test-secret-key-12345';

	it('rejects /api/uuids without API_KEY configured', async () => {
		const request = new IncomingRequest('http://example.com/api/uuids');
		const ctx = createExecutionContext();
		
		// Create env without API_KEY
		const envWithoutKey = { ...env };
		// @ts-ignore
		delete envWithoutKey.API_KEY;

		const response = await worker.fetch(request, envWithoutKey, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		const json = await response.json() as { error: string };
		expect(json.error).toContain('API_KEY not configured');
	});

	it('rejects /api/uuids without providing key', async () => {
		const request = new IncomingRequest('http://example.com/api/uuids');
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		const json = await response.json() as { error: string };
		expect(json.error).toContain('API key required');
	});

	it('rejects /api/uuids with invalid key', async () => {
		const request = new IncomingRequest('http://example.com/api/uuids', {
			headers: { 'X-API-Key': 'wrong-key' },
		});
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		const json = await response.json() as { error: string };
		expect(json.error).toContain('Invalid API key');
	});

	it('accepts /api/uuids with valid X-API-Key header', async () => {
		const request = new IncomingRequest('http://example.com/api/uuids', {
			headers: { 'X-API-Key': testApiKey },
		});
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');
	});

	it('accepts /api/uuids with Bearer token', async () => {
		const request = new IncomingRequest('http://example.com/api/uuids', {
			headers: { 'Authorization': `Bearer ${testApiKey}` },
		});
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
	});

	it('accepts /api/uuids with query parameter key', async () => {
		const request = new IncomingRequest(`http://example.com/api/uuids?key=${testApiKey}`);
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
	});
});

describe('/api/uuids endpoint', () => {
	const testApiKey = 'test-api-key';

	it('returns UUID list in JSON format', async () => {
		const request = new IncomingRequest('http://example.com/api/uuids', {
			headers: { 'X-API-Key': testApiKey },
		});
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as { uuids: string[]; count: number };
		expect(json).toHaveProperty('uuids');
		expect(json).toHaveProperty('count');
		expect(Array.isArray(json.uuids)).toBe(true);
		expect(json.count).toBe(json.uuids.length);
	});

	it('includes default UUID in dev mode', async () => {
		const testUUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
		const request = new IncomingRequest('http://example.com/api/uuids', {
			headers: { 'X-API-Key': testApiKey },
		});
		const ctx = createExecutionContext();
		const testEnv = {
			...env,
			API_KEY: testApiKey,
			DEV_MODE: 'true',
			UUID: testUUID,
		};
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as { uuids: string[]; count: number };
		expect(json.uuids).toContain(testUUID);
	});
});

describe('/api/stats endpoint', () => {
	const testApiKey = 'test-api-key';

	it('requires authentication', async () => {
		const request = new IncomingRequest('http://example.com/api/stats');
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
	});

	it('returns stats in JSON format', async () => {
		const request = new IncomingRequest('http://example.com/api/stats', {
			headers: { 'X-API-Key': testApiKey },
		});
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json');
		
		const json = await response.json();
		// Stats should be an object (structure depends on provider implementation)
		expect(typeof json).toBe('object');
	});
});

describe('/api/uuids/refresh endpoint', () => {
	const testApiKey = 'test-api-key';

	it('requires authentication', async () => {
		const request = new IncomingRequest('http://example.com/api/uuids/refresh');
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
	});

	it('refreshes cache and returns updated UUIDs', async () => {
		const request = new IncomingRequest('http://example.com/api/uuids/refresh', {
			headers: { 'X-API-Key': testApiKey },
		});
		const ctx = createExecutionContext();
		const testEnv = createEnvWithApiKey(testApiKey);
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as { message: string; uuids: string[]; count: number };
		expect(json.message).toBe('Cache refreshed');
		expect(json).toHaveProperty('uuids');
		expect(json).toHaveProperty('count');
	});
});
