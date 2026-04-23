/**
 * LangChain ChatModel Adapter
 *
 * Wraps the existing modelRouter into a LangChain-compatible BaseChatModel.
 * This lets us use LangChain's tool calling, memory, and chain composition
 * while keeping all existing provider configs (local, OpenAI, Anthropic, custom).
 *
 * Usage:
 *   const model = new AgentRoomChatModel({ tier: 'brain' });
 *   const result = await model.invoke([new HumanMessage('Hello')]);
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { chatCompletionWithConfig } from '../modelRouter.js';

function normalizeContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }

  return String(content || '');
}

function toOpenAIToolCall(toolCall) {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.args || {}),
    },
  };
}

function normalizeBoundTools(tools = []) {
  return tools
    .filter((tool) => tool && typeof tool === 'object' && tool.name)
    .map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      schema: tool.schema || {
        type: 'object',
        properties: {},
      },
    }));
}

/**
 * Convert LangChain messages to the format expected by modelRouter.
 */
function toLLMMessages(langchainMessages) {
  return langchainMessages.map((msg) => {
    if (msg._getType() === 'human') return { role: 'user', content: normalizeContent(msg.content) };
    if (msg._getType() === 'ai') {
      const formatted = { role: 'assistant', content: normalizeContent(msg.content) };
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        formatted.tool_calls = msg.tool_calls.map(toOpenAIToolCall);
      }
      return formatted;
    }
    if (msg._getType() === 'system') return { role: 'system', content: normalizeContent(msg.content) };
    if (msg._getType() === 'tool') {
      return {
        role: 'tool',
        content: normalizeContent(msg.content),
        tool_call_id: msg.tool_call_id,
      };
    }
    return { role: 'user', content: normalizeContent(msg.content) };
  });
}

export class AgentRoomChatModel extends BaseChatModel {
  static lc_name() {
    return 'AgentRoomChatModel';
  }

  constructor(fields = {}) {
    super(fields);
    this.tier = fields.tier || 'worker';
    this.providerConfig = fields.providerConfig || null;
    this.systemPrompt = fields.systemPrompt || '';
    this.modelName = fields.modelName || `agent-room-${this.tier}`;
  }

  _llmType() {
    return 'agent-room-chat-model';
  }

  _modelType() {
    return 'agent-room-chat-model';
  }

  /**
   * Core generation method required by BaseChatModel.
   */
  async _generate(messages, options, runManager) {
    const llmMessages = toLLMMessages(messages);

    const result = await chatCompletionWithConfig(
      this.providerConfig,
      this.tier,
      llmMessages,
      {
        systemPrompt: this.systemPrompt,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        ...(Array.isArray(this._boundTools) && this._boundTools.length > 0
          ? {
              tools: normalizeBoundTools(this._boundTools),
              toolChoice: this._boundToolOptions?.toolChoice || 'auto',
            }
          : {}),
      },
    );

    const aiMessage = new AIMessage({
      content: result.content,
      tool_calls: result.toolCalls || [],
      additional_kwargs: {
        model: result.model,
        tier: result.tier,
        provider: result.provider,
        usage: result.usage,
      },
    });

    return {
      generations: [
        {
          text: result.content,
          message: aiMessage,
          generationInfo: {
            model: result.model,
            tier: result.tier,
            usage: result.usage,
          },
        },
      ],
      llmOutput: {
        model: result.model,
        usage: result.usage,
      },
    };
  }

  /**
   * Bind tools to this model (for structured tool calling).
   * Returns a new model instance with tools bound.
   */
  bindTools(tools, options = {}) {
    const bound = new AgentRoomChatModel({
      tier: this.tier,
      providerConfig: this.providerConfig,
      systemPrompt: this.systemPrompt,
      modelName: this.modelName,
    });
    bound._boundTools = tools;
    bound._boundToolOptions = options;
    return bound;
  }
}

/**
 * Factory: create a LangChain ChatModel for a specific agent.
 */
export function createAgentModel(agent) {
  return new AgentRoomChatModel({
    tier: agent.model_tier || 'worker',
    providerConfig: agent.provider_config && Object.keys(agent.provider_config).length > 0
      ? agent.provider_config
      : null,
    systemPrompt: agent.system_prompt || `You are ${agent.name}.`,
    modelName: `${agent.name}-${agent.model_tier}`,
  });
}
