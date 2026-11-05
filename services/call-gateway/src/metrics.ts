import { Counter, Gauge, Histogram, type CallUsage, type Registry } from '@helpdesk/shared';

export interface CallMetrics {
  callStarted(): void;
  callEnded(reason: string, durationSeconds: number, costUsd: number, usage: CallUsage): void;
  firstAudio(seconds: number): void;
  toolCall(tool: string, outcome: string, seconds: number): void;
  error(kind: string): void;
}

export interface QueueMetrics {
  eventDropped(): void;
  queueDepth(depth: number): void;
}

export function createCallMetrics(registry: Registry): CallMetrics & QueueMetrics {
  const registers = [registry];

  const activeCalls = new Gauge({
    name: 'helpdesk_active_calls',
    help: 'Calls in progress on this pod. Drives the autoscaler.',
    registers,
  });
  const callDuration = new Histogram({
    name: 'helpdesk_call_duration_seconds',
    help: 'How long calls last, by how they ended.',
    labelNames: ['reason'],
    buckets: [10, 30, 60, 120, 180, 300, 450, 600, 900],
    registers,
  });
  const firstAudio = new Histogram({
    name: 'helpdesk_realtime_first_audio_seconds',
    help: 'From the caller stopping speaking to the first audio of the reply.',
    buckets: [0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 5, 8],
    registers,
  });
  const toolCalls = new Counter({
    name: 'helpdesk_tool_calls_total',
    help: 'Tool calls made by the model, by tool and outcome.',
    labelNames: ['tool', 'outcome'],
    registers,
  });
  const toolDuration = new Histogram({
    name: 'helpdesk_tool_duration_seconds',
    help: 'Time to run a tool.',
    labelNames: ['tool'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
    registers,
  });
  const tokens = new Counter({
    name: 'helpdesk_openai_tokens_total',
    help: 'OpenAI tokens used, by modality and direction.',
    labelNames: ['modality', 'direction'],
    registers,
  });
  const costTotal = new Counter({
    name: 'helpdesk_openai_cost_usd_total',
    help: 'Estimated OpenAI spend.',
    registers,
  });
  const callCost = new Histogram({
    name: 'helpdesk_call_cost_usd',
    help: 'Estimated OpenAI cost of each call.',
    buckets: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2],
    registers,
  });
  const errors = new Counter({
    name: 'helpdesk_errors_total',
    help: 'Errors by kind.',
    labelNames: ['kind'],
    registers,
  });
  const droppedEvents = new Counter({
    name: 'helpdesk_events_dropped_total',
    help: 'Events lost because the broker was down for too long.',
    registers,
  });
  const queued = new Gauge({
    name: 'helpdesk_event_queue_depth',
    help: 'Events waiting to reach the broker.',
    registers,
  });

  return {
    callStarted: () => activeCalls.inc(),
    callEnded(reason, durationSeconds, costUsd, usage) {
      activeCalls.dec();
      callDuration.observe({ reason }, durationSeconds);
      callCost.observe(costUsd);
      costTotal.inc(costUsd);
      tokens.inc({ modality: 'text', direction: 'input' }, usage.textInputTokens);
      tokens.inc({ modality: 'text', direction: 'cached' }, usage.textCachedTokens);
      tokens.inc({ modality: 'text', direction: 'output' }, usage.textOutputTokens);
      tokens.inc({ modality: 'audio', direction: 'input' }, usage.audioInputTokens);
      tokens.inc({ modality: 'audio', direction: 'cached' }, usage.audioCachedTokens);
      tokens.inc({ modality: 'audio', direction: 'output' }, usage.audioOutputTokens);
    },
    firstAudio: (seconds) => firstAudio.observe(seconds),
    toolCall(tool, outcome, seconds) {
      toolCalls.inc({ tool, outcome });
      toolDuration.observe({ tool }, seconds);
    },
    error: (kind) => errors.inc({ kind }),
    eventDropped: () => droppedEvents.inc(),
    queueDepth: (depth) => queued.set(depth),
  };
}
