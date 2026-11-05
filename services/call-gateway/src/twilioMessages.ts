/** Messages Twilio sends on a bidirectional Media Stream. */
export type TwilioInbound =
  | { event: 'connected' }
  | {
      event: 'start';
      streamSid?: string;
      start: {
        streamSid?: string;
        callSid: string;
        customParameters?: Record<string, string>;
      };
    }
  | {
      event: 'media';
      media: { track?: string; timestamp?: string; payload: string };
    }
  | { event: 'mark'; mark?: { name?: string } }
  | { event: 'stop' }
  | { event: 'dtmf' };

/** Messages we send back to Twilio. */
export type TwilioOutbound =
  | { event: 'media'; streamSid: string; media: { payload: string } }
  | { event: 'mark'; streamSid: string; mark: { name: string } }
  | { event: 'clear'; streamSid: string };
