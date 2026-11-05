import { readFileSync } from 'node:fs';
import type { CallUsage } from '@helpdesk/shared';
import { parse } from 'yaml';
import { z } from 'zod';

const rates = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

const pricingSchema = z.object({
  models: z.record(z.string(), z.object({ text: rates, audio: rates })),
  transcription: z.record(z.string(), z.object({ perMinute: z.number().nonnegative() })),
});

export type Pricing = z.output<typeof pricingSchema>;

export const loadPricing = (path: string): Pricing =>
  pricingSchema.parse(parse(readFileSync(path, 'utf8')));

/** The usage object on response.done. Cached tokens are a subset of the input counts. */
export interface ResponseUsage {
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

export function addResponseUsage(total: CallUsage, usage: ResponseUsage | undefined): void {
  if (!usage) return;

  const input = usage.input_token_details ?? {};
  const cached = input.cached_tokens_details ?? {};
  const output = usage.output_token_details ?? {};
  const textCached = cached.text_tokens ?? 0;
  const audioCached = cached.audio_tokens ?? 0;

  total.textInputTokens += Math.max(0, (input.text_tokens ?? 0) - textCached);
  total.textCachedTokens += textCached;
  total.audioInputTokens += Math.max(0, (input.audio_tokens ?? 0) - audioCached);
  total.audioCachedTokens += audioCached;
  total.textOutputTokens += output.text_tokens ?? 0;
  total.audioOutputTokens += output.audio_tokens ?? 0;
}

/** Caller audio is about one token per 100 ms, for models that report tokens rather than time. */
const AUDIO_TOKENS_PER_SECOND = 10;

export interface TranscriptionUsage {
  type?: string;
  seconds?: number;
  input_tokens?: number;
  input_token_details?: { audio_tokens?: number };
}

export function addTranscriptionUsage(
  total: CallUsage,
  usage: TranscriptionUsage | undefined,
): void {
  if (!usage) return;

  if (usage.type === 'duration') {
    total.transcriptionSeconds += usage.seconds ?? 0;
    return;
  }
  const tokens = usage.input_token_details?.audio_tokens ?? usage.input_tokens ?? 0;
  total.transcriptionSeconds += tokens / AUDIO_TOKENS_PER_SECOND;
}

export type CostEstimator = (usage: CallUsage) => number;

/** An unknown model counts as zero rather than failing, since this is only an estimate. */
export function createCostEstimator(
  pricing: Pricing,
  model: string,
  transcriptionModel: string,
): CostEstimator {
  const modelRates = pricing.models[model];
  const transcriptionRate = pricing.transcription[transcriptionModel]?.perMinute ?? 0;

  return (usage) => {
    const tokens = modelRates
      ? usage.textInputTokens * modelRates.text.input +
        usage.textCachedTokens * modelRates.text.cachedInput +
        usage.textOutputTokens * modelRates.text.output +
        usage.audioInputTokens * modelRates.audio.input +
        usage.audioCachedTokens * modelRates.audio.cachedInput +
        usage.audioOutputTokens * modelRates.audio.output
      : 0;
    return tokens / 1_000_000 + (usage.transcriptionSeconds / 60) * transcriptionRate;
  };
}
