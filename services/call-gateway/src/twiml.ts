import twilio from 'twilio';

const { VoiceResponse } = twilio.twiml;

export interface ConnectTwimlOptions {
  streamUrl: string;
  /** Sent to the WebSocket as start.customParameters. Twilio forbids query strings on the URL. */
  parameters: Record<string, string>;
  transferNumber: string | undefined;
}

/**
 * Connects the call to our media stream. Twilio only runs the verb after
 * <Connect> if our server closes the socket first, which is what a crash looks
 * like. Normal endings never reach it, because a hang-up or a REST update ends
 * the call directly, so this is purely the "gateway died" path: the caller gets
 * a person when one is configured, and a clean hang-up otherwise.
 */
export function buildConnectTwiml(options: ConnectTwimlOptions): string {
  const response = new VoiceResponse();
  const stream = response.connect().stream({ url: options.streamUrl });

  for (const [name, value] of Object.entries(options.parameters)) {
    stream.parameter({ name, value });
  }

  if (options.transferNumber) {
    response.dial(options.transferNumber);
  } else {
    response.hangup();
  }
  return response.toString();
}

export function buildDialTwiml(number: string): string {
  const response = new VoiceResponse();
  response.dial(number);
  return response.toString();
}
