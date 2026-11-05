import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export { SpanKind, type Context, type Span };

export interface Telemetry {
  shutdown(): Promise<void>;
}

/**
 * Starts tracing for a service. Context is passed by hand at each hop (HTTP, NATS
 * and the Twilio <Parameter>), so nothing depends on patching modules at load
 * time, which is fragile with ES modules. Without an endpoint, trace IDs still
 * propagate but nothing is exported, which is what tests want.
 */
export function initTelemetry(serviceName: string, otlpEndpoint?: string): Telemetry {
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: otlpEndpoint
      ? [
          new BatchSpanProcessor({
            exporter: new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` }),
          }),
        ]
      : [],
  });
  // All three are needed: without the context manager spans lose their parents, and
  // without the propagator traces stop at each service boundary. Neither one errors.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  return { shutdown: () => provider.shutdown() };
}

const tracer = () => trace.getTracer('helpdesk');

/** Writes the given trace context into a headers object, ready to send. */
export function traceHeaders(from: Context = context.active()): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(from, carrier);
  return carrier;
}

/** Reads trace context from incoming headers. */
export function contextFromHeaders(headers: Record<string, unknown>): Context {
  return propagation.extract(ROOT_CONTEXT, headers);
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  parent?: Context;
}

/** For spans that outlive a single function, such as a whole call. End them yourself. */
export function startSpan(name: string, options: SpanOptions = {}): { span: Span; context: Context } {
  const parent = options.parent ?? context.active();
  const span = tracer().startSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes },
    parent,
  );
  return { span, context: trace.setSpan(parent, span) };
}

export function recordFailure(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Runs a function inside a span, marking the span failed if the function throws. */
export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  const { span, context: spanContext } = startSpan(name, options);
  return context.with(spanContext, async () => {
    try {
      return await run(span);
    } catch (error) {
      recordFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Health checks arrive every few seconds and would drown out real traces. */
const UNTRACED_PATHS = new Set(['/healthz', '/readyz']);

/** Gives every Fastify request a server span, continuing any trace in its headers. */
export function traceRequests(app: FastifyInstance): void {
  const spans = new WeakMap<FastifyRequest, Span>();

  app.addHook('onRequest', (request, _reply, done) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (UNTRACED_PATHS.has(path)) {
      done();
      return;
    }

    const parent = contextFromHeaders(request.headers);
    const { span, context: spanContext } = startSpan(`${request.method} ${path}`, {
      kind: SpanKind.SERVER,
      parent,
      attributes: { 'http.request.method': request.method, 'url.path': path },
    });
    spans.set(request, span);
    context.with(spanContext, done);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const span = spans.get(request);
    if (span) {
      span.setAttribute('http.response.status_code', reply.statusCode);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    done();
  });
}
