import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TOOL, SEARCH_TOOL, TRANSFER_TOOL } from '../src/session.js';
import { CALL_SID, createHarness, TIMING } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('search_knowledge', () => {
  it('returns the results to the model and asks it to answer', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(SEARCH_TOOL, 'call_1', 'completed', { query: 'opening hours' });
    await settle();

    expect(call.searchKnowledge).toHaveBeenCalledExactlyOnceWith('opening hours');
    expect(call.toolOutput()).toEqual({
      found: true,
      results: [{ text: 'We open at 8.', source: 'faq.md' }],
    });
    expect(call.sentToOpenAI('response.create')).toHaveLength(1);
  });

  it('keeps the audio flowing while the search runs', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.searchKnowledge.mockReturnValueOnce(new Promise(() => {}));

    call.modelCallsTool(SEARCH_TOOL, 'call_1', 'completed', { query: 'hours' });
    call.mediaAt(2000);

    expect(call.sentToOpenAI('input_audio_buffer.append')).toHaveLength(1);
  });

  it('reports not found honestly', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.searchKnowledge.mockResolvedValueOnce({ found: false, results: [] });

    call.modelCallsTool(SEARCH_TOOL, 'call_1', 'completed', { query: 'helicopters' });
    await settle();

    expect(call.toolOutput()).toEqual({ found: false, results: [] });
  });

  it('tells the model when search is down, so it can apologise', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.searchKnowledge.mockRejectedValueOnce(new Error('timeout'));

    call.modelCallsTool(SEARCH_TOOL, 'call_1', 'completed', { query: 'hours' });
    await settle();

    expect(call.toolOutput()).toEqual({ found: false, results: [], error: 'search_unavailable' });
    expect(call.sentToOpenAI('response.create')).toHaveLength(1);
    expect(call.metrics.error).toHaveBeenCalledWith('tool_search_knowledge');
  });

  it('never calls the service with an empty query', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(SEARCH_TOOL, 'call_1', 'completed', { query: '   ' });
    await settle();

    expect(call.searchKnowledge).not.toHaveBeenCalled();
    expect(call.toolOutput()).toMatchObject({ found: false, error: 'empty_query' });
  });

  it('survives arguments that are not valid JSON', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({ type: 'response.created', response: { id: 'r' } });

    call.openai({
      type: 'response.done',
      response: {
        id: 'r',
        status: 'completed',
        output: [{ type: 'function_call', name: SEARCH_TOOL, call_id: 'c', arguments: '{oops' }],
      },
    });
    await settle();

    expect(call.toolOutput()).toMatchObject({ error: 'empty_query' });
  });

  it('drops the result if the caller hung up during the search', async () => {
    const call = createHarness();
    call.connectAndGreet();
    let finish: (value: { found: boolean; results: [] }) => void = () => {};
    call.searchKnowledge.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    call.modelCallsTool(SEARCH_TOOL, 'call_1', 'completed', { query: 'hours' });
    call.twilio({ event: 'stop' });
    call.toOpenAI.length = 0;
    finish({ found: false, results: [] });
    await settle();

    expect(call.toOpenAI).toEqual([]);
  });

  it('holds its response if another one has started meanwhile', async () => {
    const call = createHarness();
    call.connectAndGreet();
    let finish: (value: { found: boolean; results: [] }) => void = () => {};
    call.searchKnowledge.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    call.modelCallsTool(SEARCH_TOOL, 'call_1', 'completed', { query: 'hours' });
    call.openai({ type: 'response.created', response: { id: 'resp_vad' } });
    finish({ found: false, results: [] });
    await settle();
    expect(call.sentToOpenAI('response.create')).toHaveLength(0);

    call.openai({ type: 'response.done', response: { id: 'resp_vad', status: 'completed' } });
    expect(call.sentToOpenAI('response.create')).toHaveLength(1);
  });

  it('records how the tool went', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(SEARCH_TOOL, 'call_1', 'completed', { query: 'hours' });
    await settle();

    expect(call.metrics.toolCall).toHaveBeenCalledWith(SEARCH_TOOL, 'ok', expect.any(Number));
  });
});

describe('take_message', () => {
  const details = { name: 'Arta', phone: '+38344000000', message: 'Please call me back' };

  it('saves the message and confirms only after the broker has it', async () => {
    const call = createHarness();
    call.connectAndGreet();
    let accept = () => {};
    call.events.publishNow.mockReturnValueOnce(new Promise((resolve) => (accept = () => resolve())));

    call.modelCallsTool(MESSAGE_TOOL, 'call_1', 'completed', details);
    await settle();
    expect(call.toOpenAI).toEqual([]);

    accept();
    await settle();

    expect(call.toolOutput()).toEqual({ ok: true });
    expect(call.events.publishNow.mock.calls[0]?.[0]).toMatchObject({
      type: 'message.taken',
      callSid: CALL_SID,
      ...details,
    });
  });

  it('gives the broker a time limit, so a caller is not left waiting', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(MESSAGE_TOOL, 'call_1', 'completed', details);
    await settle();

    expect(call.events.publishNow.mock.calls[0]?.[2]).toBe(TIMING.messageSaveTimeoutMs);
  });

  it('never claims success when the message could not be saved', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.events.publishNow.mockRejectedValueOnce(new Error('nats is down'));

    call.modelCallsTool(MESSAGE_TOOL, 'call_1', 'completed', details);
    await settle();

    expect(call.toolOutput()).toEqual({ ok: false, error: 'not_saved' });
  });

  it('uses the caller ID when no number is given', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(MESSAGE_TOOL, 'call_1', 'completed', { ...details, phone: '' });
    await settle();

    expect(call.events.ofType('message.taken')[0]?.phone).toBe('+15550001111');
  });

  it('asks for a number if there is no caller ID either', async () => {
    const call = createHarness();
    call.twilio({
      event: 'start',
      streamSid: 'MZ1',
      start: { streamSid: 'MZ1', callSid: CALL_SID },
    });
    call.openRealtime();
    call.openai({ type: 'session.updated' });
    call.openai({ type: 'response.done', response: { id: 'g', status: 'completed' } });
    call.toOpenAI.length = 0;

    call.modelCallsTool(MESSAGE_TOOL, 'call_1', 'completed', { name: 'A', message: 'hi' });
    await settle();

    expect(call.toolOutput()).toEqual({ ok: false, error: 'missing_phone' });
  });

  it.each([
    ['no name', { message: 'hi' }],
    ['no message', { name: 'A' }],
  ])('refuses a message with %s', async (_name, args) => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(MESSAGE_TOOL, 'call_1', 'completed', args);
    await settle();

    expect(call.toolOutput()).toEqual({ ok: false, error: 'missing_name_or_message' });
    expect(call.events.publishNow).not.toHaveBeenCalled();
  });

  it('caps the length of what a caller can leave', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(MESSAGE_TOOL, 'call_1', 'completed', {
      ...details,
      message: 'x'.repeat(10_000),
    });
    await settle();

    expect(call.events.ofType('message.taken')[0]?.message).toHaveLength(2000);
  });
});

describe('events', () => {
  it('announces the call with its details and trace', () => {
    const call = createHarness();
    call.start();

    expect(call.events.ofType('call.started')[0]).toMatchObject({
      callSid: CALL_SID,
      from: '+15550001111',
      to: '+15550002222',
      model: 'test-model',
    });
  });

  it('never waits on the broker for routine events', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.twilio({ event: 'stop' });

    expect(call.events.enqueue).toHaveBeenCalled();
    expect(call.events.publishNow).not.toHaveBeenCalled();
  });

  it('records a transfer request with its reason', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.modelCallsTool(TRANSFER_TOOL, 'call_1', 'completed', { reason: 'wants a mechanic' });

    expect(call.events.ofType('transfer.requested')[0]).toMatchObject({ reason: 'wants a mechanic' });
  });

  it('reports the call end once, with its reason, usage and cost', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({
      type: 'response.done',
      response: {
        id: 'r',
        status: 'completed',
        usage: {
          input_token_details: {
            text_tokens: 100,
            audio_tokens: 50,
            cached_tokens_details: { text_tokens: 60, audio_tokens: 20 },
          },
          output_token_details: { text_tokens: 10, audio_tokens: 200 },
        },
      },
    });

    call.twilio({ event: 'stop' });
    call.session.handleTwilioClosed();

    const ended = call.events.ofType('call.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      reason: 'caller_hangup',
      costUsd: 0.25,
      usage: {
        textInputTokens: 40,
        textCachedTokens: 60,
        audioInputTokens: 30,
        audioCachedTokens: 20,
        textOutputTokens: 10,
        audioOutputTokens: 200,
      },
    });
  });

  it('adds up usage across responses', () => {
    const call = createHarness();
    call.connectAndGreet();
    const usage = { output_token_details: { audio_tokens: 10 } };
    call.openai({ type: 'response.done', response: { id: 'a', status: 'completed', usage } });
    call.openai({ type: 'response.done', response: { id: 'b', status: 'cancelled', usage } });

    call.twilio({ event: 'stop' });

    expect(call.events.ofType('call.ended')[0]?.usage.audioOutputTokens).toBe(20);
  });

  it('counts transcription time towards the cost', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'hello',
      usage: { type: 'duration', seconds: 12 },
    });

    call.twilio({ event: 'stop' });

    expect(call.events.ofType('call.ended')[0]?.usage.transcriptionSeconds).toBe(12);
  });

  it('sends no call.ended for a socket that never became a call', async () => {
    const call = createHarness();
    await vi.advanceTimersByTimeAsync(TIMING.sessionReadyTimeoutMs);
    expect(call.events.ofType('call.ended')).toEqual([]);
    expect(call.metrics.callEnded).not.toHaveBeenCalled();
  });
});

describe('transcripts', () => {
  it('publishes both sides of the conversation', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.openai({ type: 'input_audio_buffer.committed', item_id: 'user_1' });
    call.openai({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user_1',
      transcript: 'What time do you open?',
    });
    call.openai({ type: 'response.output_item.added', item: { id: 'agent_1' } });
    call.openai({
      type: 'response.output_audio_transcript.done',
      item_id: 'agent_1',
      transcript: 'We open at eight.',
    });

    expect(call.events.ofType('transcript.completed').map(({ role, text }) => [role, text])).toEqual([
      ['caller', 'What time do you open?'],
      ['agent', 'We open at eight.'],
    ]);
  });

  it('keeps conversation order when transcripts finish out of order', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.openai({ type: 'input_audio_buffer.committed', item_id: 'user_1' });
    call.openai({ type: 'response.output_item.added', item: { id: 'agent_1' } });

    // The reply finishes before the slower transcription of the question.
    call.openai({ type: 'response.output_audio_transcript.done', item_id: 'agent_1', transcript: 'Answer' });
    call.openai({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user_1',
      transcript: 'Question',
    });

    const turns = call.events.ofType('transcript.completed');
    const sequenceOf = (text: string) => turns.find((turn) => turn.text === text)?.sequence ?? 0;
    expect(sequenceOf('Question')).toBeLessThan(sequenceOf('Answer'));
  });

  it('marks a reply the caller interrupted', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({ type: 'response.created', response: { id: 'r' } });
    call.agentAudio('agent_1', 1000, 'r');

    call.openai({ type: 'input_audio_buffer.speech_started' });
    call.openai({ type: 'response.output_audio_transcript.done', item_id: 'agent_1', transcript: 'We op' });

    expect(call.events.ofType('transcript.completed')[0]?.interrupted).toBe(true);
  });

  it('falls back to the response body if no transcript event arrives', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.openai({
      type: 'response.done',
      response: {
        id: 'r',
        status: 'cancelled',
        output: [
          { type: 'message', id: 'agent_1', role: 'assistant', content: [{ transcript: 'Partial reply' }] },
        ],
      },
    });

    expect(call.events.ofType('transcript.completed')[0]?.text).toBe('Partial reply');
  });

  it('does not publish the same turn twice', () => {
    const call = createHarness();
    call.connectAndGreet();

    call.openai({ type: 'response.output_audio_transcript.done', item_id: 'agent_1', transcript: 'Hi' });
    call.openai({
      type: 'response.done',
      response: {
        id: 'r',
        status: 'completed',
        output: [{ type: 'message', id: 'agent_1', role: 'assistant', content: [{ transcript: 'Hi' }] }],
      },
    });

    expect(call.events.ofType('transcript.completed')).toHaveLength(1);
  });

  it('skips empty transcripts', () => {
    const call = createHarness();
    call.connectAndGreet();
    call.openai({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user_1',
      transcript: '   ',
    });
    expect(call.events.ofType('transcript.completed')).toEqual([]);
  });
});

describe('metrics', () => {
  it('tracks the call from start to end', () => {
    const call = createHarness();
    call.connectAndGreet();
    expect(call.metrics.callStarted).toHaveBeenCalledOnce();

    call.twilio({ event: 'stop' });

    expect(call.metrics.callEnded).toHaveBeenCalledExactlyOnceWith(
      'caller_hangup',
      expect.any(Number),
      0.25,
      expect.any(Object),
    );
  });

  it('times from the caller stopping to the first audio of the reply', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.openai({ type: 'input_audio_buffer.speech_stopped' });
    await vi.advanceTimersByTimeAsync(700);
    call.agentAudio('item_1', 100);
    call.agentAudio('item_1', 100);

    expect(call.metrics.firstAudio).toHaveBeenCalledExactlyOnceWith(0.7);
  });

  it('does not time a reply the caller talked over', async () => {
    const call = createHarness();
    call.connectAndGreet();

    call.openai({ type: 'input_audio_buffer.speech_stopped' });
    call.openai({ type: 'input_audio_buffer.speech_started' });
    call.agentAudio('item_1', 100);

    expect(call.metrics.firstAudio).not.toHaveBeenCalled();
  });

  it('counts failures', async () => {
    const call = createHarness();
    call.connectAndGreet();
    call.control.transfer.mockRejectedValueOnce(new Error('twilio down'));

    call.closeRealtime();
    await settle();

    expect(call.metrics.error).toHaveBeenCalledWith('realtime_session');
    expect(call.metrics.error).toHaveBeenCalledWith('twilio_rest');
  });
});
