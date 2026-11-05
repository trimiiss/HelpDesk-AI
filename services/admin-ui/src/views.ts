import type { CallbackMessage, CallDetail, CallSummary, Totals } from './queries.js';

/** Marks text as already safe. Only `html` below creates one. */
class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

type Value = string | number | null | undefined | SafeHtml | SafeHtml[];

const render = (value: Value): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map((part) => part.value).join('');
  return escapeHtml(String(value));
};

/**
 * Every value is escaped unless it's already the output of this function.
 * Transcripts and messages come from callers, so a template can't be written
 * that forgets to escape them.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  return new SafeHtml(
    strings.reduce((result, text, index) => result + text + render(values[index]), ''),
  );
}

const dateTime = (value: Date | null): string =>
  value ? value.toISOString().replace('T', ' ').slice(0, 19) : '-';

function duration(ms: number | null): string {
  if (ms === null) return '-';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const money = (value: number | null): string => (value === null ? '-' : `$${value.toFixed(4)}`);

const REASONS: Record<string, string> = {
  caller_hangup: 'Caller hung up',
  transferred: 'Transferred',
  transfer_failed: 'Transfer failed',
  max_duration: 'Time limit',
  realtime_failed: 'AI failed',
  setup_failed: 'Setup failed',
  shutdown: 'Server restart',
};

const reasonLabel = (reason: string | null): string =>
  reason ? (REASONS[reason] ?? reason) : 'In progress';

function layout(title: string, body: SafeHtml, signedIn = true): string {
  const nav = signedIn
    ? html`<nav>
        <a href="/">Calls</a>
        <a href="/messages">Messages</a>
        <form method="post" action="/logout"><button class="link">Sign out</button></form>
      </nav>`
    : html``;

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Helpdesk</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <header><strong>Helpdesk</strong>${nav}</header>
        <main>${body}</main>
      </body>
    </html>`.value;
}

export function loginPage(error?: string): string {
  return layout(
    'Sign in',
    html`<form method="post" action="/login" class="card narrow">
      <h1>Sign in</h1>
      ${error ? html`<p class="error" role="alert">${error}</p>` : ''}
      <label>Password <input type="password" name="password" required autofocus /></label>
      <button type="submit">Sign in</button>
    </form>`,
    false,
  );
}

function pager(path: string, page: number, hasMore: boolean): SafeHtml {
  if (page === 1 && !hasMore) return html``;
  return html`<p class="pager">
    ${page > 1 ? html`<a href="${path}?page=${page - 1}">Newer</a>` : ''}
    ${hasMore ? html`<a href="${path}?page=${page + 1}">Older</a>` : ''}
  </p>`;
}

export function callsPage(
  calls: CallSummary[],
  totals: Totals,
  page: number,
  hasMore: boolean,
): string {
  const rows = calls.map(
    (call) => html`<tr>
      <td><a href="/calls/${encodeURIComponent(call.callSid)}">${dateTime(call.startedAt)}</a></td>
      <td>${call.from ?? 'Unknown'}</td>
      <td class="number">${duration(call.durationMs)}</td>
      <td>${reasonLabel(call.endReason)}</td>
      <td class="number">${call.turns}</td>
      <td class="number">${call.messages}</td>
      <td class="number">${money(call.costUsd)}</td>
    </tr>`,
  );

  return layout(
    'Calls',
    html`<h1>Calls</h1>
      <dl class="stats">
        <div><dt>Calls</dt><dd>${totals.calls}</dd></div>
        <div><dt>Messages</dt><dd>${totals.messages}</dd></div>
        <div><dt>Estimated spend</dt><dd>${money(totals.costUsd)}</dd></div>
      </dl>
      ${calls.length === 0
        ? html`<p class="empty">No calls yet.</p>`
        : html`<div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Started (UTC)</th>
                  <th>From</th>
                  <th class="number">Length</th>
                  <th>Outcome</th>
                  <th class="number">Turns</th>
                  <th class="number">Messages</th>
                  <th class="number">Cost</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>`}
      ${pager('/', page, hasMore)}`,
  );
}

function messageCard(message: CallbackMessage, showCallLink: boolean): SafeHtml {
  return html`<article class="card">
    <h3>${message.name}</h3>
    <p class="meta">
      ${message.phone} · ${dateTime(message.occurredAt)} ·
      ${message.notifiedAt
        ? html`<span>Email sent</span>`
        : html`<span class="error">Email not sent</span>`}
    </p>
    <p class="text">${message.message}</p>
    ${showCallLink
      ? html`<p><a href="/calls/${encodeURIComponent(message.callSid)}">View call</a></p>`
      : ''}
  </article>`;
}

export function callPage(call: CallDetail, jaegerUrl: string | undefined): string {
  const turns = call.transcript.map(
    (turn) => html`<div class="turn ${turn.role}">
      <span class="who">${turn.role === 'caller' ? 'Caller' : 'Agent'}</span>
      <p class="text">${turn.text}${turn.interrupted ? html` <em>(interrupted)</em>` : ''}</p>
    </div>`,
  );

  const transfers = call.transfers.map(
    (transfer) => html`<li>${dateTime(transfer.occurredAt)}: ${transfer.reason ?? 'No reason given'}</li>`,
  );

  return layout(
    'Call',
    html`<p><a href="/">Back to calls</a></p>
      <h1>Call from ${call.from ?? 'unknown number'}</h1>
      <dl class="stats">
        <div><dt>Started (UTC)</dt><dd>${dateTime(call.startedAt)}</dd></div>
        <div><dt>Length</dt><dd>${duration(call.durationMs)}</dd></div>
        <div><dt>Outcome</dt><dd>${reasonLabel(call.endReason)}</dd></div>
        <div><dt>Estimated cost</dt><dd>${money(call.costUsd)}</dd></div>
      </dl>
      <p class="meta">
        Model: ${call.model ?? '-'} · Reference: ${call.callSid}
        ${jaegerUrl && call.traceId
          ? html` · <a href="${jaegerUrl}/trace/${call.traceId}">View trace</a>`
          : ''}
      </p>
      <h2>Transcript</h2>
      ${turns.length > 0 ? html`<div class="transcript">${turns}</div>` : html`<p class="empty">No transcript.</p>`}
      ${call.callMessages.length > 0
        ? html`<h2>Messages</h2>
            ${call.callMessages.map((message) => messageCard(message, false))}`
        : ''}
      ${transfers.length > 0 ? html`<h2>Transfers</h2><ul>${transfers}</ul>` : ''}`,
  );
}

export function messagesPage(messages: CallbackMessage[], page: number, hasMore: boolean): string {
  return layout(
    'Messages',
    html`<h1>Messages</h1>
      ${messages.length === 0
        ? html`<p class="empty">No messages yet.</p>`
        : messages.map((message) => messageCard(message, true))}
      ${pager('/messages', page, hasMore)}`,
  );
}

export function notFoundPage(): string {
  return layout('Not found', html`<h1>Not found</h1><p><a href="/">Back to calls</a></p>`);
}

export const STYLESHEET = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #fff; --text: #1a1d23; --muted: #626b7a;
  --border: #dfe3e9; --accent: #1f5fbf; --error: #b3261e; --caller: #eef3fb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --panel: #1d2026; --text: #e7e9ee; --muted: #9aa3b2;
    --border: #2e333c; --accent: #8ab4f8; --error: #f2b8b5; --caller: #232a36;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 24px; background: var(--panel); border-bottom: 1px solid var(--border); }
nav { display: flex; gap: 16px; align-items: center; }
nav form { margin: 0; }
main { max-width: 1000px; margin: 0 auto; padding: 24px; }
h1 { font-size: 24px; margin: 0 0 16px; }
h2 { font-size: 18px; margin: 32px 0 12px; }
h3 { margin: 0 0 4px; font-size: 16px; }
a, .link { color: var(--accent); }
.link { background: none; border: 0; padding: 0; font: inherit; cursor: pointer; }
.link:hover, a:hover { text-decoration: underline; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.narrow { max-width: 360px; margin: 48px auto; display: grid; gap: 12px; }
label { display: grid; gap: 4px; }
input { font: inherit; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
button[type=submit] { font: inherit; padding: 8px; border: 0; border-radius: 6px; background: var(--accent); color: var(--panel); cursor: pointer; }
.stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 20px; }
.stats div { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; min-width: 130px; }
.stats dt { color: var(--muted); font-size: 13px; }
.stats dd { margin: 0; font-size: 18px; font-weight: 600; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
tr:last-child td { border-bottom: 0; }
.number { text-align: right; font-variant-numeric: tabular-nums; }
.meta, .empty { color: var(--muted); }
.meta { font-size: 13px; margin: 0 0 8px; }
.error { color: var(--error); }
.pager { display: flex; gap: 16px; }
.transcript { display: grid; gap: 8px; }
.turn { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; }
.turn.caller { background: var(--caller); }
.who { font-size: 12px; color: var(--muted); }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
`;
