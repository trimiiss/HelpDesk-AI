import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** The one source of truth for what travels over the broker. */

const baseFields = {
  eventId: z.uuid(),
  callSid: z.string().min(1),
  occurredAt: z.iso.datetime(),
};

const tokenCount = z.number().int().nonnegative();

export const usageSchema = z.object({
  textInputTokens: tokenCount,
  textCachedTokens: tokenCount,
  textOutputTokens: tokenCount,
  audioInputTokens: tokenCount,
  audioCachedTokens: tokenCount,
  audioOutputTokens: tokenCount,
  transcriptionSeconds: z.number().nonnegative(),
});

export type CallUsage = z.output<typeof usageSchema>;

export const emptyUsage = (): CallUsage => ({
  textInputTokens: 0,
  textCachedTokens: 0,
  textOutputTokens: 0,
  audioInputTokens: 0,
  audioCachedTokens: 0,
  audioOutputTokens: 0,
  transcriptionSeconds: 0,
});

export const eventSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseFields,
    type: z.literal('call.started'),
    from: z.string().optional(),
    to: z.string().optional(),
    model: z.string(),
    traceId: z.string().optional(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('call.ended'),
    reason: z.string(),
    durationMs: z.number().int().nonnegative(),
    usage: usageSchema,
    costUsd: z.number().nonnegative(),
    traceId: z.string().optional(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('transcript.completed'),
    itemId: z.string().min(1),
    role: z.enum(['caller', 'agent']),
    text: z.string(),
    /** Position in the conversation. Transcripts can finish out of order. */
    sequence: z.number().int().nonnegative(),
    interrupted: z.boolean(),
  }),
  z.object({
    ...baseFields,
    type: z.literal('message.taken'),
    name: z.string().min(1),
    phone: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    ...baseFields,
    type: z.literal('transfer.requested'),
    reason: z.string().optional(),
  }),
]);

export type HelpdeskEvent = z.output<typeof eventSchema>;
export type HelpdeskEventType = HelpdeskEvent['type'];

/** Every event lands under this prefix, for example helpdesk.call.started. */
export const EVENT_SUBJECT_PREFIX = 'helpdesk';
export const DEAD_LETTER_SUBJECT_PREFIX = 'dlq.helpdesk';

export const subjectFor = (type: HelpdeskEventType): string => `${EVENT_SUBJECT_PREFIX}.${type}`;

type EventFields<T extends HelpdeskEventType> = Omit<
  Extract<HelpdeskEvent, { type: T }>,
  'type' | 'eventId' | 'callSid' | 'occurredAt'
>;

export function createEvent<T extends HelpdeskEventType>(
  type: T,
  callSid: string,
  fields: EventFields<T>,
): Extract<HelpdeskEvent, { type: T }> {
  return {
    ...fields,
    type,
    callSid,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
  } as unknown as Extract<HelpdeskEvent, { type: T }>;
}
