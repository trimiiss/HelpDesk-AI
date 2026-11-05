import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Registry } from 'prom-client';

export { Counter, Gauge, Histogram, Registry } from 'prom-client';

export function createMetricsRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
}

/**
 * Serves /metrics on its own port, separate from the service port. The ingress
 * only routes to the service port, so metrics can never be reached publicly.
 */
export function startMetricsServer(registry: Registry, port: number): Server {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200).end('ok');
      return;
    }
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (body) => response.writeHead(200, { 'content-type': registry.contentType }).end(body),
      () => response.writeHead(500).end(),
    );
  });
  server.listen(port, '0.0.0.0');
  return server;
}
