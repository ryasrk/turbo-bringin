export function buildChatCompletionPayload({ messages, max_tokens, temperature, chat_template_kwargs, reasoning_format }) {
  const MAX_TOKENS_CAP = 8192;
  const payload = {
    messages: Array.isArray(messages) ? messages : [],
    max_tokens: Number.isFinite(max_tokens) ? Math.min(max_tokens, MAX_TOKENS_CAP) : 1024,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    stream: true,
  };

  if (chat_template_kwargs && typeof chat_template_kwargs === 'object' && !Array.isArray(chat_template_kwargs)) {
    payload.chat_template_kwargs = chat_template_kwargs;
  }

  if (typeof reasoning_format === 'string' && reasoning_format) {
    payload.reasoning_format = reasoning_format;
  }

  return JSON.stringify(payload);
}

export function splitSseLines(buffer, chunk = '') {
  const combined = `${buffer}${chunk}`;
  const lines = combined.split('\n');

  return {
    lines: lines.slice(0, -1),
    buffer: lines.at(-1) ?? '',
  };
}

export function parseSseLine(line) {
  if (!line.startsWith('data: ')) {
    return null;
  }

  const data = line.slice(6).trim();
  if (!data) {
    return null;
  }

  if (data === '[DONE]') {
    return { type: 'done' };
  }

  try {
    const payload = JSON.parse(data);
    const delta = payload.choices?.[0]?.delta?.content;

    if (!delta) {
      return { type: 'meta', payload };
    }

    return { type: 'delta', delta };
  } catch (error) {
    return {
      type: 'invalid',
      message: error instanceof Error ? error.message : 'Invalid SSE payload',
      raw: data,
    };
  }
}
