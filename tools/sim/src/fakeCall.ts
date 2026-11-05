import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { decodeAgentSpeech, encodeCallerSpeech } from './protocol.js';
import { MediaPump, placeCall, type CallerConfig } from './twilioCaller.js';

/**
 * A scripted caller. `conversation` walks through everything a caller can do and
 * fails if the agent gets something wrong. `hold` keeps calls open, for testing
 * long calls, restarts and autoscaling.
 *
 *   fakeCall --scenario conversation
 *   fakeCall --scenario hold --calls 20 --hold-seconds 660
 */

const { values: options } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'conversation' },
    calls: { type: 'string', default: '1' },
    'hold-seconds': { type: 'string', default: '30' },
    'sim-url': { type: 'string', default: process.env.SIM_URL ?? 'http://127.0.0.1:9000' },
  },
});

const config: CallerConfig = {
  gatewayUrl: process.env.GATEWAY_URL ?? 'http://call-gateway:8080',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? '',
  authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
};

class SimulatedCall {
  readonly heard: string[] = [];
  clears = 0;
  closed = false;
  closeCode: number | undefined;
  private waiters: (() => void)[] = [];

  private constructor(
    readonly callSid: string,
    private readonly socket: WebSocket,
    private readonly pump: MediaPump,
  ) {
    socket.on('message', (data) => this.onMessage(data.toString()));
    socket.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      this.wake();
    });
  }

  static async start(from: string): Promise<SimulatedCall> {
    const { callSid, socket } = await placeCall(config, from, '+10000000002');
    return new SimulatedCall(callSid, socket, new MediaPump(socket));
  }

  private onMessage(raw: string): void {
    const message = JSON.parse(raw) as {
      event: string;
      media?: { payload: string };
      mark?: { name: string };
    };

    if (message.event === 'media' && message.media) {
      this.pump.onMedia(message.media.payload);
      const text = decodeAgentSpeech(message.media.payload);
      if (text !== undefined) {
        this.heard.push(text);
        this.wake();
      }
    } else if (message.event === 'mark' && message.mark) {
      this.pump.onMark(message.mark.name);
    } else if (message.event === 'clear') {
      this.clears += 1;
      this.pump.onClear();
      this.wake();
    }
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  /** Waits until a condition holds, or fails with a description of what never happened. */
  async until(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${what}`);
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 200))),
      ]);
    }
  }

  say(text: string): void {
    console.log(`  caller: ${text}`);
    this.pump.sendFrame(encodeCallerSpeech(text));
  }

  /** Waits for the agent's next line after this point in the call. */
  async nextLine(): Promise<string> {
    const seen = this.heard.length;
    await this.until(() => this.heard.length > seen, 'the agent to reply');
    const line = this.heard[this.heard.length - 1] ?? '';
    console.log(`  agent:  ${line.replace(/\s+/g, ' ').slice(0, 110)}`);
    return line;
  }

  hangUp(): void {
    this.pump.stop();
  }
}

function expectThat(condition: boolean, description: string): void {
  if (!condition) throw new Error(`FAILED: ${description}`);
  console.log(`  ok: ${description}`);
}

/** The fake Twilio records REST updates, so the scripted caller can see the transfer happen. */
async function waitForTwilioUpdate(callSid: string): Promise<{ twiml?: string; status?: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${options['sim-url']}/sim/calls/${callSid}`);
    const update = (await response.json()) as { twiml?: string; status?: string };
    if (update.twiml || update.status) return update;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the call to be updated through Twilio');
}

async function conversation(): Promise<void> {
  const call = await SimulatedCall.start('+38344000001');
  console.log(`call ${call.callSid}`);

  await call.until(() => call.heard.length > 0, 'the greeting');
  console.log(`  agent:  ${call.heard[0]?.slice(0, 110)}`);
  expectThat(call.heard[0]?.includes('inteligjencë artificiale') === true, 'greets in Albanian and says it is an AI');

  call.say('What are your opening hours on Saturday?');
  expectThat((await call.nextLine()).includes('09:00'), 'answers opening hours from the FAQ');

  call.say('Sa zgjat ndërrimi i vajit?');
  expectThat((await call.nextLine()).includes('45 minuta'), 'answers in Albanian from the Albanian file');

  call.say('Wie lange gilt die Garantie auf Reparaturen?');
  expectThat((await call.nextLine()).includes('zwölf Monate'), 'answers in German from the PDF');

  call.say('Do you sell helicopters or submarines?');
  expectThat(
    (await call.nextLine()).includes("don't have that information"),
    'admits it does not know instead of inventing an answer',
  );

  // A long reply, cut off mid-sentence.
  call.say('Tell me about the warranty conditions and tyres and brakes and repairs');
  await call.nextLine();
  const clearsBefore = call.clears;
  await new Promise((resolve) => setTimeout(resolve, 150));
  call.say('Sorry, what is your location?');
  await call.until(() => call.clears > clearsBefore, 'buffered audio to be cleared');
  expectThat(true, 'stops talking when interrupted');
  expectThat((await call.nextLine()).includes('Rruga Demo'), 'answers the new question after being interrupted');

  call.say('Please take a message: my brakes are squeaking, call me back');
  expectThat((await call.nextLine()).includes('saved'), 'saves a callback message');

  call.say('Now let me talk to a person');
  expectThat((await call.nextLine()).includes('connecting'), 'announces the transfer');

  const update = await waitForTwilioUpdate(call.callSid);
  expectThat(update.twiml?.includes('<Dial>') === true, 'transfers through Twilio to the configured number');

  // Twilio ends the stream once it has moved the call.
  call.hangUp();
  await call.until(() => call.closed, 'the stream to close');

  console.log(`\nConversation passed. Call reference: ${call.callSid}`);
}

async function hold(): Promise<void> {
  const count = Number(options.calls);
  const holdSeconds = Number(options['hold-seconds']);
  console.log(`holding ${count} call(s) for ${holdSeconds} s`);

  const calls = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const call = await SimulatedCall.start(`+3834400${String(index).padStart(4, '0')}`);
      await call.until(() => call.heard.length > 0, 'the greeting', 15_000);
      return call;
    }),
  );

  const startedAt = Date.now();
  const deadline = startedAt + holdSeconds * 1000;
  while (Date.now() < deadline && calls.every((call) => !call.closed)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (elapsed % 30 === 0) console.log(`  ${elapsed} s: ${calls.filter((c) => !c.closed).length} still connected`);
  }

  const dropped = calls.filter((call) => call.closed);
  for (const call of calls) call.hangUp();

  if (dropped.length > 0) {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    throw new Error(`${dropped.length} call(s) dropped after ${seconds} s (close code ${dropped[0]?.closeCode})`);
  }
  console.log(`all ${count} call(s) stayed connected for ${holdSeconds} s`);
}

try {
  await (options.scenario === 'hold' ? hold() : conversation());
  process.exit(0);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
