import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatCompletionPayload, parseSseLine, splitSseLines } from './streamProxy.js';

test('buildChatCompletionPayload forces streaming mode', () => {
  const payload = JSON.parse(buildChatCompletionPayload({
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 256,
    temperature: 0.3,
  }));

  assert.equal(payload.stream, true);
  assert.equal(payload.max_tokens, 256);
  assert.equal(payload.temperature, 0.3);
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'hello' }]);
});

test('buildChatCompletionPayload forwards chat template kwargs', () => {
  const payload = JSON.parse(buildChatCompletionPayload({
    messages: [{ role: 'user', content: 'hello' }],
    chat_template_kwargs: { enable_thinking: false },
  }));

  assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
});

test('splitSseLines keeps incomplete tail in the buffer', () => {
  const result = splitSseLines('', 'data: {"choices":[{"delta":{"content":"Hel"}}]}\npartial');

  assert.deepEqual(result.lines, ['data: {"choices":[{"delta":{"content":"Hel"}}]}']);
  assert.equal(result.buffer, 'partial');
});

test('parseSseLine extracts assistant deltas', () => {
  const event = parseSseLine('data: {"choices":[{"delta":{"content":"hello"}}]}');

  assert.deepEqual(event, { type: 'delta', delta: 'hello' });
});

test('parseSseLine detects completion sentinel', () => {
  assert.deepEqual(parseSseLine('data: [DONE]'), { type: 'done' });
});
