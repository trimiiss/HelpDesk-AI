// Checks a running stack from the outside, after a simulated call has gone through
// it. Each check proves one piece reached its destination: the transcript in
// Postgres, the email in Mailpit, one trace across all services in Jaeger, the
// metrics in Prometheus, and the dashboard and alerts in Grafana.
//
//   npm run sim:up && npm run sim:call && npm run sim:verify

const ADMIN = process.env.ADMIN_URL ?? 'http://127.0.0.1:8082';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'demo-password';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
const JAEGER = process.env.JAEGER_URL ?? 'http://127.0.0.1:16686';
const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://127.0.0.1:3000';
const GRAFANA_AUTH = `Basic ${Buffer.from(`admin:${process.env.GRAFANA_PASSWORD ?? 'admin'}`).toString('base64')}`;

const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

/** Traces and scrapes arrive a little after the call, so give each check some time. */
async function eventually(read, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function adminCookie() {
  const response = await fetch(`${ADMIN}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
    redirect: 'manual',
  });
  return response.headers.get('set-cookie')?.split(';')[0];
}

async function verifyDatabase() {
  const cookie = await adminCookie();
  check('admin-ui accepts the password', Boolean(cookie));
  if (!cookie) return;

  const home = await (await fetch(`${ADMIN}/`, { headers: { cookie } })).text();
  const link = /href="\/calls\/([^"]+)"/.exec(home)?.[1];
  check('admin-ui lists the call', Boolean(link));
  check('call shows an estimated cost', /\$0\.\d{4}/.test(home));
  if (!link) return;

  const call = await (await fetch(`${ADMIN}/calls/${link}`, { headers: { cookie } })).text();
  check('transcript was stored', call.includes('Rruga Demo') && call.includes('location'));
  check('transcript is in conversation order',
    call.indexOf('opening hours') < call.indexOf('helicopters') &&
    call.indexOf('helicopters') < call.indexOf('talk to a person'));
  check('interrupted reply is marked', call.includes('(interrupted)'));
  check('call outcome was recorded', call.includes('Transferred'));
  check('transfer was recorded', call.includes('caller asked for a person'));
  check('call links to its trace', /\/trace\/[0-9a-f]{32}/.test(call));

  const messages = await (await fetch(`${ADMIN}/messages`, { headers: { cookie } })).text();
  check('callback message was stored', messages.includes('brakes are squeaking'));
  check('message shows as emailed', messages.includes('Email sent'));
}

async function verifyEmail() {
  const found = await eventually(async () => {
    const { messages } = await (await fetch(`${MAILPIT}/api/v1/messages`)).json();
    return messages.find((message) => message.Subject.includes('callback message'));
  });
  check('email reached the mailbox', Boolean(found));
}

async function verifyTrace() {
  const trace = await eventually(async () => {
    const response = await fetch(`${JAEGER}/api/traces?service=call-worker&limit=20&lookback=1h`);
    const { data } = await response.json();
    return data.find((candidate) => {
      const services = new Set(Object.values(candidate.processes).map((p) => p.serviceName));
      return services.has('call-gateway') && services.has('knowledge-service') && services.has('call-worker');
    });
  });

  check('one trace spans gateway, knowledge-service and worker', Boolean(trace));
  if (!trace) return;

  const names = new Set(trace.spans.map((span) => span.operationName));
  check('trace starts at the webhook', names.has('POST /incoming-call'));
  check('trace has the call itself', names.has('call'));
  check('trace has the tool call', names.has('tool search_knowledge'));
  check('trace reaches the search service', names.has('POST /search'));
  check('trace crosses the broker to the worker', names.has('process message.taken'));
}

async function prometheus(query) {
  const url = `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(query)}`;
  const { data } = await (await fetch(url)).json();
  return data.result;
}

async function verifyMetrics() {
  const present = async (name, query) => {
    const result = await eventually(async () => {
      const rows = await prometheus(query);
      return rows.length > 0 ? rows : undefined;
    });
    check(`metric: ${name}`, Boolean(result));
  };

  await present('active calls', 'helpdesk_active_calls');
  await present('call duration', 'helpdesk_call_duration_seconds_count > 0');
  await present('time to first audio', 'helpdesk_realtime_first_audio_seconds_count > 0');
  await present('tool calls', 'helpdesk_tool_calls_total{tool="search_knowledge"} > 0');
  await present('tool latency', 'helpdesk_tool_duration_seconds_count > 0');
  await present('token usage', 'helpdesk_openai_tokens_total > 0');
  await present('cost per call', 'helpdesk_call_cost_usd_count > 0');
  await present('search requests', 'helpdesk_search_requests_total > 0');
  await present('worker throughput', 'helpdesk_events_processed_total > 0');
  await present('broker lag', 'jetstream_consumer_num_pending');
}

async function verifyGrafana() {
  const get = async (path) =>
    (await fetch(`${GRAFANA}${path}`, { headers: { authorization: GRAFANA_AUTH } })).json();

  const dashboard = await eventually(() => get('/api/dashboards/uid/helpdesk'));
  check('dashboard is provisioned', dashboard?.dashboard?.title === 'Voice Helpdesk');

  const rules = await eventually(() => get('/api/v1/provisioning/alert-rules'));
  const titles = Array.isArray(rules) ? rules.map((rule) => rule.title) : [];
  check('error rate alert is provisioned', titles.includes('High error rate'));
  check('latency alert is provisioned', titles.includes('Slow agent replies'));

  const sources = await get('/api/datasources');
  check('Prometheus and Jaeger data sources exist',
    ['prometheus', 'jaeger'].every((type) => sources.some((source) => source.type === type)));
}

await verifyDatabase();
await verifyEmail();
await verifyTrace();
await verifyMetrics();
await verifyGrafana();

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
