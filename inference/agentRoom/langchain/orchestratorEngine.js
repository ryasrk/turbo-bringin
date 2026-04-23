import { EventEmitter } from 'events';

import {
  getAgentRoom,
  getAgentRoomAgent,
  getAgentRoomMemory,
  listAgentRoomAgents,
  listAgentRoomMessages,
  listRoomSkills,
  saveAgentRoomLog,
  saveAgentRoomMemory,
  saveAgentRoomMessage,
  saveAgentRoomTokenUsage,
  touchAgentRoom,
  updateAgentRoomAgentStatus,
} from '../../db/database.js';
import { listFiles } from '../fileTools.js';
import { broadcastAgentRoomEvent } from '../wsBridge.js';
import { runReactiveAgentTurn, shouldAgentRespond } from './reactiveAgent.js';

const DEFAULT_AUTONOMY_LEVEL = 2;
const MAX_VISIBLE_HISTORY = 40;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function buildToolLogMeta(toolResult) {
  const meta = {
    tool: toolResult.tool,
  };

  if (toolResult.params?.path) {
    meta.path = toolResult.params.path;
  }
  if (toolResult.tool === 'list_files') {
    meta.path = toolResult.params?.path || '.';
  }
  if (typeof toolResult.result === 'string') {
    meta.result_bytes = Buffer.byteLength(toolResult.result);
  }
  if (Array.isArray(toolResult.result)) {
    meta.result_count = toolResult.result.length;
  }
  if (typeof toolResult.params?.content === 'string') {
    meta.input_bytes = Buffer.byteLength(toolResult.params.content);
  }
  if (typeof toolResult.params?.new_str === 'string') {
    meta.input_bytes = Buffer.byteLength(toolResult.params.new_str);
  }

  // Skill tool metadata
  if (toolResult.tool === 'search_skills') {
    meta.query = toolResult.params?.query || '';
    try {
      const parsed = typeof toolResult.result === 'string' ? JSON.parse(toolResult.result) : toolResult.result;
      meta.result_count = parsed?.results?.length || 0;
      meta.total = parsed?.total || 0;
      meta.top_skills = (parsed?.results || []).slice(0, 3).map((r) => r.id);
    } catch { /* ignore */ }
  }
  if (toolResult.tool === 'read_skill') {
    meta.skill_id = toolResult.params?.skill_id || '';
    meta.file_path = toolResult.params?.file_path || 'SKILL.md';
    try {
      const parsed = typeof toolResult.result === 'string' ? JSON.parse(toolResult.result) : toolResult.result;
      meta.skill_name = parsed?.name || meta.skill_id;
      meta.truncated = parsed?.truncated || false;
    } catch { /* ignore */ }
  }
  if (toolResult.tool === 'list_skill_files') {
    meta.skill_id = toolResult.params?.skill_id || '';
    meta.skill_path = toolResult.params?.path || '.';
    try {
      const parsed = typeof toolResult.result === 'string' ? JSON.parse(toolResult.result) : toolResult.result;
      meta.result_count = parsed?.entries?.length || 0;
    } catch { /* ignore */ }
  }

  return meta;
}

const SKILL_TOOL_NAMES = new Set(['search_skills', 'read_skill', 'list_skill_files']);

export function getRoomOrchestrationConfig(room) {
  const mode = room?.orchestration_mode === 'legacy' ? 'legacy' : 'reactive';
  const autonomyLevel = clamp(Number(room?.autonomy_level ?? DEFAULT_AUTONOMY_LEVEL), 0, 3);

  return {
    mode,
    autonomyLevel,
    maxCycles: mode === 'legacy' ? 4 : 6 + (autonomyLevel * 3),
    maxAgentsPerCycle: mode === 'legacy' ? 1 : clamp(autonomyLevel + 1, 1, 4),
    maxTurnsPerAgent: mode === 'legacy' ? 1 : clamp(autonomyLevel, 1, 3),
  };
}

function getMentionedAgentNames(agents, content) {
  const validNames = new Set(agents.map((agent) => agent.name.toLowerCase()));
  const matches = [...String(content || '').toLowerCase().matchAll(/@([a-z][a-z0-9_-]{1,31})/g)];
  const seen = new Set();
  const mentioned = [];

  for (const match of matches) {
    const name = match[1];
    if (!validNames.has(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    mentioned.push(name);
  }

  return mentioned;
}

export function getMissingHandoffMessages({ senderName, postedMessages, handoffs, agents }) {
  const existingHandoffTargets = new Set(
    postedMessages
      .filter((message) => message.event_type === 'handoff')
      .flatMap((message) => getMentionedAgentNames(agents, message.content)),
  );
  const existingHandoffContents = new Set(
    postedMessages
      .filter((message) => message.event_type === 'handoff')
      .map((message) => String(message.content || '').trim())
      .filter(Boolean),
  );

  const missingMessages = [];
  const queuedContents = new Set();

  for (const handoff of handoffs || []) {
    const agentName = String(handoff?.agentName || '').toLowerCase();
    const content = String(handoff?.message || '').trim();
    if (!agentName || !content) {
      continue;
    }

    if (existingHandoffTargets.has(agentName) || existingHandoffContents.has(content) || queuedContents.has(content)) {
      continue;
    }

    missingMessages.push({
      sender_type: 'agent',
      sender_name: senderName,
      content: `@${agentName} Continue the delegated room task from @${senderName}. Use the latest user request, room context, and workspace files relevant to your role.`,
      event_type: 'handoff',
      created_at: nowUnix(),
    });
    queuedContents.add(content);
  }

  return missingMessages;
}

function allowsReactiveFollowUp(triggerMessage) {
  if (triggerMessage.sender_type === 'user') {
    return true;
  }

  return ['handoff', 'proposal_response'].includes(triggerMessage.event_type);
}

export function selectReactingAgents({ agents, triggerMessage, roomConfig, responseCounts = new Map() }) {
  const mentionedAgentNames = getMentionedAgentNames(agents, triggerMessage.content);
  const targetAgentNames = triggerMessage.event_type === 'handoff'
    ? mentionedAgentNames.slice(0, 1)
    : mentionedAgentNames;
  const triggerSender = String(triggerMessage.sender_name || '').toLowerCase();

  if (!allowsReactiveFollowUp(triggerMessage)) {
    return [];
  }

  let candidates = agents
    .filter((agent) => agent.name.toLowerCase() !== triggerSender)
    .map((agent) => ({
      agent,
      decision: shouldAgentRespond(agent, triggerMessage, { agents }),
    }))
    .filter(({ agent, decision }) => {
      if (!decision.respond) return false;
      return (responseCounts.get(agent.name.toLowerCase()) || 0) < roomConfig.maxTurnsPerAgent;
    });

  if (roomConfig.mode === 'legacy') {
    if (targetAgentNames.length > 0) {
      candidates = candidates.filter(({ agent }) => targetAgentNames.includes(agent.name.toLowerCase()));
    } else if (triggerMessage.sender_type === 'user') {
      candidates = candidates.filter(({ agent }) => agent.name.toLowerCase() === 'planner');
    } else {
      candidates = [];
    }
  } else if (targetAgentNames.length > 0) {
    candidates = candidates.filter(({ agent }) => targetAgentNames.includes(agent.name.toLowerCase()));
  }

  if (triggerMessage.sender_type === 'user' && candidates.length === 0) {
    const planner = agents.find((agent) => agent.name.toLowerCase() === 'planner');
    if (planner && (responseCounts.get('planner') || 0) < roomConfig.maxTurnsPerAgent) {
      candidates = [{
        agent: planner,
        decision: { respond: true, reason: 'planner_fallback', priority: 0.5 },
      }];
    }
  }

  return candidates
    .sort((left, right) => right.decision.priority - left.decision.priority)
    .slice(0, roomConfig.maxAgentsPerCycle);
}

function buildAgentInput(triggerMessage) {
  const senderLabel = triggerMessage.sender_type === 'user'
    ? `user ${triggerMessage.sender_name}`
    : `@${triggerMessage.sender_name}`;
  const eventLabel = triggerMessage.event_type && triggerMessage.event_type !== 'message'
    ? ` (${triggerMessage.event_type})`
    : '';

  return [
    `New room message from ${senderLabel}${eventLabel}:`,
    triggerMessage.content,
    '',
    'Respond only if your role should contribute. If you delegate, mention the target agent explicitly.',
  ].join('\n');
}

export class LangChainAgentRoomOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.roomQueues = new Map();
  }

  enqueueRoomTask(roomId, task) {
    const previous = this.roomQueues.get(roomId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.roomQueues.get(roomId) === next) {
          this.roomQueues.delete(roomId);
        }
      });
    this.roomQueues.set(roomId, next);
    return next;
  }

  emitRoomEvent(roomId, type, payload = {}) {
    this.emit(type, { roomId, ...payload });
    broadcastAgentRoomEvent(roomId, type, payload);
  }

  postAgentMessage(roomId, senderName, content, eventType = 'message', { artifacts = [] } = {}) {
    const text = String(content || '').trim();
    if (!text) return null;

    const message = {
      sender_type: 'agent',
      sender_name: senderName,
      content: text,
      event_type: eventType,
      created_at: nowUnix(),
      artifacts: artifacts.length > 0 ? artifacts : undefined,
    };

    saveAgentRoomMessage(roomId, 'agent', senderName, text, eventType, artifacts.length > 0 ? artifacts : null);
    this.emitRoomEvent(roomId, 'agent_room:message', { message });
    return message;
  }

  async handleUserMessage(roomId, user, content) {
    const room = getAgentRoom(roomId);
    if (!room) {
      throw new Error('Agent room not found');
    }

    const triggerMessage = {
      sender_type: 'user',
      sender_name: user.username,
      content,
      event_type: 'message',
      created_at: nowUnix(),
    };

    saveAgentRoomMessage(roomId, 'user', user.username, content, 'message');
    this.emitRoomEvent(roomId, 'agent_room:message', { message: triggerMessage });

    return this.enqueueRoomTask(roomId, async () => {
      await this.processTriggerQueue(roomId, triggerMessage);
      touchAgentRoom(roomId);
    });
  }

  async processTriggerQueue(roomId, initialTrigger) {
    const room = getAgentRoom(roomId);
    if (!room) {
      throw new Error('Agent room not found');
    }

    const roomConfig = getRoomOrchestrationConfig(room);
    const triggerQueue = [initialTrigger];
    const responseCounts = new Map();
    let cycles = 0;

    while (triggerQueue.length > 0 && cycles < roomConfig.maxCycles) {
      const triggerMessage = triggerQueue.shift();
      const agents = listAgentRoomAgents(roomId, { includeSecrets: true });
      const candidates = selectReactingAgents({
        agents,
        triggerMessage,
        roomConfig,
        responseCounts,
      });

      if (candidates.length === 0) {
        cycles += 1;
        continue;
      }

      const input = buildAgentInput(triggerMessage);
      const results = await Promise.allSettled(
        candidates.map(({ agent }) => this.runAgentTurn(roomId, agent.name, input)),
      );

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;

        const count = responseCounts.get(result.value.agentName) || 0;
        responseCounts.set(result.value.agentName, count + 1);

        for (const message of result.value.postedMessages) {
          triggerQueue.push(message);
        }
      }

      cycles += 1;
    }
  }

  async runAgentTurn(roomId, agentName, input) {
    const room = getAgentRoom(roomId);
    if (!room) {
      throw new Error('Agent room not found');
    }

    const agent = getAgentRoomAgent(roomId, agentName, { includeSecrets: true });
    if (!agent) {
      saveAgentRoomLog(roomId, 'system', 'warning', `Unknown agent mentioned: ${agentName}`);
      this.emitRoomEvent(roomId, 'agent_room:log', {
        log: {
          agent_name: 'system',
          level: 'warning',
          message: `Unknown agent mentioned: ${agentName}`,
          created_at: nowUnix(),
          meta: {},
        },
      });
      return { agentName, handoffs: [], postedMessages: [] };
    }

    updateAgentRoomAgentStatus(roomId, agent.name, 'running');
    this.emitRoomEvent(roomId, 'agent_room:agent_status', {
      agent_name: agent.name,
      status: 'running',
    });

    const postedMessages = [];

    try {
      const workspaceEntries = await listFiles(room.workspace_path, '.', 3).catch(() => []);
      const workspaceListing = workspaceEntries
        .slice(0, 80)
        .map((entry) => `${entry.type === 'directory' ? '[dir]' : '[file]'} ${entry.path}`)
        .join('\n');
      const messages = listAgentRoomMessages(roomId, MAX_VISIBLE_HISTORY);
      const privateMemory = getAgentRoomMemory(roomId, agent.name)?.memory_text || '';
      const agents = listAgentRoomAgents(roomId, { includeSecrets: true });

      // Load room-assigned skills (used as filter for skill tools)
      const roomSkills = listRoomSkills(roomId);
      const allowedSkillIds = roomSkills.map((s) => s.skill_id);

      saveAgentRoomLog(roomId, agent.name, 'info', 'Started work on a room task', {
        source: 'room_message',
      });
      this.emitRoomEvent(roomId, 'agent_room:log', {
        log: {
          agent_name: agent.name,
          level: 'info',
          message: 'Started work on a room task',
          created_at: nowUnix(),
          meta: {
            source: 'room_message',
          },
        },
      });

      const result = await runReactiveAgentTurn({
        agent,
        roomContext: {
          roomId,
          roomName: room.name,
          roomDescription: room.description,
          workspacePath: room.workspace_path,
          workspaceListing,
          privateMemory,
          agents,
          allowedSkillIds: allowedSkillIds.length > 0 ? allowedSkillIds : null,
        },
        input,
        conversationHistory: messages,
        postMessage: async (senderName, content, eventType = 'message') => {
          const message = this.postAgentMessage(roomId, senderName, content, eventType);
          if (message) postedMessages.push(message);
          return message;
        },
      });

      const actionErrors = [];
      const fileArtifacts = [];
      const toolProgress = [];

      for (const toolResult of result.toolResults) {
        const progressEntry = {
          tool: toolResult.tool,
          path: toolResult.params?.path || null,
          status: toolResult.error ? 'error' : 'success',
          timestamp: nowUnix(),
        };
        toolProgress.push(progressEntry);

        if (toolResult.error) {
          const sanitizedError = 'Tool execution failed';
          actionErrors.push({
            tool: toolResult.tool,
            message: sanitizedError,
            path: toolResult.params?.path || null,
          });
          saveAgentRoomLog(roomId, agent.name, 'error', `Failed ${toolResult.tool}`, {
            tool: toolResult.tool,
            path: toolResult.params?.path || null,
            error: sanitizedError,
          });
          this.emitRoomEvent(roomId, 'agent_room:log', {
            log: {
              agent_name: agent.name,
              level: 'error',
              message: `Failed ${toolResult.tool}`,
              created_at: nowUnix(),
              meta: {
                tool: toolResult.tool,
                path: toolResult.params?.path || null,
                error: sanitizedError,
              },
            },
          });
          continue;
        }

        const logMeta = buildToolLogMeta(toolResult);
        saveAgentRoomLog(roomId, agent.name, 'info', `Executed ${toolResult.tool}`, logMeta);
        this.emitRoomEvent(roomId, 'agent_room:log', {
          log: {
            agent_name: agent.name,
            level: 'info',
            message: `Executed ${toolResult.tool}`,
            created_at: nowUnix(),
            meta: logMeta,
          },
        });

        // Emit skill usage events to room chat
        if (SKILL_TOOL_NAMES.has(toolResult.tool)) {
          this.emitRoomEvent(roomId, 'agent_room:skill_used', {
            agent_name: agent.name,
            tool: toolResult.tool,
            meta: logMeta,
            timestamp: nowUnix(),
          });
        }

        if ((toolResult.tool === 'write_file' || toolResult.tool === 'update_file') && toolResult.params?.path) {
          fileArtifacts.push({
            path: toolResult.params.path,
            tool: toolResult.tool,
            agent_name: agent.name,
            size: logMeta.input_bytes || 0,
          });
          this.emitRoomEvent(roomId, 'agent_room:file_changed', {
            agent_name: agent.name,
            path: toolResult.params.path,
            tool: toolResult.tool,
          });
        }
      }

      // Emit progress summary for this agent turn
      if (toolProgress.length > 0) {
        this.emitRoomEvent(roomId, 'agent_room:progress', {
          agent_name: agent.name,
          tools: toolProgress,
          artifacts: fileArtifacts,
          timestamp: nowUnix(),
        });
      }

      // Track token usage
      if (result.usage && result.usage.total_tokens > 0) {
        saveAgentRoomTokenUsage(roomId, agent.name, result.usage, result.usage.model || '', result.usage.provider || '');
        this.emitRoomEvent(roomId, 'agent_room:token_usage', {
          agent_name: agent.name,
          usage: result.usage,
          timestamp: nowUnix(),
        });
      }

      const finalMessage = this.postAgentMessage(roomId, agent.name, result.message, 'message', { artifacts: fileArtifacts });
      if (finalMessage) postedMessages.push(finalMessage);

      const missingHandoffMessages = getMissingHandoffMessages({
        senderName: agent.name,
        postedMessages,
        handoffs: result.handoffs,
        agents,
      });
      for (const handoffMessage of missingHandoffMessages) {
        const postedHandoff = this.postAgentMessage(roomId, handoffMessage.sender_name, handoffMessage.content, 'handoff');
        if (postedHandoff) {
          postedMessages.push(postedHandoff);
        }
      }

      saveAgentRoomMemory(roomId, agent.name, result.privateMemory);

      updateAgentRoomAgentStatus(roomId, agent.name, 'idle');
      this.emitRoomEvent(roomId, 'agent_room:agent_status', {
        agent_name: agent.name,
        status: 'idle',
      });
      this.emitRoomEvent(roomId, 'agent_room:agent_done', {
        agent_name: agent.name,
        handoffs: result.handoffs,
        action_errors: actionErrors,
      });

      return {
        agentName: agent.name.toLowerCase(),
        handoffs: result.handoffs,
        postedMessages,
      };
    } catch (error) {
      saveAgentRoomLog(roomId, agent.name, 'error', 'Agent execution failed');

      const errorMessage = this.postAgentMessage(
        roomId,
        agent.name,
        'I hit an error and could not finish the task.',
        'error',
      );
      if (errorMessage) postedMessages.push(errorMessage);

      updateAgentRoomAgentStatus(roomId, agent.name, 'error');
      this.emitRoomEvent(roomId, 'agent_room:agent_status', {
        agent_name: agent.name,
        status: 'error',
      });
      this.emitRoomEvent(roomId, 'agent_room:error', {
        agent_name: agent.name,
        message: 'Agent execution failed',
      });

      return {
        agentName: agent.name.toLowerCase(),
        handoffs: [],
        postedMessages,
      };
    }
  }
}