/**
 * Agent Typing Indicator — shows animated "thinking" indicators
 * when agents are actively running in the Agent Room chat.
 */

import { rs, escapeHtml } from './roomsUtils.js';

/** @type {Map<string, number>} agent name → timestamp when status changed to running */
const activeAgents = new Map();
const STALE_TIMEOUT_MS = 120_000; // 2 minutes

export function setAgentTypingStatus(agentName, status) {
  const name = String(agentName || '').toLowerCase();
  if (!name) return;

  if (status === 'running') {
    activeAgents.set(name, Date.now());
  } else {
    activeAgents.delete(name);
  }

  renderTypingIndicator();
}

export function clearAllTypingIndicators() {
  activeAgents.clear();
  renderTypingIndicator();
}

export function renderTypingIndicator() {
  const container = rs.panel?.querySelector('#agent-typing-indicator');
  if (!container) return;

  // Prune stale entries
  const now = Date.now();
  for (const [name, ts] of activeAgents) {
    if (now - ts > STALE_TIMEOUT_MS) {
      activeAgents.delete(name);
    }
  }

  if (activeAgents.size === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  const names = [...activeAgents.keys()].sort();
  const label = names.length === 1
    ? `@${escapeHtml(names[0])} is thinking`
    : names.length === 2
      ? `@${escapeHtml(names[0])} and @${escapeHtml(names[1])} are thinking`
      : `${names.slice(0, -1).map((n) => `@${escapeHtml(n)}`).join(', ')} and @${escapeHtml(names[names.length - 1])} are thinking`;

  container.hidden = false;
  container.innerHTML = `
    <span class="typing-dots" aria-hidden="true">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </span>
    <span class="typing-label">${label}</span>
  `;
}
