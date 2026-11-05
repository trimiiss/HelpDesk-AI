import type { GatewayConfig } from './config.js';

export const SEARCH_TOOL = 'search_knowledge';
export const TRANSFER_TOOL = 'transfer_to_human';
export const MESSAGE_TOOL = 'take_message';

/** Twilio's bidirectional streams carry 8 kHz G.711 mu-law, which the GA Realtime API names audio/pcmu. */
const TELEPHONY_AUDIO = { type: 'audio/pcmu' };

const tools = [
  {
    type: 'function',
    name: SEARCH_TOOL,
    description:
      'Search the business information: services, prices, opening hours, policies. Call this before answering any question about the business.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "The caller's question, in the words and language they used.",
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: TRANSFER_TOOL,
    description:
      'Connect the caller to a human member of staff. Use when the caller asks for a person or accepts your offer to connect them.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'A few words on why the caller needs a person.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: MESSAGE_TOOL,
    description: 'Save a message for the staff to call the caller back.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The caller's name." },
        phone: {
          type: 'string',
          description: 'The number to call back. Leave empty to use the number they are calling from.',
        },
        message: { type: 'string', description: 'What the caller wants, in their own words.' },
      },
      required: ['name', 'message'],
      additionalProperties: false,
    },
  },
];

/**
 * Builds the session.update event, once at startup, and sends the same object
 * for every call. Changing instructions or tools mid-session lowers the cache
 * hit rate, so the session is never updated after this. The model is chosen in
 * the WebSocket URL, because the API doesn't allow changing it here.
 */
export function buildSessionUpdate(
  config: GatewayConfig,
  instructions: string,
): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions,
      tools,
      tool_choice: 'auto',
      reasoning: { effort: config.REALTIME_REASONING_EFFORT },
      audio: {
        input: {
          format: TELEPHONY_AUDIO,
          turn_detection: {
            type: 'server_vad',
            threshold: config.VAD_THRESHOLD,
            prefix_padding_ms: config.VAD_PREFIX_PADDING_MS,
            silence_duration_ms: config.VAD_SILENCE_DURATION_MS,
            create_response: true,
            interrupt_response: true,
          },
          // No language is set, because callers may use any of several languages.
          transcription: { model: config.TRANSCRIPTION_MODEL },
        },
        output: {
          format: TELEPHONY_AUDIO,
          voice: config.REALTIME_VOICE,
        },
      },
    },
  };
}
