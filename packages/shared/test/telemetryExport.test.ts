import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, propagation, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { initTelemetry, startSpan } from '../src/telemetry.js';

describe('span export', () => {
  it('sends finished spans to the collector before shutting down', async () => {
    const received: string[] = [];
    const collector = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`);
      request.resume();
      request.on('end', () => response.writeHead(200).end());
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    const { port } = collector.address() as AddressInfo;

    const telemetry = initTelemetry('export-test', `http://127.0.0.1:${port}/`);
    startSpan('call').span.end();
    await telemetry.shutdown();

    expect(received).toEqual(['POST /v1/traces']);

    collector.close();
    trace.disable();
    context.disable();
    propagation.disable();
  });
});
