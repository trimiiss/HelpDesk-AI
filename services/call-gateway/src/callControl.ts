import { buildDialTwiml } from './twiml.js';

/** Actions on the live call that go through Twilio's REST API, not the media stream. */
export interface CallControl {
  transfer(callSid: string): Promise<void>;
  hangup(callSid: string): Promise<void>;
}

export interface CallControlOptions {
  accountSid: string;
  authToken: string;
  /** The real API by default. The simulation points this at its own fake. */
  apiBaseUrl: string;
  /** Comes only from config. The model never supplies a number, so it can't be talked into dialing one. */
  transferNumber: string | undefined;
  timeoutMs?: number;
}

export function createCallControl(options: CallControlOptions): CallControl {
  const authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`;
  const base = options.apiBaseUrl.replace(/\/$/, '');

  const updateCall = async (callSid: string, fields: Record<string, string>): Promise<void> => {
    const url = `${base}/2010-04-01/Accounts/${options.accountSid}/Calls/${callSid}.json`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Twilio returned ${response.status}: ${detail}`);
    }
  };

  return {
    async transfer(callSid) {
      if (!options.transferNumber) throw new Error('TRANSFER_NUMBER is not configured');
      await updateCall(callSid, { Twiml: buildDialTwiml(options.transferNumber) });
    },
    async hangup(callSid) {
      await updateCall(callSid, { Status: 'completed' });
    },
  };
}
