/**
 * API 鉴权服务
 */

export interface AuthResult {
  authorized: boolean;
  reason?: string;
}

export class AuthService {
  constructor(private readonly apiKey?: string) {}

  authorize(request: Request): AuthResult {
    if (!this.apiKey) {
      return {
        authorized: false,
        reason: 'API access disabled: API_KEY not configured',
      };
    }

    const url = new URL(request.url);
    const headerKey =
      request.headers.get('X-API-Key') ||
      request.headers.get('Authorization')?.replace('Bearer ', '');
    const queryKey = url.searchParams.get('key');
    const providedKey = headerKey || queryKey;

    if (!providedKey) {
      return {
        authorized: false,
        reason: 'API key required. Use X-API-Key header or ?key= query parameter',
      };
    }

    if (providedKey !== this.apiKey) {
      return {
        authorized: false,
        reason: 'Invalid API key',
      };
    }

    return {
      authorized: true,
    };
  }
}
