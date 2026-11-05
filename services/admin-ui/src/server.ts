import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import type { Logger } from '@helpdesk/shared';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { createSession, isValidSession, SESSION_COOKIE, verifyPassword } from './auth.js';
import { PAGE_SIZE, type AdminQueries } from './queries.js';
import {
  callPage,
  callsPage,
  loginPage,
  messagesPage,
  notFoundPage,
  STYLESHEET,
} from './views.js';

const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/login', '/style.css', '/healthz']);

export interface ServerOptions {
  queries: Pick<AdminQueries, 'totals' | 'listCalls' | 'getCall' | 'listMessages'>;
  passwordHash: string;
  sessionSecret: string;
  /** False only for plain HTTP on localhost. */
  secureCookies: boolean;
  jaegerUrl?: string;
  /** Failed sign-ins allowed per window, before the IP is locked out. */
  maxLoginAttempts?: number;
  log: Logger;
}

const page = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

const sendHtml = (reply: FastifyReply, body: string, status = 200) =>
  reply.code(status).type('text/html; charset=utf-8').send(body);

export function buildServer(options: ServerOptions): FastifyInstance {
  const { queries, log } = options;
  const app = Fastify({ trustProxy: false });

  app.register(formbody);
  app.register(cookie);
  app.register(rateLimit, { global: false });

  // The pages use no scripts and no third-party content, so everything else stays blocked.
  app.addHook('onSend', async (_request, reply) => {
    reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
  });

  // Everything needs a session unless it's listed as public, so a new page is safe by default.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (PUBLIC_PATHS.has(path)) return;

    if (!isValidSession(request.cookies[SESSION_COOKIE], options.sessionSecret)) {
      return reply.redirect('/login');
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/style.css', async (_request, reply) => reply.type('text/css').send(STYLESHEET));

  app.get('/login', async (_request, reply) => sendHtml(reply, loginPage()));

  // In its own plugin, because the rate limiter only applies to routes added after
  // it has loaded. Added directly to `app`, this route would silently have no limit.
  app.register(async (scoped) => {
    scoped.post(
      '/login',
      {
        config: {
          rateLimit: {
            max: options.maxLoginAttempts ?? 5,
            timeWindow: '15 minutes',
            errorResponseBuilder: () => ({
              statusCode: 429,
              error: 'Too many attempts',
              message: 'Too many sign-in attempts. Try again in 15 minutes.',
            }),
          },
        },
      },
      async (request, reply) => {
        const { password } = (request.body ?? {}) as { password?: unknown };

        if (typeof password !== 'string' || !(await verifyPassword(password, options.passwordHash))) {
          log.warn('failed sign-in attempt');
          return sendHtml(reply, loginPage('That password is not right.'), 401);
        }

        reply.setCookie(SESSION_COOKIE, createSession(options.sessionSecret, SESSION_LIFETIME_MS), {
          httpOnly: true,
          sameSite: 'strict',
          secure: options.secureCookies,
          path: '/',
          maxAge: SESSION_LIFETIME_MS / 1000,
        });
        return reply.redirect('/', 303);
      },
    );
  });

  app.post('/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login', 303);
  });

  app.get('/', async (request, reply) => {
    const current = page((request.query as { page?: unknown }).page);
    const [calls, totals] = await Promise.all([queries.listCalls(current), queries.totals()]);
    return sendHtml(reply, callsPage(calls, totals, current, calls.length === PAGE_SIZE));
  });

  app.get('/calls/:callSid', async (request, reply) => {
    const { callSid } = request.params as { callSid: string };
    const call = await queries.getCall(callSid);
    if (!call) return sendHtml(reply, notFoundPage(), 404);
    return sendHtml(reply, callPage(call, options.jaegerUrl));
  });

  app.get('/messages', async (request, reply) => {
    const current = page((request.query as { page?: unknown }).page);
    const messages = await queries.listMessages(current);
    return sendHtml(reply, messagesPage(messages, current, messages.length === PAGE_SIZE));
  });

  return app;
}
