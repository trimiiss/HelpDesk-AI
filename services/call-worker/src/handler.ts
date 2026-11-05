import type { EventHandler } from '@helpdesk/broker';
import {
  contextFromHeaders,
  Counter,
  Histogram,
  SpanKind,
  withSpan,
  type HelpdeskEvent,
  type Logger,
  type Registry,
} from '@helpdesk/shared';
import type { Notifier } from './notifier.js';
import type { CallStore } from './store.js';

export interface WorkerMetrics {
  processed: Counter<'type' | 'outcome'>;
  duration: Histogram<'type'>;
  notifications: Counter<'outcome'>;
  deadLetters: Counter;
}

export function createWorkerMetrics(registry: Registry): WorkerMetrics {
  return {
    processed: new Counter({
      name: 'helpdesk_events_processed_total',
      help: 'Events handled by the worker, by type and outcome.',
      labelNames: ['type', 'outcome'],
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'helpdesk_event_processing_seconds',
      help: 'Time to process one event.',
      labelNames: ['type'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [registry],
    }),
    notifications: new Counter({
      name: 'helpdesk_notifications_total',
      help: 'Callback notifications sent, by outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    deadLetters: new Counter({
      name: 'helpdesk_dead_letters_total',
      help: 'Events that gave up and moved to the dead-letter subject.',
      registers: [registry],
    }),
  };
}

export interface HandlerDeps {
  store: Pick<
    CallStore,
    | 'recordStarted'
    | 'recordEnded'
    | 'addTranscript'
    | 'addMessage'
    | 'addTransfer'
    | 'isNotified'
    | 'markNotified'
  >;
  notifier: Notifier;
  metrics: WorkerMetrics;
  log: Logger;
}

async function apply(event: HelpdeskEvent, deps: HandlerDeps): Promise<void> {
  const { store } = deps;

  switch (event.type) {
    case 'call.started':
      await store.recordStarted(event);
      break;
    case 'call.ended':
      await store.recordEnded(event);
      break;
    case 'transcript.completed':
      await store.addTranscript(event);
      break;
    case 'transfer.requested':
      await store.addTransfer(event);
      break;
    case 'message.taken':
      await store.addMessage(event);
      await notify(event, deps);
      break;
  }
}

/**
 * The message is saved before the email goes out, so a mail failure can't lose
 * it, and notified_at stops a retry from sending a second email.
 */
async function notify(
  event: Extract<HelpdeskEvent, { type: 'message.taken' }>,
  deps: HandlerDeps,
): Promise<void> {
  if (await deps.store.isNotified(event.eventId)) return;

  try {
    await deps.notifier.send({
      name: event.name,
      phone: event.phone,
      message: event.message,
      callSid: event.callSid,
    });
  } catch (error) {
    deps.metrics.notifications.inc({ outcome: 'failed' });
    throw error;
  }

  deps.metrics.notifications.inc({ outcome: 'sent' });
  await deps.store.markNotified(event.eventId);
}

export function createEventHandler(deps: HandlerDeps): EventHandler {
  return (event, delivery) => {
    const stopTimer = deps.metrics.duration.startTimer({ type: event.type });

    // The headers carry the trace from the gateway, so this span joins the call's trace.
    return withSpan(
      `process ${event.type}`,
      {
        kind: SpanKind.CONSUMER,
        parent: contextFromHeaders(delivery.headers),
        attributes: {
          'call.sid': event.callSid,
          'messaging.system': 'nats',
          'messaging.delivery.attempt': delivery.attempt,
        },
      },
      async () => {
        try {
          await apply(event, deps);
          deps.metrics.processed.inc({ type: event.type, outcome: 'ok' });
        } catch (error) {
          deps.metrics.processed.inc({ type: event.type, outcome: 'error' });
          throw error;
        } finally {
          stopTimer();
        }
      },
    );
  };
}
