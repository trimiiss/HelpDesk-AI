import twilio from 'twilio';
import { buildDialTwiml } from './twiml.js';

/** Actions on the live call that go through Twilio's REST API, not the media stream. */
export interface CallControl {
  transfer(callSid: string): Promise<void>;
  hangup(callSid: string): Promise<void>;
}

export interface CallControlOptions {
  accountSid: string;
  authToken: string;
  /** Comes only from config. The model never supplies a number, so it can't be talked into dialing one. */
  transferNumber: string | undefined;
}

export function createCallControl(options: CallControlOptions): CallControl {
  const client = twilio(options.accountSid, options.authToken);

  return {
    async transfer(callSid) {
      if (!options.transferNumber) throw new Error('TRANSFER_NUMBER is not configured');
      await client.calls(callSid).update({ twiml: buildDialTwiml(options.transferNumber) });
    },
    async hangup(callSid) {
      await client.calls(callSid).update({ status: 'completed' });
    },
  };
}
