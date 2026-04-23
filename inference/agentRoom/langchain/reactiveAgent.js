/**
 * Reactive Agent — LangChain-powered autonomous agent
 *
 * Each agent in the room becomes a "reactive agent" that:
 * 1. Observes the conversation stream
 * 2. Decides whether to respond (relevance scoring)
 * 3. Chooses tools and actions autonomously
 * 4. Can propose ideas, respond to proposals, delegate work
 *
 * This replaces the simple "parse JSON → execute actions" loop with
 * a LangChain ReAct-style agent that reasons about what to do.
 */

import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { createAgentModel } from './chatModelAdapter.js';
import { createWorkspaceTools, createCollaborationTools } from './workspaceTools.js';
import { createMcpTools } from './mcpTools.js';
import { createSkillTools } from './skillTools.js';

const MAX_TOOL_ITERATIONS = 8;
const RELEVANCE_THRESHOLD = 0.3;
const KNOWN_TOOL_NAMES = new Set([
  'list_files',
  'read_file',
  'write_file',
  'update_file',
  'run_python',
  'propose',
  'respond_to_proposal',
  'think_aloud',
  'delegate',
  'search_skills',
  'read_skill',
  'list_skill_files',
]);

export function getRoleOperatingGuidance(agent) {
  const agentName = String(agent?.name || '').toLowerCase();

  if (agentName === 'planner') {
    return [
      'Your primary job is planning and coordination.',
      'Before planning, use search_skills to find relevant domain knowledge for the task.',
      'Prefer writing plans, task breakdowns, and handoff notes in notes/ before asking others to act.',
      'Delegate implementation to @coder and review to @reviewer once the plan is ready.',
      'Avoid writing or overwriting production code in src/ unless the user explicitly asks you to implement directly.',
    ];
  }

  if (agentName === 'coder') {
    return [
      'Your primary job is implementation.',
      'Before writing code, use search_skills to find relevant patterns, templates, and best practices.',
      'Read the current plan or workspace files before editing code.',
      'Write or update implementation files in src/ and other build artifacts needed for the task.',
      'Do not hand work off to yourself, and do not write review notes unless explicitly asked.',
    ];
  }

  if (agentName === 'reviewer') {
    return [
      'Your primary job is review and validation.',
      'Inspect existing plans and implementation files before responding.',
      'Write findings, approvals, or requested changes in notes/review.md or another notes/ file.',
      'Do not create or overwrite production code in src/ unless the user explicitly asks for a code change as part of review.',
    ];
  }

  if (agentName === 'scribe') {
    return [
      'Your primary job is summarization and documentation.',
      'Write summaries, handoff notes, and status updates in notes/ or README.md when appropriate.',
      'Avoid changing implementation files unless the user explicitly asks you to.',
    ];
  }

  return [
    'Stay within your role and build on the files already present in the workspace.',
    'Only change implementation files when that is clearly part of your responsibility.',
  ];
}

export function getAllowedCollaborationToolNames(agent) {
  const agentName = String(agent?.name || '').toLowerCase();

  if (agentName === 'planner') {
    return new Set(['propose', 'think_aloud', 'delegate']);
  }

  if (agentName === 'coder') {
    return new Set(['think_aloud', 'delegate']);
  }

  if (agentName === 'reviewer') {
    return new Set(['respond_to_proposal', 'think_aloud']);
  }

  if (agentName === 'scribe') {
    return new Set(['think_aloud']);
  }

  return new Set(['propose', 'respond_to_proposal', 'think_aloud', 'delegate']);
}

/**
 * Build the reactive system prompt for an agent.
 * This prompt makes the agent aware of the room context and its collaboration capabilities.
 */
function buildReactiveSystemPrompt(agent, roomContext) {
  const agentList = roomContext.agents
    .map((a) => `  - @${a.name}: ${a.role}${a.name === agent.name ? ' (you)' : ''}`)
    .join('\n');
  const roleGuidance = getRoleOperatingGuidance(agent)
    .map((line, index) => `${index + 1}. ${line}`)
    .join('\n');

  return `${agent.system_prompt || `You are ${agent.name}.`}

## Room Context
Room: ${roomContext.roomName}
${roomContext.roomDescription ? `Purpose: ${roomContext.roomDescription}` : ''}

## Team Members
${agentList}

## Your Capabilities
You work inside an isolated workspace where you can read, write, and update files.
You can collaborate with other agents through:
- **propose**: Create formal proposals for team review
- **respond_to_proposal**: Approve, reject, or suggest changes to proposals
- **think_aloud**: Share your reasoning process visibly
- **delegate**: Hand off specific tasks to other agents with @mentions

## Collaboration Guidelines
1. **Be proactive** — If you see something relevant to your role, contribute without being asked.
2. **Think before acting** — Use think_aloud to share your reasoning when making important decisions.
3. **Propose before big changes** — For significant decisions, create a proposal first.
4. **Build on others' work** — Read what others have done before starting your own work.
5. **Be concise** — Keep messages focused and actionable.
6. **Use workspace files** — Write plans, code, reviews, and notes as files in the workspace.
7. **Mentions trigger teammates** — Only mention another agent when you are intentionally handing work off or requesting review.
8. **Do the work you claim** — Do not say a file was created, updated, or reviewed unless you actually invoked the required tool.

## Role Guidance
${roleGuidance}

## Skills Library (IMPORTANT)
You have access to a curated skills library with expert-level knowledge for many domains:
UI/UX design, frontend patterns, document processing (PDF, DOCX, PPTX, XLSX), API design, brand guidelines, testing, and more.

**Before starting any implementation or review**, search for relevant skills:
1. Use **search_skills** with keywords related to your task
2. Use **read_skill** to load the full instructions from matching skills
3. Use **list_skill_files** to discover scripts, templates, and references bundled with skills

Skills contain battle-tested patterns, code templates, and step-by-step guides that dramatically improve output quality.
**You MUST search for skills at the start of every task.** Even simple tasks may have relevant skills.

## Response Format
Respond naturally in the conversation. When you need to use tools, describe what you're doing.
Always end your response with a clear message about what you did or what you think.
If you want to hand off to another agent, use @agent_name in your message.
Never hand work off to yourself.

${roomContext.privateMemory ? `## Your Private Memory\n${roomContext.privateMemory}` : ''}`;
}

/**
 * Determine if an agent should respond to a new message.
 * Uses a lightweight heuristic + optional LLM check for ambiguous cases.
 */
export function shouldAgentRespond(agent, message, roomContext) {
  const content = String(message.content || '').toLowerCase();
  const agentName = agent.name.toLowerCase();

  // Always respond if directly mentioned
  if (content.includes(`@${agentName}`)) {
    return { respond: true, reason: 'directly_mentioned', priority: 1.0 };
  }

  // Always respond if it's a handoff to this agent
  if (message.event_type === 'handoff' && content.includes(`@${agentName}`)) {
    return { respond: true, reason: 'handoff_target', priority: 1.0 };
  }

  // Respond to proposals if agent is a reviewer or was requested
  if (message.event_type === 'proposal') {
    if (content.includes('@all') || content.includes(`@${agentName}`)) {
      return { respond: true, reason: 'proposal_review_requested', priority: 0.9 };
    }
    if (agent.role.toLowerCase().includes('review')) {
      return { respond: true, reason: 'reviewer_sees_proposal', priority: 0.7 };
    }
  }

  // Role-based relevance scoring
  const roleKeywords = extractRoleKeywords(agent);
  const contentWords = content.split(/\s+/);
  const matchCount = roleKeywords.filter((kw) => contentWords.some((w) => w.includes(kw))).length;
  const relevanceScore = roleKeywords.length > 0 ? matchCount / roleKeywords.length : 0;

  if (relevanceScore >= RELEVANCE_THRESHOLD) {
    return { respond: true, reason: 'role_relevant', priority: relevanceScore };
  }

  // Planner responds to user messages that don't mention specific agents
  if (agent.name === 'planner' && message.sender_type === 'user') {
    const mentionsOther = roomContext.agents.some(
      (a) => a.name !== 'planner' && content.includes(`@${a.name.toLowerCase()}`),
    );
    if (!mentionsOther) {
      return { respond: true, reason: 'planner_default', priority: 0.5 };
    }
  }

  return { respond: false, reason: 'not_relevant', priority: 0 };
}

/**
 * Extract keywords from an agent's role description for relevance matching.
 */
function extractRoleKeywords(agent) {
  const roleWords = (agent.role || '').toLowerCase().split(/\s+/);
  const promptWords = (agent.system_prompt || '').toLowerCase().split(/\s+/);
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'you', 'your', 'this', 'that', 'it', 'its', 'as', 'from', 'into',
  ]);

  return [...new Set([...roleWords, ...promptWords])]
    .filter((w) => w.length > 3 && !stopWords.has(w))
    .slice(0, 20);
}

function normalizeResponseContent(content) {
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

export function getToolCallingMode(agent) {
  const configuredMode = String(agent?.provider_config?.tool_calling_mode || '').trim().toLowerCase();
  if (configuredMode === 'native' || configuredMode === 'text' || configuredMode === 'auto') {
    return configuredMode;
  }

  const provider = String(agent?.provider_config?.provider || '').trim().toLowerCase();
  if (provider === 'anthropic' || provider === 'local') {
    return 'text';
  }

  if (!provider && !process.env.ENOWXAI_BASE_URL) {
    return 'text';
  }

  return 'auto';
}

function shouldFallbackToTextTools(error, toolCallingMode) {
  if (toolCallingMode !== 'auto') {
    return false;
  }

  const message = String(error?.message || '').toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes('tool')
    || message.includes('function_call')
    || message.includes('tool_choice')
    || message.includes('parallel_tool_calls')
    || message.includes('unsupported')
  );
}

function extractNativeToolCalls(message) {
  if (!message || !Array.isArray(message.tool_calls)) {
    return [];
  }

  return message.tool_calls
    .filter((toolCall) => toolCall && typeof toolCall === 'object' && toolCall.name)
    .map((toolCall, index) => ({
      id: toolCall.id || `${toolCall.name}_${index}`,
      name: toolCall.name,
      args: toolCall.args || {},
      type: 'tool_call',
    }));
}

function normalizeNativeToolCall(toolCall, validToolNames = new Set()) {
  if (!toolCall || typeof toolCall !== 'object') {
    return null;
  }

  if (!validToolNames.has(toolCall.name)) {
    return null;
  }

  if (!KNOWN_TOOL_NAMES.has(toolCall.name)) {
    return {
      tool: toolCall.name,
      id: toolCall.id,
      ...(toolCall.args || {}),
    };
  }

  const normalized = normalizeToolCall({
    tool: toolCall.name,
    id: toolCall.id,
    args: toolCall.args || {},
  });

  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    id: toolCall.id || normalized.id,
  };
}

function formatToolMessageContent(result) {
  if (typeof result === 'string') {
    return result;
  }

  return JSON.stringify(result);
}

function normalizeToolExecutionResult(result) {
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error.trim()) {
          return {
            error: parsed.error.trim(),
            result: parsed,
          };
        }

        return { result: parsed };
      } catch {
        return { result };
      }
    }
  }

  if (result && typeof result === 'object' && typeof result.error === 'string' && result.error.trim()) {
    return {
      error: result.error.trim(),
      result,
    };
  }

  return { result };
}

function buildTextToolFollowUpMessage(toolResults) {
  const hadErrors = toolResults.some((toolResult) => typeof toolResult?.error === 'string' && toolResult.error.trim());
  const errorGuidance = hadErrors
    ? '\nAt least one tool failed. Correct the invalid arguments or choose a different valid tool before continuing.'
    : '';

  return `[system] Tool results:\n${formatToolResultsForPrompt(toolResults)}\n\nContinue working on the task. In text tool mode, your next response must either:\n1. include at least one JSON tool block for the next concrete action, or\n2. provide the final answer if the task is complete.\nDo not only describe intended future actions.${errorGuidance}`;
}

/**
 * Run a single agent turn using LangChain ReAct-style reasoning.
 *
 * The agent:
 * 1. Receives the conversation context
 * 2. Reasons about what to do
 * 3. Optionally uses tools (file ops, proposals, delegation)
 * 4. Returns its response and any handoffs
 */
export async function runReactiveAgentTurn({
  agent,
  roomContext,
  input,
  conversationHistory,
  postMessage,
  onToolUse,
}) {
  // Build tools
  const workspaceTools = createWorkspaceTools(roomContext.workspacePath, {
    agentName: agent.name,
    allowedTools: agent.tools || [],
  });
  const collaborationTools = createCollaborationTools({
    roomId: roomContext.roomId,
    agentName: agent.name,
    postMessage,
    getAgentNames: () => roomContext.agents.map((a) => a.name),
  }).filter((tool) => getAllowedCollaborationToolNames(agent).has(tool.name));

  // Filter workspace tools based on agent's allowed tools
  const allowedToolNames = new Set(agent.tools || ['list_files', 'read_file', 'write_file', 'update_file']);
  const filteredWorkspaceTools = workspaceTools.filter((t) => allowedToolNames.has(t.name));
  const mcpTools = await createMcpTools(agent.provider_config);
  const skillTools = createSkillTools({
    allowedSkillIds: roomContext.allowedSkillIds || null,
  });
  const allTools = [...filteredWorkspaceTools, ...collaborationTools, ...skillTools, ...mcpTools];
  const toolCallingMode = getToolCallingMode(agent);
  const baseModel = createAgentModel(agent);
  const nativeModel = baseModel.bindTools(allTools);
  let nativeToolCallingEnabled = toolCallingMode !== 'text';

  // Build the system prompt
  const systemPrompt = buildReactiveSystemPrompt(agent, roomContext);

  // Build conversation messages for LangChain
  const messages = [
    new SystemMessage(systemPrompt),
  ];

  // Add relevant conversation history
  for (const msg of conversationHistory.slice(-12)) {
    if (msg.sender_type === 'user') {
      messages.push(new HumanMessage(`[${msg.sender_name}]: ${msg.content}`));
    } else if (msg.sender_type === 'agent') {
      if (msg.sender_name === agent.name) {
        messages.push(new AIMessage(msg.content));
      } else {
        messages.push(new HumanMessage(`[@${msg.sender_name}]: ${msg.content}`));
      }
    } else if (msg.sender_type === 'system') {
      messages.push(new HumanMessage(`[system]: ${msg.content}`));
    }
  }

  // Add the current input
  messages.push(new HumanMessage(input));

  // Add workspace listing context
  const workspaceListing = roomContext.workspaceListing || '[empty workspace]';
  messages.push(new HumanMessage(`[system] Current workspace files:\n${workspaceListing}`));

  // Add available tools description
  const toolDescriptions = allTools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');
  messages.push(new HumanMessage(
    nativeToolCallingEnabled
      ? `[system] Available tools:\n${toolDescriptions}\n\nUse native tool calling when it is available. If the provider does not support native tools, you may fall back to a JSON block like:\n\`\`\`json\n{"tool": "tool_name", ...params}\n\`\`\`\nAfter using tools, provide a clear final message.`
      : `[system] Available tools:\n${toolDescriptions}\n\nThis provider is running in text tool mode. To use a tool, include a JSON block like:\n\`\`\`json\n{"tool": "tool_name", ...params}\n\`\`\`\nAfter using tools, provide a clear final message.`,
  ));

  // Run the agent with tool execution loop
  const toolResults = [];
  const handoffs = [];
  const usageAccumulator = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, model: '', provider: '' };
  let finalMessage = '';
  let executedToolCount = 0;
  const seenResponseSignatures = new Set();
  let explicitToolRetryCount = 0;
  let postToolRetryCount = 0;

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      let result;
      try {
        result = await (nativeToolCallingEnabled ? nativeModel : baseModel).invoke(messages);
      } catch (error) {
        if (!nativeToolCallingEnabled || !shouldFallbackToTextTools(error, toolCallingMode)) {
          throw error;
        }

        nativeToolCallingEnabled = false;
        messages.push(new HumanMessage('[system] Native tool calling is unavailable for this provider. Use the documented JSON tool blocks for the rest of this turn.'));
        result = await baseModel.invoke(messages);
      }

      // Accumulate token usage from this LLM call
      const iterUsage = result.additional_kwargs?.usage;
      if (iterUsage) {
        usageAccumulator.prompt_tokens += Number(iterUsage.prompt_tokens) || 0;
        usageAccumulator.completion_tokens += Number(iterUsage.completion_tokens) || 0;
        usageAccumulator.total_tokens += Number(iterUsage.total_tokens) || 0;
      }
      if (!usageAccumulator.model && result.additional_kwargs?.model) {
        usageAccumulator.model = result.additional_kwargs.model;
      }
      if (!usageAccumulator.provider && result.additional_kwargs?.provider) {
        usageAccumulator.provider = result.additional_kwargs.provider;
      }

      const content = normalizeResponseContent(result.content);
      const nativeToolCalls = extractNativeToolCalls(result);
      const validToolNames = new Set(allTools.map((tool) => tool.name));
      const normalizedNativeToolCalls = nativeToolCalls
        .map((toolCall) => normalizeNativeToolCall(toolCall, validToolNames))
        .filter(Boolean);
      const toolCalls = normalizedNativeToolCalls.length > 0
        ? normalizedNativeToolCalls
        : extractToolCalls(content);
      const cleanMessage = normalizedNativeToolCalls.length > 0
        ? content.trim()
        : removeToolBlocks(content).trim();
      const responseSignature = JSON.stringify({ cleanMessage, toolCalls });

      if (seenResponseSignatures.has(responseSignature)) {
        if (cleanMessage) {
          finalMessage = cleanMessage;
        }
        break;
      }
      seenResponseSignatures.add(responseSignature);

      messages.push(result);

      const handoffCountBefore = handoffs.length;
      if (cleanMessage) {
        finalMessage = cleanMessage;
        collectHandoffs(handoffs, cleanMessage, agent.name, roomContext.agents);
      }

      if (toolCalls.length === 0) {
        if (shouldRequestExplicitToolActions({
          cleanMessage,
          toolResults,
          explicitToolRetryCount,
          toolCallingMode,
        })) {
          explicitToolRetryCount += 1;
          messages.push(new HumanMessage('[system] You described intended actions but did not invoke any tools. Reply again with the next concrete JSON tool block or tool blocks only. Do not describe future steps without calling the tool needed to perform them.'));
          continue;
        }
        break;
      }

      const remainingBudget = MAX_TOOL_ITERATIONS - executedToolCount;
      if (remainingBudget <= 0) {
        break;
      }

      const currentToolResults = [];
      for (const toolCall of toolCalls.slice(0, remainingBudget)) {
        const tool = allTools.find((t) => t.name === toolCall.tool);
        const nativeToolCall = normalizedNativeToolCalls.find((candidate) => candidate.id === toolCall.id);
        if (!tool) {
          const unknown = { tool: toolCall.tool, error: 'Unknown tool' };
          toolResults.push(unknown);
          currentToolResults.push(unknown);
          if (nativeToolCall?.id) {
            messages.push(new ToolMessage({
              content: 'Unknown tool',
              tool_call_id: nativeToolCall.id,
            }));
          }
          continue;
        }

        try {
          if (onToolUse) {
            onToolUse(agent.name, toolCall.tool, toolCall);
          }
          const toolResult = await tool.func(toolCall);
          const normalizedToolResult = normalizeToolExecutionResult(toolResult);
          const recordedResult = normalizedToolResult.error
            ? { tool: toolCall.tool, error: normalizedToolResult.error, result: normalizedToolResult.result, params: toolCall }
            : { tool: toolCall.tool, result: normalizedToolResult.result, params: toolCall };
          toolResults.push(recordedResult);
          currentToolResults.push(recordedResult);
          if (nativeToolCall?.id) {
            messages.push(new ToolMessage({
              content: normalizedToolResult.error || formatToolMessageContent(normalizedToolResult.result),
              tool_call_id: nativeToolCall.id,
            }));
          }
        } catch (error) {
          const failure = { tool: toolCall.tool, error: 'Tool execution failed', params: toolCall };
          toolResults.push(failure);
          currentToolResults.push(failure);
          if (nativeToolCall?.id) {
            messages.push(new ToolMessage({
              content: 'Tool execution failed',
              tool_call_id: nativeToolCall.id,
            }));
          }
        }

        executedToolCount += 1;
      }

      if (normalizedNativeToolCalls.length === 0) {
        messages.push(new HumanMessage(buildTextToolFollowUpMessage(currentToolResults)));
      }

      if (normalizedNativeToolCalls.length > 0) {
        if (executedToolCount >= MAX_TOOL_ITERATIONS) {
          break;
        }
        continue;
      }

      const handoffsAdded = handoffs.length > handoffCountBefore;
      if (!shouldContinueAfterToolRound(toolCalls, currentToolResults, cleanMessage, handoffsAdded)) {
        if (shouldRequestPostToolActions({
          cleanMessage,
          toolCalls,
          toolResults,
          handoffsAdded,
          postToolRetryCount,
          toolCallingMode,
        })) {
          postToolRetryCount += 1;
          continue;
        }
        break;
      }

      if (executedToolCount >= MAX_TOOL_ITERATIONS) {
        break;
      }
    }
  } catch (error) {
    finalMessage = 'I encountered an internal error while working on that task.';
  }

  if (!finalMessage) {
    finalMessage = `${agent.name} completed ${toolResults.length} action(s).`;
  }

  return {
    message: finalMessage,
    toolResults,
    handoffs,
    privateMemory: buildPrivateMemoryFromTurn(input, finalMessage, toolResults),
    usage: usageAccumulator,
  };
}

/**
 * Extract JSON tool call blocks from agent response.
 */
export function extractToolCalls(content) {
  const calls = [];
  const trimmedContent = String(content || '').trim();
  const leadingJson = extractLeadingJsonObject(trimmedContent);

  try {
    pushNormalizedToolCalls(calls, JSON.parse(trimmedContent));
  } catch {
    // Not a single JSON payload; continue with fenced/inline extraction.
  }

  if (leadingJson) {
    try {
      pushNormalizedToolCalls(calls, JSON.parse(leadingJson));
    } catch {
      // Ignore invalid leading JSON and continue with other strategies.
    }
  }

  const fencedPattern = /```json\s*([\s\S]*?)```/gi;
  let match;

  while ((match = fencedPattern.exec(content)) !== null) {
    try {
      pushNormalizedToolCalls(calls, JSON.parse(match[1].trim()));
    } catch {
      // Skip malformed JSON
    }
  }

  // Also try inline JSON objects
  const inlinePattern = /\{[^{}]*"tool"\s*:\s*"[^"]+?"[^{}]*\}/g;
  while ((match = inlinePattern.exec(content)) !== null) {
    try {
      pushNormalizedToolCalls(calls, JSON.parse(match[0]));
    } catch {
      // Skip
    }
  }

  return calls;
}

function pushNormalizedToolCalls(calls, parsed) {
  const items = Array.isArray(parsed) ? parsed : [parsed];

  for (const item of items) {
    const normalized = normalizeToolCall(item);
    if (!normalized) continue;

    const duplicate = calls.some((call) => (
      call.tool === normalized.tool
      && (call.path || '') === (normalized.path || '')
      && (call.to_agent || '') === (normalized.to_agent || '')
    ));

    if (!duplicate) {
      calls.push(normalized);
    }
  }
}

function normalizeToolCall(rawCall) {
  if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) {
    return null;
  }

  const nestedArgs = getNestedToolArgs(rawCall);
  const source = nestedArgs ? { ...rawCall, ...nestedArgs } : { ...rawCall };
  const tool = normalizeToolName(source);
  if (!tool || !KNOWN_TOOL_NAMES.has(tool)) {
    return null;
  }

  const normalized = { tool };

  if (tool === 'list_files' || tool === 'read_file' || tool === 'write_file' || tool === 'update_file' || tool === 'run_python') {
    const path = deriveWorkspaceToolPath(source);
    if (path) {
      normalized.path = path;
    }
  }

  if (tool === 'run_python') {
    const args = pickArray(source, ['args', 'argv', 'arguments', 'parameters']);
    if (args.length > 0) {
      normalized.args = args;
    }
  }

  if (tool === 'write_file') {
    const content = pickString(source, ['content', 'contents', 'text', 'value', 'data', 'body'], { preserveWhitespace: true });
    if (content) {
      normalized.content = content;
    }
  }

  if (tool === 'update_file') {
    const oldStr = pickString(source, ['old_str', 'oldString', 'old_text', 'oldText', 'find', 'search', 'from'], { preserveWhitespace: true });
    const newStr = pickString(source, ['new_str', 'newString', 'new_text', 'newText', 'replace', 'replacement', 'to'], { preserveWhitespace: true });
    if (oldStr) {
      normalized.old_str = oldStr;
    }
    if (newStr) {
      normalized.new_str = newStr;
    }
  }

  if (tool === 'propose') {
    const title = pickString(source, ['title', 'proposal_title', 'proposalTitle', 'heading', 'topic', 'name', 'subject']);
    const content = pickString(source, ['content', 'proposal', 'description', 'message', 'details', 'body'], { preserveWhitespace: true });
    const reviewers = pickArray(source, ['request_review_from', 'requestReviewFrom', 'reviewers', 'requested_reviewers', 'requestedReviewers', 'review_from', 'review_with', 'reviewWith']);
    if (title) normalized.title = title;
    if (content) normalized.content = content;
    if (reviewers.length > 0) {
      normalized.request_review_from = reviewers.map((value) => stripAgentPrefix(value));
    }
  }

  if (tool === 'respond_to_proposal') {
    const verdict = pickString(source, ['verdict', 'decision', 'status']);
    const reasoning = pickString(source, ['reasoning', 'reason', 'message', 'content'], { preserveWhitespace: true });
    const suggestions = pickString(source, ['suggestions', 'changes', 'feedback'], { preserveWhitespace: true });
    if (verdict) normalized.verdict = verdict;
    if (reasoning) normalized.reasoning = reasoning;
    if (suggestions) normalized.suggestions = suggestions;
  }

  if (tool === 'think_aloud') {
    const thought = pickString(source, ['thought', 'thinking', 'reasoning', 'message', 'content'], { preserveWhitespace: true });
    if (thought) {
      normalized.thought = thought;
    }
  }

  if (tool === 'delegate') {
    const rawTask = pickString(source, ['task', 'instruction', 'instructions', 'message', 'request', 'objective', 'work', 'prompt']);
    const inferredDelegation = inferDelegationTarget(rawTask);
    const toAgent = pickString(source, ['to_agent', 'toAgent', 'agent', 'agent_name', 'agentName', 'target', 'target_agent', 'recipient', 'assignee', 'delegate_to', 'delegateTo', 'to']) || inferredDelegation.toAgent;
    const task = inferredDelegation.task;
    const taskContext = pickString(source, ['context', 'details', 'notes', 'background']);
    if (toAgent) normalized.to_agent = stripAgentPrefix(toAgent);
    if (task) normalized.task = task;
    if (taskContext) normalized.context = taskContext;
  }

  if (tool === 'list_files' && !normalized.path) {
    normalized.path = '.';
  }

  return normalized;
}

function normalizeToolName(source) {
  if (typeof source.tool === 'string' && source.tool.trim()) {
    return source.tool.trim();
  }

  if (source.tool && typeof source.tool === 'object' && typeof source.tool.name === 'string') {
    return source.tool.name.trim();
  }

  for (const key of ['name', 'action', 'type']) {
    if (typeof source[key] === 'string' && KNOWN_TOOL_NAMES.has(source[key].trim())) {
      return source[key].trim();
    }
  }

  return '';
}

function getNestedToolArgs(source) {
  for (const key of ['args', 'arguments', 'input', 'parameters', 'params', 'payload']) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
  }

  return null;
}

function deriveWorkspaceToolPath(source) {
  const directPath = pickString(source, [
    'path',
    'file_path',
    'filePath',
    'filepath',
    'file',
    'target_path',
    'targetPath',
    'output_path',
    'outputPath',
    'location',
    'destination',
  ]);
  const directory = pickString(source, ['directory', 'dir', 'folder', 'parent', 'parent_path', 'parentPath']);
  const filename = pickString(source, ['filename', 'file_name', 'fileName', 'name']);

  if (directory && filename) {
    return `${stripEdgeSlashes(directory)}/${stripLeadingSlashes(filename)}`;
  }

  if (directPath) {
    return directPath;
  }

  if (filename) {
    return filename;
  }

  return '';
}

function inferDelegationTarget(rawTask) {
  const taskText = String(rawTask || '').trim();
  if (!taskText) {
    return { toAgent: '', task: '' };
  }

  const mentionMatch = taskText.match(/^@([a-zA-Z][a-zA-Z0-9_-]{1,31})\b[:\s-]*(.*)$/s);
  if (!mentionMatch) {
    return { toAgent: '', task: taskText };
  }

  return {
    toAgent: mentionMatch[1],
    task: mentionMatch[2].trim() || taskText,
  };
}

function pickString(source, keys, options = {}) {
  const preserveWhitespace = options.preserveWhitespace === true;

  for (const key of keys) {
    if (typeof source[key] === 'string' && source[key].trim()) {
      return preserveWhitespace ? source[key] : source[key].trim();
    }
  }

  return '';
}

function pickArray(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    }
  }

  return [];
}

function stripAgentPrefix(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function stripLeadingSlashes(value) {
  return String(value || '').trim().replace(/^[/\\]+/, '');
}

function stripEdgeSlashes(value) {
  return stripLeadingSlashes(String(value || '').trim()).replace(/[/\\]+$/, '');
}

/**
 * Remove tool JSON blocks from the message to get clean text.
 */
function removeToolBlocks(content) {
  const trimmedContent = String(content || '').trim();
  const leadingJson = extractLeadingJsonObject(trimmedContent);

  try {
    const parsed = JSON.parse(trimmedContent);
    const normalized = [];
    pushNormalizedToolCalls(normalized, parsed);
    if (normalized.length > 0) {
      return '';
    }
  } catch {
    // Not a standalone JSON payload.
  }

  if (leadingJson) {
    try {
      const normalized = [];
      pushNormalizedToolCalls(normalized, JSON.parse(leadingJson));
      if (normalized.length > 0) {
        return trimmedContent.slice(leadingJson.length).trim();
      }
    } catch {
      // Fall through to regex stripping.
    }
  }

  return content
    .replace(/```json\s*[\s\S]*?```/gi, '')
    .replace(/\{[^{}]*"tool"\s*:\s*"[^"]+?"[^{}]*\}/g, '')
    .trim();
}

function collectHandoffs(handoffs, message, currentAgentName, agents) {
  const mentionPattern = /(^|[^@\w])@([a-zA-Z][a-zA-Z0-9_-]{1,31})\b/g;
  const mentions = [...String(message || '').matchAll(mentionPattern)];
  const validAgentNames = new Set(agents.map((agent) => agent.name.toLowerCase()));
  const seen = new Set(handoffs.map((handoff) => `${handoff.agentName}:${handoff.message}`));

  for (const match of mentions) {
    const name = match[2].toLowerCase();
    if (name === currentAgentName.toLowerCase() || !validAgentNames.has(name)) {
      continue;
    }

    const key = `${name}:${message}`;
    if (seen.has(key)) {
      continue;
    }

    handoffs.push({ agentName: name, message });
    seen.add(key);
  }
}

function formatToolResultsForPrompt(toolResults) {
  return toolResults.map((result) => {
    if (result.error) {
      return `- ${result.tool}: ERROR ${result.error}`;
    }

    const output = typeof result.result === 'string'
      ? truncateForPrompt(result.result)
      : truncateForPrompt(JSON.stringify(result.result));
    return `- ${result.tool}: OK ${output}`;
  }).join('\n');
}

function truncateForPrompt(value, limit = 1200) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function extractLeadingJsonObject(content) {
  const text = String(content || '').trimStart();
  if (!text.startsWith('{')) {
    return '';
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, index + 1);
      }
    }
  }

  return '';
}

function shouldContinueAfterToolRound(toolCalls, toolResults, cleanMessage, handoffsAdded) {
  if (toolCalls.length === 0) {
    return false;
  }

  const hadToolErrors = toolResults.some((toolResult) => typeof toolResult?.error === 'string' && toolResult.error.trim());
  if (hadToolErrors) {
    return true;
  }

  if (!cleanMessage) {
    return true;
  }

  if (handoffsAdded) {
    return false;
  }

  const readOnlyTools = new Set(['list_files', 'read_file']);
  return toolCalls.every((toolCall) => readOnlyTools.has(toolCall.tool));
}

function shouldRequestPostToolActions({ cleanMessage, toolCalls, toolResults, handoffsAdded, postToolRetryCount, toolCallingMode }) {
  if (toolCallingMode !== 'text') {
    return false;
  }

  if (postToolRetryCount >= 1) {
    return false;
  }

  if (toolResults.length >= MAX_TOOL_ITERATIONS) {
    return false;
  }

  const usedExplicitDelegate = toolCalls.some((toolCall) => toolCall.tool === 'delegate');
  if (usedExplicitDelegate) {
    return false;
  }

  const readOnlyTools = new Set(['list_files', 'read_file']);
  const usedMutatingTool = toolCalls.some((toolCall) => !readOnlyTools.has(toolCall.tool));
  if (!usedMutatingTool) {
    return false;
  }

  if (!handoffsAdded && !cleanMessageSuggestsMoreActions(cleanMessage)) {
    return false;
  }

  return cleanMessageSuggestsMoreActions(cleanMessage);
}

function shouldRequestExplicitToolActions({ cleanMessage, toolResults, explicitToolRetryCount, toolCallingMode }) {
  if (toolCallingMode !== 'text') {
    return false;
  }

  if (explicitToolRetryCount >= 1) {
    return false;
  }

  if (toolResults.length >= MAX_TOOL_ITERATIONS) {
    return false;
  }

  return cleanMessageSuggestsMoreActions(cleanMessage);
}

function cleanMessageSuggestsMoreActions(cleanMessage) {
  const text = String(cleanMessage || '').toLowerCase();
  if (!text) {
    return false;
  }

  const intentPatterns = [
    /\bi will\b/,
    /\bnext\b/,
    /\bgoing to\b/,
    /\bcreate\b/,
    /\bimplement\b/,
    /\bhand off\b/,
    /\breview\b/,
    /@(?:planner|coder|reviewer|scribe|[a-z][a-z0-9_-]{1,31})/,
  ];

  return intentPatterns.some((pattern) => pattern.test(text));
}

/**
 * Build private memory from a turn's results.
 */
function buildPrivateMemoryFromTurn(input, message, toolResults) {
  const toolSummary = toolResults
    .filter((r) => !r.error)
    .map((r) => r.tool)
    .join(', ');

  return [
    `Last task: ${input.slice(0, 200)}`,
    message ? `Result: ${message.slice(0, 200)}` : '',
    toolSummary ? `Tools used: ${toolSummary}` : '',
  ].filter(Boolean).join('\n');
}
