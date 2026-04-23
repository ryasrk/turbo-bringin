import { getAccessToken, isAuthenticated } from './authClient.js';
import { rs, sanitizeClassToken } from './roomsUtils.js';
import { showToast } from './utils.js';
import { renderAgentMembers } from './roomsUI.js';
import { appendAgentRoomMessage, appendSkillEvent } from './roomChat.js';
import {
  refreshAgentFiles, openAgentFile, renderConnectionState, renderAgentProgress, renderAgentLogs,
   
} from './agentWorkspace.js';
import { setAgentTypingStatus, clearAllTypingIndicators } from './agentTypingIndicator.js';
import { extractHandoffsFromMessage } from './agentHandoffViz.js';
import { addRealtimeTokenUsage } from './agentTokenUsage.js';

export function closeAgentSocket() {
  if (rs.agentRoomReconnectTimer) {
    clearTimeout(rs.agentRoomReconnectTimer);
    rs.agentRoomReconnectTimer = null;
  }
  if (rs.agentSocket) {
    rs.agentSocket.close();
    rs.agentSocket = null;
  }
  rs.agentRoomConnectionState = rs.currentAgentRoomId ? 'offline' : 'idle';
}

export function scheduleAgentReconnect() {
  if (rs.agentRoomReconnectTimer || !rs.currentAgentRoomId || !isAuthenticated()) return;
  rs.agentRoomConnectionState = 'reconnecting';
  renderConnectionState();
  rs.agentRoomReconnectTimer = setTimeout(() => {
    rs.agentRoomReconnectTimer = null;
    connectAgentRoomSocket();
  }, 1500);
}

export function connectAgentRoomSocket() {
  closeAgentSocket();
  const token = getAccessToken();
  if (!rs.currentAgentRoomId || !token) return;

  rs.agentRoomConnectionState = 'connecting';
  renderConnectionState();

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${window.location.host}/manager/ws/agent-room?room_id=${encodeURIComponent(rs.currentAgentRoomId)}&token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(wsUrl);
  rs.agentSocket = socket;

  socket.addEventListener('open', () => {
    rs.agentRoomConnectionState = 'connected';
    renderConnectionState();
  });

  socket.addEventListener('message', async (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }

    if (payload.type === 'agent_room:message') {
      if (rs.currentRoomMode === 'agent' && payload.message) {
        appendAgentRoomMessage(payload.message);
        extractHandoffsFromMessage(payload.message);
      }
      return;
    }

    if (payload.type === 'agent_room:log' && payload.log) {
      rs.agentRoomLogs = [...rs.agentRoomLogs, payload.log].slice(-200);
      renderAgentLogs();
      return;
    }

    if (payload.type === 'agent_room:agent_status' && rs.currentRoomMode === 'agent') {
      if (payload.agent_name && payload.status) {
        rs.currentAgentMembers = rs.currentAgentMembers.map((a) =>
          a.name === payload.agent_name ? { ...a, status: payload.status } : a
        );
        setAgentTypingStatus(payload.agent_name, payload.status);
        const pill = rs.panel?.querySelector(`[data-agent-edit="${CSS.escape(payload.agent_name)}"]`);
        if (pill) {
          pill.className = pill.className.replace(/\bstatus-\S+/g, '');
          pill.classList.add(`status-${sanitizeClassToken(payload.status)}`);
        } else {
          renderAgentMembers(rs.currentAgentMembers);
        }
      }
      return;
    }

    if (payload.type === 'agent_room:file_changed') {
      rs.agentRoomFileAuthors.set(payload.path, {
        agent_name: payload.agent_name,
        tool: payload.tool,
        timestamp: Date.now(),
      });
      await refreshAgentFiles();
      if (rs.agentRoomSelectedFile === payload.path) {
        await openAgentFile(payload.path);
      }
      return;
    }

    if (payload.type === 'agent_room:skill_used') {
      appendSkillEvent(payload);
      return;
    }

    if (payload.type === 'agent_room:progress') {
      rs.agentRoomProgressTimeline = [...rs.agentRoomProgressTimeline, {
        agent_name: payload.agent_name,
        tools: payload.tools || [],
        artifacts: payload.artifacts || [],
        timestamp: payload.timestamp || Math.floor(Date.now() / 1000),
      }].slice(-50);
      for (const artifact of (payload.artifacts || [])) {
        rs.agentRoomFileAuthors.set(artifact.path, {
          agent_name: artifact.agent_name || payload.agent_name,
          tool: artifact.tool,
          timestamp: Date.now(),
        });
      }
      renderAgentProgress();
      return;
    }

    if (payload.type === 'agent_room:token_usage') {
      if (payload.agent_name && payload.usage) {
        addRealtimeTokenUsage(payload.agent_name, payload.usage);
      }
      return;
    }

    if (payload.type === 'agent_room:error') {
      showToast(payload.message || 'Agent room error', 'error');
    }
  });

  socket.addEventListener('close', () => {
    if (rs.agentSocket === socket) {
      rs.agentSocket = null;
      rs.agentRoomConnectionState = 'offline';
      clearAllTypingIndicators();
      renderConnectionState();
      scheduleAgentReconnect();
    }
  });

  socket.addEventListener('error', () => {
    rs.agentRoomConnectionState = 'offline';
    renderConnectionState();
  });
}
