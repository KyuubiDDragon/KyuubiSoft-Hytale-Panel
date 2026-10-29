/**
 * Prometheus metrics service.
 *
 * Registers a small fixed set of counters, gauges and histograms that
 * cover the panel's most useful operational signals:
 *
 *   - kp_http_requests_total{method,route,status}        counter
 *   - kp_http_request_duration_seconds{method,route}     histogram
 *   - kp_auth_logins_total{result}                       counter
 *   - kp_webhook_deliveries_total{status}                counter
 *   - kp_active_websockets                               gauge
 *   - kp_online_players{server}                          gauge
 *   - kp_servers_registered                              gauge
 *
 * Node + process metrics from prom-client's default registry are also
 * exposed.
 *
 * The metrics module is intentionally a thin wrapper: each subsystem
 * imports the counter / gauge it needs and calls .inc() / .set() at the
 * right moment. /api/metrics renders the exposition (routes/metrics.ts).
 * The two fleet gauges are read when scraped, from what the panel already
 * keeps in memory (the server registry and who is online per server), so a
 * scrape never asks Docker or the plugins anything.
 */
import client from 'prom-client';

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'kp_node_' });

export const httpRequests = new client.Counter({
  name: 'kp_http_requests_total',
  help: 'HTTP requests handled by the panel',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new client.Histogram({
  name: 'kp_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const authLogins = new client.Counter({
  name: 'kp_auth_logins_total',
  help: 'Login attempts',
  labelNames: ['result'] as const, // 'success' | 'failed' | '2fa_required' | '2fa_failed'
  registers: [registry],
});

export const webhookDeliveries = new client.Counter({
  name: 'kp_webhook_deliveries_total',
  help: 'Webhook delivery attempts and outcomes',
  labelNames: ['status'] as const, // 'success' | 'failed' | 'gave_up'
  registers: [registry],
});

export const activeWebsockets = new client.Gauge({
  name: 'kp_active_websockets',
  help: 'Currently connected console WebSocket clients',
  registers: [registry],
});

// Imported on the first scrape (both modules pull in most of the panel), once.
type FleetSources = {
  servers: typeof import('./servers.js');
  presence: typeof import('./playerPresence.js');
};
let fleet: Promise<FleetSources> | null = null;
function fleetSources(): Promise<FleetSources> {
  fleet ??= (async () => ({
    servers: await import('./servers.js'),
    presence: await import('./playerPresence.js'),
  }))().catch((err: unknown) => {
    fleet = null; // try again on the next scrape
    throw err;
  });
  return fleet;
}

// An unreadable registry leaves the fleet gauges empty; the rest of the scrape still answers.
function fleetUnavailable(err: unknown): void {
  console.warn('[metrics] fleet gauges unavailable:', err instanceof Error ? err.message : err);
}

export const onlinePlayers = new client.Gauge({
  name: 'kp_online_players',
  help: 'Players online per server (KyuubiSoft plugin events, or the server log without the plugin)',
  labelNames: ['server'] as const,
  registers: [registry],
  async collect() {
    let counts: Array<[string, number]> = [];
    try {
      const { servers, presence } = await fleetSources();
      counts = (await servers.listServers()).map((s) => [s.id, presence.onlinePlayers(s.id).length]);
    } catch (err) {
      fleetUnavailable(err);
    }
    // Replaced in one go, after the awaits: removed servers stop reporting,
    // and a scrape running alongside never sees a half-filled gauge.
    this.reset();
    for (const [server, count] of counts) this.set({ server }, count);
  },
});

export const serversRegistered = new client.Gauge({
  name: 'kp_servers_registered',
  help: 'Number of Hytale server instances tracked by the panel',
  registers: [registry],
  async collect() {
    try {
      const { servers } = await fleetSources();
      this.set((await servers.listServers()).length);
    } catch (err) {
      this.reset();
      fleetUnavailable(err);
    }
  },
});

export async function exposition(): Promise<string> {
  return registry.metrics();
}

export function contentType(): string {
  return registry.contentType;
}

/**
 * Express middleware that times each request and records it under
 * httpRequests + httpDuration. Route templates ('/api/users/:id') are
 * preferred over raw paths to keep cardinality bounded; we fall back to
 * req.path if no route is matched (404s).
 */
import type { Request, Response, NextFunction } from 'express';
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ns = Number(process.hrtime.bigint() - start);
    const route =
      (req.route as { path?: string } | undefined)?.path ||
      req.baseUrl + (req.path || '') ||
      '<unknown>';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequests.inc(labels);
    httpDuration.observe({ method: req.method, route }, ns / 1e9);
  });
  next();
}
