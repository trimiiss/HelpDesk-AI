import { trace } from '@opentelemetry/api';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contextFromHeaders,
  initTelemetry,
  startSpan,
  traceHeaders,
  traceRequests,
  withSpan,
  type Telemetry,
} from '../src/telemetry.js';

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

describe('trace propagation', () => {
  let telemetry: Telemetry;

  beforeAll(() => {
    telemetry = initTelemetry('test-service');
  });

  afterAll(async () => {
    await telemetry.shutdown();
    trace.disable();
  });

  it('writes a W3C traceparent header', () => {
    const { span, context } = startSpan('call');
    expect(traceHeaders(context).traceparent).toMatch(TRACEPARENT);
    span.end();
  });

  it('keeps one trace ID across a hop through headers', () => {
    const { span: root, context } = startSpan('gateway');
    const carried = traceHeaders(context);

    const { span: child } = startSpan('worker', { parent: contextFromHeaders(carried) });

    expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(child.spanContext().spanId).not.toBe(root.spanContext().spanId);
    root.end();
    child.end();
  });

  it('keeps a span active across awaits inside withSpan', async () => {
    const { span: root, context } = startSpan('root');
    let inner: string | undefined;

    await withSpan('child', { parent: context }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      inner = traceHeaders().traceparent?.split('-')[1];
    });

    expect(inner).toBe(root.spanContext().traceId);
    root.end();
  });

  it('rethrows failures from inside a span', async () => {
    await expect(
      withSpan('failing', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('continues the caller trace inside a Fastify request', async () => {
    const app = Fastify();
    traceRequests(app);
    app.get('/search', async () => ({ headers: traceHeaders() }));

    const { span: root, context } = startSpan('caller');
    const response = await app.inject({ method: 'GET', url: '/search', headers: traceHeaders(context) });
    const { headers } = response.json<{ headers: { traceparent: string } }>();

    expect(headers.traceparent.split('-')[1]).toBe(root.spanContext().traceId);
    root.end();
    await app.close();
  });

  it('leaves health checks untraced', async () => {
    const app = Fastify();
    traceRequests(app);
    app.get('/healthz', async () => ({ headers: traceHeaders() }));

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.json<{ headers: Record<string, string> }>().headers.traceparent).toBeUndefined();
    await app.close();
  });
});
