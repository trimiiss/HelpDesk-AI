import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSFER_TOOL } from '../src/session.js';
import { CALL_SID, STREAM_SID, TIMING, audioOfMs, createHarness, SESSION_UPDATE } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('call setup', () => {
  it('connects to OpenAI only once Twilio has started the stream', () => {
    const call = createHarness();
    expect(call.realtimeConnected).toBe(false);
    call.start();
    expect(call.realtimeConnected).toBe(true);
  });

  it('configures the session, then greets once the session is ready', () => {
    const call = createHarness();
    call.start();
    call.openRealtime();
    expect(call.toOpenAI).toEqual([SESSION_UPDATE]);

    call.openai({ type: 'session.updated' });

    expect(call.timeline).toEqual([
      'openai:session.update',
      'openai:conversation.item.create',
      'openai:response.create',
    ]);
    expect(call.toOpenAI[1]).toMatchObject({
      item: { type: 'message', role: 'system', content: [{ type: 'input_text' }] },
    });
  });

  it('greets only once if session.updated repeats', () => {
    const call = createHarness();
    call.start();
    call.openRealtime();
    call.openai({ type: 'session.updated' });
    call.openai({ type: 'session.updated' });
    expect(call.sentToOpenAI('response.create')).toHaveLength(1);
  });

  it('ignores a repeated start message', () => {
    const call = createHarness();
    call.start();
    call.start();
    call.openRealtime();
    expect(call.toOpenAI).toHaveLength(1);
  });

  it('survives malformed JSON from Twilio', () => {
    const call = createHarness();
    expect(() => call.session.handleTwilioMessage('not json')).not.toThrow();
  });
});

describe('audio bridging', () => {
  it('holds back caller audio until the session is ready', () => {
    const call = createHarness();
    call.start();
    call.openRealtime();
    call.mediaAt(20);
    expect(call.sentToOpenAI('input_audio_buffer.append')).toHaveLength(0);
  });

  it('passes caller audio through unchanged', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.mediaAt(20, 'c2FtcGxl');
    expect(call.toOpenAI).toEqual([{ type: 'input_audio_buffer.append', audio: 'c2FtcGxl' }]);
  });

  it('ignores tracks other than the caller', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.twilio({ event: 'media', media: { track: 'outbound', timestamp: '20', payload: 'AAAA' } });
    expect(call.toOpenAI).toHaveLength(0);
  });

  it('sends agent audio to Twilio unchanged, each chunk followed by a mark', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.agentAudio('item_1', 100);
    expect(call.toTwilio).toEqual([
      { event: 'media', streamSid: STREAM_SID, media: { payload: audioOfMs(100) } },
      { event: 'mark', streamSid: STREAM_SID, mark: { name: 'audio-1' } },
    ]);
  });
});

describe('barge-in', () => {
  function interruptedCall() {
    const call = createHarness();
    call.connectAndGreet();
    call.mediaAt(1000);
    call.openai({ type: 'response.created', response: { id: 'resp_1' } });
    call.agentAudio('item_1', 5000);
    call.toOpenAI.length = 0;
    call.timeline.length = 0;
    return call;
  }

  it('clears Twilio first, then cancels, then truncates', () => {
    const call = interruptedCall();
    call.mediaAt(2500);
    call.timeline.length = 0;

    call.openai({ type: 'input_audio_buffer.speech_started' });

    expect(call.timeline).toEqual([
      'twilio:clear',
      'openai:response.cancel',
      'openai:conversation.item.truncate',
    ]);
  });

  it('truncates at what the caller actually heard', () => {
    const call = interruptedCall();
    call.mediaAt(2500);
    call.openai({ type: 'input_audio_buffer.speech_started' });
    expect(call.sentToOpenAI('conversation.item.truncate')).toEqual([
      {
        type: 'conversation.item.truncate',
        item_id: 'item_1',
        content_index: 0,
        audio_end_ms: 1500,
      },
    ]);
  });

  it('never truncates past the audio sent, which the API rejects', () => {
    const call = interruptedCall();
    call.mediaAt(60_000);
    call.openai({ type: 'input_audio_buffer.speech_started' });
    expect(call.sentToOpenAI('conversation.item.truncate')[0]).toMatchObject({
      audio_end_ms: 5000,
    });
  });

  it('counts a queued item from when the earlier one finishes playing', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.mediaAt(1000);
    call.openai({ type: 'response.created', response: { id: 'resp_1' } });
    call.agentAudio('item_1', 2000);
    call.openai({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
    call.openai({ type: 'response.created', response: { id: 'resp_2' } });
    call.agentAudio('item_2', 2000, 'resp_2');

    call.mediaAt(3500);
    call.openai({ type: 'input_audio_buffer.speech_started' });

    expect(call.sentToOpenAI('conversation.item.truncate')[0]).toMatchObject({
      item_id: 'item_2',
      audio_end_ms: 500,
    });
  });

  it('never sends a negative truncation point', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.mediaAt(1000);
    call.openai({ type: 'response.created', response: { id: 'resp_1' } });
    call.agentAudio('item_1', 2000);
    call.openai({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
    call.openai({ type: 'response.created', response: { id: 'resp_2' } });
    call.agentAudio('item_2', 2000, 'resp_2');

    call.mediaAt(1500);
    call.openai({ type: 'input_audio_buffer.speech_started' });

    expect(call.sentToOpenAI('conversation.item.truncate')[0]).toMatchObject({ audio_end_ms: 0 });
  });

  it('drops audio that arrives late from the cancelled response', () => {
    const call = interruptedCall();
    call.openai({ type: 'input_audio_buffer.speech_started' });
    call.toTwilio.length = 0;

    call.agentAudio('item_1', 500);

    expect(call.toTwilio).toEqual([]);
  });

  it('plays the next response normally after an interruption', () => {
    const call = interruptedCall();
    call.openai({ type: 'input_audio_buffer.speech_started' });
    call.openai({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled' } });
    call.toTwilio.length = 0;

    call.openai({ type: 'response.created', response: { id: 'resp_2' } });
    call.agentAudio('item_2', 500, 'resp_2');

    expect(call.toTwilio.map((message) => message.event)).toEqual(['media', 'mark']);
  });

  it('does nothing when the agent is silent', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({ type: 'input_audio_buffer.speech_started' });
    expect(call.timeline).toEqual([]);
  });

  it('does not clear or truncate once playback has finished', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({ type: 'response.created', response: { id: 'resp_1' } });
    call.agentAudio('item_1', 500);
    call.openai({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
    call.echoAllMarks();
    call.timeline.length = 0;

    call.openai({ type: 'input_audio_buffer.speech_started' });

    expect(call.timeline).toEqual([]);
  });

  it('still clears audio buffered at Twilio after generation has finished', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({ type: 'response.created', response: { id: 'resp_1' } });
    call.agentAudio('item_1', 5000);
    call.openai({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
    call.timeline.length = 0;

    call.openai({ type: 'input_audio_buffer.speech_started' });

    expect(call.timeline).toEqual(['twilio:clear', 'openai:conversation.item.truncate']);
  });

  it('cancels a response that has not produced audio yet', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({ type: 'response.created', response: { id: 'resp_1' } });
    call.openai({ type: 'input_audio_buffer.speech_started' });
    expect(call.timeline).toEqual(['openai:response.cancel']);
  });
});

describe('transfer_to_human', () => {
  it('returns the tool result and asks the model to announce the transfer', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(TRANSFER_TOOL);

    expect(call.toOpenAI).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: JSON.stringify({ ok: true, status: 'connecting' }),
        },
      },
      { type: 'response.create' },
    ]);
    expect(call.control.transfer).not.toHaveBeenCalled();
  });

  it('waits for the announcement to finish playing before transferring', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL);
    call.announceTransfer();
    expect(call.control.transfer).not.toHaveBeenCalled();

    call.echoAllMarks();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.control.transfer).toHaveBeenCalledExactlyOnceWith(CALL_SID);
  });

  it('transfers on the timeout if Twilio never echoes the mark', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL);
    call.announceTransfer();

    await vi.advanceTimersByTimeAsync(TIMING.transferPlaybackTimeoutMs);

    expect(call.control.transfer).toHaveBeenCalledOnce();
  });

  it('transfers on the timeout if the model never announces it', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL);

    await vi.advanceTimersByTimeAsync(TIMING.transferPlaybackTimeoutMs);

    expect(call.control.transfer).toHaveBeenCalledOnce();
  });

  it('transfers straight away if the announcement had no audio', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL);
    call.openai({ type: 'response.created', response: { id: 'resp_announce' } });
    call.openai({ type: 'response.done', response: { id: 'resp_announce', status: 'completed' } });
    await vi.advanceTimersByTimeAsync(0);

    expect(call.control.transfer).toHaveBeenCalledOnce();
  });

  it('still transfers if the caller interrupts the announcement', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL);
    call.openai({ type: 'response.created', response: { id: 'resp_announce' } });
    call.agentAudio('item_announce', 1000, 'resp_announce');

    call.openai({ type: 'input_audio_buffer.speech_started' });
    call.openai({ type: 'response.done', response: { id: 'resp_announce', status: 'cancelled' } });
    call.echoAllMarks();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.control.transfer).toHaveBeenCalledOnce();
  });

  it('transfers only once if the model calls the tool twice', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL, 'call_1');
    call.modelCallsTool(TRANSFER_TOOL, 'call_2');
    call.announceTransfer();
    call.echoAllMarks();
    await vi.advanceTimersByTimeAsync(TIMING.transferPlaybackTimeoutMs);

    expect(call.control.transfer).toHaveBeenCalledOnce();
  });

  it('stops listening once the announcement is done', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL);
    call.announceTransfer();
    call.toOpenAI.length = 0;

    call.mediaAt(5000);

    expect(call.toOpenAI).toEqual([]);
  });

  it('tells the model when no transfer number is configured', async () => {
    const call = createHarness({ transferAvailable: false });
    call.connectAndGreet();

    call.modelCallsTool(TRANSFER_TOOL);
    await vi.advanceTimersByTimeAsync(TIMING.transferPlaybackTimeoutMs);

    expect(call.toOpenAI[0]).toMatchObject({
      item: { output: JSON.stringify({ ok: false, error: 'transfer_unavailable' }) },
    });
    expect(call.control.transfer).not.toHaveBeenCalled();
  });

  it('ignores a tool call from a cancelled response', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(TRANSFER_TOOL, 'call_1', 'cancelled');
    await vi.advanceTimersByTimeAsync(TIMING.transferPlaybackTimeoutMs);

    expect(call.toOpenAI).toEqual([]);
    expect(call.control.transfer).not.toHaveBeenCalled();
  });

  it('answers an unknown tool without failing the call', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool('open_the_pod_bay_doors');

    expect(call.toOpenAI[0]).toMatchObject({
      item: { output: JSON.stringify({ ok: false, error: 'unknown_tool' }) },
    });
    expect(call.sentToOpenAI('response.create')).toHaveLength(1);
  });

  it('lets Twilio close the stream after the transfer, so the fallback never rings', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL);
    call.announceTransfer();
    call.echoAllMarks();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.twilioCloses).toBe(0);
    expect(call.realtimeCloses).toBeGreaterThan(0);

    call.twilio({ event: 'stop' });

    expect(call.endReasons).toEqual(['transferred']);
  });

  it('closes the stream itself if Twilio never does after a transfer', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL);
    call.announceTransfer();
    call.echoAllMarks();

    await vi.advanceTimersByTimeAsync(5000);

    expect(call.twilioCloses).toBe(1);
    expect(call.endReasons).toEqual(['transferred']);
  });

  it('closes the stream if the REST call fails, so the <Dial> fallback runs', async () => {
    const call = createHarness();
    call.control.transfer.mockRejectedValueOnce(new Error('twilio is down'));
    call.connectAndGreet();
    call.modelCallsTool(TRANSFER_TOOL);
    call.announceTransfer();
    call.echoAllMarks();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.twilioCloses).toBe(1);
    expect(call.endReasons).toEqual(['transfer_failed']);
  });
});

describe('OpenAI failures', () => {
  it('hands the caller to a person if the socket drops mid-call', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.closeRealtime();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.control.transfer).toHaveBeenCalledExactlyOnceWith(CALL_SID);
  });

  it('hangs up if the socket drops and nobody can take the call', async () => {
    const call = createHarness({ transferAvailable: false });
    call.connectAndGreet();

    call.closeRealtime();
    await vi.advanceTimersByTimeAsync(0);

    expect(call.control.hangup).toHaveBeenCalledExactlyOnceWith(CALL_SID);
    expect(call.control.transfer).not.toHaveBeenCalled();
  });

  it('hands over if OpenAI rejects the session config', async () => {
    const call = createHarness();
    call.start();
    call.openRealtime();

    call.openai({ type: 'error', error: { type: 'invalid_request_error', message: 'bad format' } });
    await vi.advanceTimersByTimeAsync(0);

    expect(call.control.transfer).toHaveBeenCalledOnce();
  });

  it('hands over if the session is never ready', async () => {
    const call = createHarness();
    call.start();
    call.openRealtime();

    await vi.advanceTimersByTimeAsync(TIMING.sessionReadyTimeoutMs);

    expect(call.control.transfer).toHaveBeenCalledOnce();
  });

  it('keeps the call going through an error once the session is up', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.openai({ type: 'error', error: { type: 'server_error', message: 'hiccup' } });
    await vi.advanceTimersByTimeAsync(0);

    expect(call.control.transfer).not.toHaveBeenCalled();
    expect(call.endReasons).toEqual([]);
  });

  it('closes the stream if Twilio never sends start', async () => {
    const call = createHarness();

    await vi.advanceTimersByTimeAsync(TIMING.sessionReadyTimeoutMs);

    expect(call.twilioCloses).toBe(1);
    expect(call.endReasons).toEqual(['setup_failed']);
    expect(call.control.transfer).not.toHaveBeenCalled();
  });

  it('does not treat our own close of the socket as a failure', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.twilio({ event: 'stop' });

    call.closeRealtime(1000, 'normal');
    await vi.advanceTimersByTimeAsync(0);

    expect(call.control.transfer).not.toHaveBeenCalled();
    expect(call.endReasons).toEqual(['caller_hangup']);
  });
});

describe('response queueing', () => {
  it('holds a new response until the running one finishes', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({ type: 'response.created', response: { id: 'resp_1' } });

    vi.advanceTimersByTime(TIMING.maxCallMs - TIMING.goodbyeLeadMs);
    expect(call.sentToOpenAI('response.create')).toHaveLength(0);

    call.openai({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
    expect(call.sentToOpenAI('response.create')).toHaveLength(1);
  });

  it('retries after losing a race with turn detection', () => {
    const call = createHarness();
    call.connectAndGreet();
    vi.advanceTimersByTime(TIMING.maxCallMs - TIMING.goodbyeLeadMs);
    expect(call.sentToOpenAI('response.create')).toHaveLength(1);

    call.openai({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response' },
    });
    call.openai({ type: 'response.done', response: { id: 'resp_vad', status: 'completed' } });

    expect(call.sentToOpenAI('response.create')).toHaveLength(2);
  });
});

describe('maximum call length', () => {
  it('says goodbye before the limit without touching the instructions', () => {
    const call = createHarness();
    call.connectAndGreet();

    vi.advanceTimersByTime(TIMING.maxCallMs - TIMING.goodbyeLeadMs - 1);
    expect(call.timeline).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(call.timeline).toEqual(['openai:conversation.item.create', 'openai:response.create']);
    expect(call.sentToOpenAI('session.update')).toEqual([]);
    expect(call.toOpenAI[0]).toMatchObject({ item: { role: 'system' } });
  });

  it('hangs up at the limit', async () => {
    const call = createHarness();
    call.connectAndGreet();

    await vi.advanceTimersByTimeAsync(TIMING.maxCallMs);

    expect(call.control.hangup).toHaveBeenCalledExactlyOnceWith(CALL_SID);
    call.twilio({ event: 'stop' });
    expect(call.endReasons).toEqual(['max_duration']);
  });

  it('leaves a transfer in progress alone', async () => {
    const call = createHarness();
    call.connectAndGreet();
    await vi.advanceTimersByTimeAsync(TIMING.maxCallMs - 1000);
    call.modelCallsTool(TRANSFER_TOOL);

    await vi.advanceTimersByTimeAsync(1000);
    expect(call.control.hangup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TIMING.transferPlaybackTimeoutMs);
    expect(call.control.transfer).toHaveBeenCalledOnce();
  });

  it('does not run after the caller has hung up', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.twilio({ event: 'stop' });

    await vi.advanceTimersByTimeAsync(TIMING.maxCallMs);

    expect(call.control.hangup).not.toHaveBeenCalled();
  });
});

describe('cleanup', () => {
  it('runs once even when stop and socket close both arrive', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.twilio({ event: 'stop' });
    call.session.handleTwilioClosed();

    expect(call.endReasons).toEqual(['caller_hangup']);
    expect(call.twilioCloses).toBe(1);
  });

  it('leaves no timers running', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.twilio({ event: 'stop' });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the OpenAI socket when the caller hangs up, so billing stops', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.twilio({ event: 'stop' });

    expect(call.realtimeCloses).toBeGreaterThan(0);
  });

  it('ends cleanly on shutdown', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.session.shutdown();

    expect(call.endReasons).toEqual(['shutdown']);
  });
});
