import { createLogger } from '@helpdesk/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSession, hashPassword, isValidSession, SESSION_COOKIE, verifyPassword } from '../src/auth.js';
import type { CallDetail } from '../src/queries.js';
import { buildServer, type ServerOptions } from '../src/server.js';
import { escapeHtml, html } from '../src/views.js';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'x'.repeat(32);
const SCRIPT = '<script>alert(1)</script>';

const baseCall = {
  callSid: 'CA1',
  from: '+38344000000',
  startedAt: new Date('2026-11-05T10:00:00Z'),
  durationMs: 95_000,
  endReason: 'transferred',
  costUsd: 0.0421,
  turns: 2,
  messages: 1,
};

const detail: CallDetail = {
  ...baseCall,
  to: '+1555',
  model: 'gpt-realtime-2.1-mini',
  traceId: 'abc123',
  transcript: [
    { role: 'caller', text: 'Hello', interrupted: false },
    { role: 'agent', text: 'We open at 8', interrupted: true },
  ],
  callMessages: [],
  transfers: [{ reason: 'asked for a person', occurredAt: new Date('2026-11-05T10:01:00Z') }],
};

const message = {
  callSid: 'CA1',
  name: 'Arta',
  phone: '+38344000000',
  message: 'Please call me back',
  occurredAt: new Date('2026-11-05T10:01:00Z'),
  notifiedAt: new Date('2026-11-05T10:01:01Z'),
};

let passwordHash: string;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function server(overrides: Partial<ServerOptions> = {}): FastifyInstance {
  app = buildServer({
    queries: {
      totals: vi.fn(async () => ({ calls: 1, messages: 1, costUsd: 0.0421 })),
      listCalls: vi.fn(async () => [baseCall]),
      getCall: vi.fn(async (sid: string) => (sid === 'CA1' ? detail : undefined)),
      listMessages: vi.fn(async () => [message]),
    },
    passwordHash,
    sessionSecret: SECRET,
    secureCookies: true,
    jaegerUrl: 'http://localhost:16686',
    log: createLogger('test', 'silent'),
    ...overrides,
  });
  return app;
}

const signedIn = () => ({ cookie: `${SESSION_COOKIE}=${createSession(SECRET, 60_000)}` });

const login = (target: FastifyInstance, password: string) =>
  target.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ password }).toString(),
  });

describe('passwords', () => {
  it('accepts the right password and rejects others', async () => {
    expect(await verifyPassword(PASSWORD, passwordHash)).toBe(true);
    expect(await verifyPassword('wrong', passwordHash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(passwordHash);
  });

  it('writes hashes with no $ signs, which Docker Compose would mangle', () => {
    expect(passwordHash).not.toContain('$');
  });

  it('rejects a malformed stored hash instead of crashing', async () => {
    expect(await verifyPassword('x', 'nonsense')).toBe(false);
  });
});

describe('sessions', () => {
  it('accepts a session it issued', () => {
    expect(isValidSession(createSession(SECRET, 1000), SECRET)).toBe(true);
  });

  it('rejects an expired session', () => {
    const token = createSession(SECRET, 1000, Date.now() - 5000);
    expect(isValidSession(token, SECRET)).toBe(false);
  });

  it('rejects a session signed with another secret', () => {
    expect(isValidSession(createSession('y'.repeat(32), 1000), SECRET)).toBe(false);
  });

  it('rejects a session with its expiry extended by hand', () => {
    const [, signature] = createSession(SECRET, 1000).split('.');
    expect(isValidSession(`${Date.now() + 9_999_999}.${signature}`, SECRET)).toBe(false);
  });

  it.each([[undefined], [''], ['garbage'], ['a.b.c'], ['.']])('rejects %s', (token) => {
    expect(isValidSession(token, SECRET)).toBe(false);
  });
});

describe('access control', () => {
  it.each(['/', '/messages', '/calls/CA1'])('sends visitors from %s to sign in', async (url) => {
    const response = await server().inject({ method: 'GET', url });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login');
    expect(response.body).not.toContain('Arta');
  });

  it('protects pages that are added later, because public paths are a short allow-list', async () => {
    const target = server();
    target.get('/some-new-page', async () => 'secret');
    const response = await target.inject({ method: 'GET', url: '/some-new-page' });
    expect(response.statusCode).toBe(302);
  });

  it('rejects a forged session cookie', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/',
      headers: { cookie: `${SESSION_COOKIE}=9999999999999.forged` },
    });
    expect(response.statusCode).toBe(302);
  });

  it('allows the health check and stylesheet without a session', async () => {
    const target = server();
    expect((await target.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await target.inject({ method: 'GET', url: '/style.css' })).statusCode).toBe(200);
  });
});

describe('sign in', () => {
  it('signs in with the right password and sets a safe cookie', async () => {
    const response = await login(server(), PASSWORD);

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/');
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
  });

  it('turns away a wrong password with no cookie', async () => {
    const response = await login(server(), 'wrong');
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('locks out after too many attempts', async () => {
    const target = server({ maxLoginAttempts: 3 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await login(target, 'wrong')).statusCode).toBe(401);
    }
    expect((await login(target, 'wrong')).statusCode).toBe(429);
  });

  it('stays locked even for the right password, or the limit would be pointless', async () => {
    const target = server({ maxLoginAttempts: 1 });
    await login(target, 'wrong');
    expect((await login(target, PASSWORD)).statusCode).toBe(429);
  });

  it('signs out by clearing the cookie', async () => {
    const response = await server().inject({ method: 'POST', url: '/logout', headers: signedIn() });
    expect(response.statusCode).toBe(303);
    expect(String(response.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
  });
});

describe('pages', () => {
  const get = (url: string, options: Partial<ServerOptions> = {}) =>
    server(options).inject({ method: 'GET', url, headers: signedIn() });

  it('lists calls with cost and outcome', async () => {
    const { body, statusCode } = await get('/');
    expect(statusCode).toBe(200);
    expect(body).toContain('+38344000000');
    expect(body).toContain('$0.0421');
    expect(body).toContain('Transferred');
    expect(body).toContain('1:35');
  });

  it('says so when there are no calls', async () => {
    const { body } = await get('/', {
      queries: {
        totals: async () => ({ calls: 0, messages: 0, costUsd: 0 }),
        listCalls: async () => [],
        getCall: async () => undefined,
        listMessages: async () => [],
      },
    });
    expect(body).toContain('No calls yet');
  });

  it('shows a call with its transcript, transfer and trace link', async () => {
    const { body } = await get('/calls/CA1');
    expect(body).toContain('We open at 8');
    expect(body).toContain('(interrupted)');
    expect(body).toContain('asked for a person');
    expect(body).toContain('http://localhost:16686/trace/abc123');
  });

  it('returns 404 for an unknown call', async () => {
    expect((await get('/calls/CA404')).statusCode).toBe(404);
  });

  it('flags a message whose email never went out', async () => {
    const { body } = await get('/messages', {
      queries: {
        totals: vi.fn(),
        listCalls: vi.fn(),
        getCall: vi.fn(),
        listMessages: async () => [{ ...message, notifiedAt: null }],
      },
    });
    expect(body).toContain('Email not sent');
  });

  it('ignores a nonsense page number', async () => {
    const listCalls = vi.fn(async () => []);
    await get('/?page=-1', {
      queries: { totals: async () => ({ calls: 0, messages: 0, costUsd: 0 }), listCalls, getCall: vi.fn(), listMessages: vi.fn() },
    });
    expect(listCalls).toHaveBeenCalledWith(1);
  });

  it('sets a strict content security policy', async () => {
    const { headers } = await get('/');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['content-security-policy']).not.toContain('unsafe-inline');
  });

  it('tells browsers not to cache call data', async () => {
    expect((await get('/')).headers['cache-control']).toBe('no-store');
  });
});

describe('untrusted caller text', () => {
  const hostile = {
    ...detail,
    from: SCRIPT,
    transcript: [{ role: 'caller' as const, text: SCRIPT, interrupted: false }],
    callMessages: [{ ...message, name: SCRIPT, phone: SCRIPT, message: SCRIPT }],
    transfers: [{ reason: SCRIPT, occurredAt: new Date() }],
  };
  const queries = {
    totals: async () => ({ calls: 1, messages: 1, costUsd: 0 }),
    listCalls: async () => [{ ...baseCall, from: SCRIPT }],
    getCall: async () => hostile,
    listMessages: async () => [{ ...message, name: SCRIPT, phone: SCRIPT, message: SCRIPT }],
  };

  it.each(['/', '/calls/CA1', '/messages'])('shows HTML as plain text on %s', async (url) => {
    const { body } = await server({ queries }).inject({ method: 'GET', url, headers: signedIn() });
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('cannot break out of a link with a crafted call ID', async () => {
    const { body } = await server({
      queries: { ...queries, listCalls: async () => [{ ...baseCall, callSid: '"><script>x</script>' }] },
    }).inject({ method: 'GET', url: '/', headers: signedIn() });
    expect(body).not.toContain('<script>');
  });
});

describe('html template', () => {
  it('escapes every special character', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('escapes interpolated values but not its own output', () => {
    const inner = html`<b>${'<i>'}</b>`;
    expect(html`<p>${inner}</p>`.toString()).toBe('<p><b>&lt;i&gt;</b></p>');
  });

  it('treats null and undefined as empty', () => {
    expect(html`<p>${null}${undefined}</p>`.toString()).toBe('<p></p>');
  });
});
