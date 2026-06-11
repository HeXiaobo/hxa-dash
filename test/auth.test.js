import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  requireIngestAuth,
  requireIngestAuthUnlessEnvFlag,
} = require('../src/auth/api-key.js');
const authMiddleware = require('../src/auth/middleware.js');
const { authenticateRequest } = authMiddleware;
const { isPublicRequest } = require('../src/auth/policy.js');
const { signState, signToken, verifyState, verifyToken } = require('../src/auth/token.js');

const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
}

function enableAuth() {
  process.env.HXA_AUTH_ENABLED = 'true';
  process.env.FEISHU_APP_ID = 'cli_test';
  process.env.FEISHU_APP_SECRET = 'secret';
  process.env.FEISHU_TENANT_KEY = 'tenant-a';
  process.env.HXA_AUTH_SECRET = 'a'.repeat(64);
}

function req({ method = 'GET', path = '/', cookie = '', headers = {} } = {}) {
  return {
    method,
    path,
    url: path,
    originalUrl: path,
    protocol: 'https',
    headers: {
      cookie,
      host: 'hxa.example.test',
      ...headers,
    },
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
}

function res() {
  return {
    statusCode: 200,
    body: null,
    redirectUrl: null,
    clearedCookie: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    redirect(url) {
      this.statusCode = 302;
      this.redirectUrl = url;
      return this;
    },
    clearCookie(name, options) {
      this.clearedCookie = { name, options };
      return this;
    },
  };
}

function runMiddleware(middleware, request) {
  const response = res();
  let nextCalled = false;
  middleware(request, response, () => { nextCalled = true; });
  return { response, nextCalled };
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  resetEnv();
});

describe('auth token helpers', () => {
  it('signs and verifies browser tokens', () => {
    enableAuth();
    const token = signToken({
      openId: 'ou_test',
      unionId: 'on_test',
      name: 'Tester',
      avatarUrl: '',
      tenantKey: 'tenant-a',
    });

    expect(verifyToken(token)).toMatchObject({
      open_id: 'ou_test',
      tenant_key: 'tenant-a',
      iss: 'hxa-dash',
    });
  });

  it('rejects tampered OAuth state', () => {
    enableAuth();
    const state = signState({ returnTo: '/#limits' });
    const tampered = state.replace(/\.[^.]+$/, '.bad');
    expect(verifyState(tampered)).toBeNull();
    expect(verifyState(state).return_to).toBe('/#limits');
  });
});

describe('auth route policy', () => {
  it('keeps health/about and active machine ingest routes public', () => {
    expect(isPublicRequest(req({ method: 'GET', path: '/api/health' }))).toBe(true);
    expect(isPublicRequest(req({ method: 'GET', path: '/api/about' }))).toBe(true);
    expect(isPublicRequest(req({ method: 'POST', path: '/api/report' }))).toBe(true);
    expect(isPublicRequest(req({ method: 'POST', path: '/api/report/activity' }))).toBe(true);
    expect(isPublicRequest(req({ method: 'POST', path: '/api/webhook/connect' }))).toBe(true);
    expect(isPublicRequest(req({ method: 'POST', path: '/api/webhook/gitlab' }))).toBe(true);
    expect(isPublicRequest(req({ method: 'POST', path: '/api/agent-health/mylos' }))).toBe(true);
  });

  it('protects browser-facing APIs and report summary reads', () => {
    expect(isPublicRequest(req({ method: 'GET', path: '/api/team' }))).toBe(false);
    expect(isPublicRequest(req({ method: 'GET', path: '/api/tokens' }))).toBe(false);
    expect(isPublicRequest(req({ method: 'GET', path: '/api/report/summary' }))).toBe(false);
  });
});

describe('auth middleware', () => {
  it('allows everything when auth is disabled', () => {
    process.env.HXA_AUTH_ENABLED = 'false';
    const result = runMiddleware(authMiddleware, req({ path: '/api/team' }));
    expect(result.nextCalled).toBe(true);
  });

  it('returns JSON 401 for protected APIs without a token', () => {
    enableAuth();
    const result = runMiddleware(authMiddleware, req({ path: '/api/team' }));
    expect(result.nextCalled).toBe(false);
    expect(result.response.statusCode).toBe(401);
    expect(result.response.body).toEqual({ error: 'auth_required' });
  });

  it('redirects browser requests without a token', () => {
    enableAuth();
    const result = runMiddleware(authMiddleware, req({ path: '/#limits' }));
    expect(result.nextCalled).toBe(false);
    expect(result.response.statusCode).toBe(302);
    expect(result.response.redirectUrl).toContain('/auth/login?return_to=');
  });

  it('allows protected APIs with a valid tenant token', () => {
    enableAuth();
    const token = signToken({ openId: 'ou_test', unionId: 'on_test', name: 'Tester', avatarUrl: '', tenantKey: 'tenant-a' });
    const request = req({ path: '/api/team', cookie: `hxa_token=${encodeURIComponent(token)}` });
    const result = runMiddleware(authMiddleware, request);
    expect(result.nextCalled).toBe(true);
    expect(request.user.open_id).toBe('ou_test');
  });

  it('clears tenant-mismatched cookies', () => {
    enableAuth();
    const token = signToken({ openId: 'ou_test', unionId: 'on_test', name: 'Tester', avatarUrl: '', tenantKey: 'tenant-b' });
    const result = runMiddleware(authMiddleware, req({ path: '/', cookie: `hxa_token=${encodeURIComponent(token)}` }));
    expect(result.nextCalled).toBe(false);
    expect(result.response.clearedCookie.name).toBe('hxa_token');
    expect(result.response.redirectUrl).toContain('/auth/denied?reason=tenant_mismatch');
  });

  it('uses the same request authenticator for WebSocket handshakes', () => {
    enableAuth();
    const token = signToken({ openId: 'ou_test', unionId: 'on_test', name: 'Tester', avatarUrl: '', tenantKey: 'tenant-a' });
    expect(authenticateRequest(req({ path: '/ws', cookie: `hxa_token=${encodeURIComponent(token)}` }))).toMatchObject({ ok: true });
    expect(authenticateRequest(req({ path: '/ws' }))).toMatchObject({ ok: false, code: 'auth_required' });
  });
});

describe('machine ingest API key guard', () => {
  it('requires X-API-Key for ingest routes when auth is enabled', () => {
    enableAuth();
    process.env.HXA_INGEST_API_KEY = 'ingest-secret';

    const denied = runMiddleware(requireIngestAuth, req({ method: 'POST', path: '/api/report' }));
    expect(denied.nextCalled).toBe(false);
    expect(denied.response.statusCode).toBe(401);

    const allowed = runMiddleware(requireIngestAuth, req({
      method: 'POST',
      path: '/api/report',
      headers: { 'x-api-key': 'ingest-secret' },
    }));
    expect(allowed.nextCalled).toBe(true);
  });

  it('allows an explicit temporary public ingest flag', () => {
    enableAuth();
    process.env.HXA_INGEST_API_KEY = 'ingest-secret';
    const middleware = requireIngestAuthUnlessEnvFlag('HXA_CONNECT_WEBHOOK_PUBLIC');

    const denied = runMiddleware(middleware, req({ method: 'POST', path: '/api/webhook/connect' }));
    expect(denied.nextCalled).toBe(false);
    expect(denied.response.statusCode).toBe(401);

    process.env.HXA_CONNECT_WEBHOOK_PUBLIC = 'true';
    const allowed = runMiddleware(middleware, req({ method: 'POST', path: '/api/webhook/connect' }));
    expect(allowed.nextCalled).toBe(true);
  });
});
