// conversationManager.js — Multi-conversation management for chatbot dashboard

// ── State ──────────────────────────────────────────────────────

let _conversations = new Map();
let _activeId = null;

// ── Helpers ────────────────────────────────────────────────────

function generateId() {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now() {
  return Date.now();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dispatch(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

// ── Core API ───────────────────────────────────────────────────

export function createConversation(title = 'New Chat', mode = 'turboquant') {
  const ts = now();
  const conversation = {
    id: generateId(),
    title,
    messages: [],
    createdAt: ts,
    updatedAt: ts,
    mode,
    messageCount: 0,
  };

  _conversations.set(conversation.id, conversation);
  dispatch('conversation:create', { id: conversation.id, conversation });
  return conversation;
}

export function renameConversation(id, newTitle) {
  const conv = _conversations.get(id);
  if (!conv) return null;

  // H5 fix: create new object instead of mutating
  const updated = { ...conv, title: newTitle, updatedAt: now() };
  _conversations.set(id, updated);
  dispatch('conversation:rename', { id, title: newTitle });
  return updated;
}

export function deleteConversation(id) {
  if (!_conversations.has(id)) return false;

  _conversations.delete(id);
  dispatch('conversation:delete', { id });

  if (_activeId === id) {
    // Switch to the most recent remaining conversation, or clear
    const sorted = sortConversations([..._conversations.values()]);
    _activeId = sorted.length > 0 ? sorted[0].id : null;

    if (_activeId) {
      const next = _conversations.get(_activeId);
      dispatch('conversation:switch', { id: _activeId, conversation: next });
    }
  }

  return true;
}

export function switchConversation(id) {
  const conv = _conversations.get(id);
  if (!conv) return null;

  _activeId = id;
  // H5 fix: create new object instead of mutating
  const updated = { ...conv, updatedAt: now() };
  _conversations.set(id, updated);
  dispatch('conversation:switch', { id, conversation: updated });
  return updated;
}

export function getActiveConversation() {
  if (!_activeId) return null;
  return _conversations.get(_activeId) ?? null;
}

// ── Search / Filter ────────────────────────────────────────────

export function searchConversations(query, conversations) {
  if (!query || !query.trim()) return conversations;

  const q = query.toLowerCase().trim();

  return conversations.filter((conv) => {
    if (conv.title.toLowerCase().includes(q)) return true;

    return conv.messages.some(
      (msg) => typeof msg.content === 'string' && msg.content.toLowerCase().includes(q),
    );
  });
}

// ── Title Generation ───────────────────────────────────────────

export function generateTitle(firstMessage) {
  if (!firstMessage || typeof firstMessage !== 'string') return 'New Chat';

  const cleaned = firstMessage
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'New Chat';

  if (cleaned.length <= 40) return cleaned;

  // Truncate at last word boundary within 40 chars
  const truncated = cleaned.slice(0, 40);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

// ── Sorting ────────────────────────────────────────────────────

export function sortConversations(conversations) {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Rendering ──────────────────────────────────────────────────

export function renderConversationItem(conversation, isActive) {
  const activeClass = isActive ? ' active' : '';
  const title = escapeHtml(conversation.title);
  const timeAgo = formatTimeAgo(conversation.updatedAt);

  return `<div class="conv-item${activeClass}" data-conv-id="${escapeHtml(conversation.id)}">
  <span class="conv-title" title="${title}">${title}</span>
  <span class="conv-time">${timeAgo}</span>
  <button class="conv-delete" title="Delete">×</button>
</div>`;
}

export function renderConversationList(conversations, activeId) {
  const sorted = sortConversations(conversations);

  if (sorted.length === 0) {
    return '<p style="padding:12px;font-size:13px;color:var(--text-muted);text-align:center;">No conversations yet</p>';
  }

  return sorted
    .map((conv) => renderConversationItem(conv, conv.id === activeId))
    .join('\n');
}

// ── Time formatting ────────────────────────────────────────────

function formatTimeAgo(timestamp) {
  const diff = now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// ── Bulk operations ────────────────────────────────────────────

export function getAllConversations() {
  return [..._conversations.values()];
}

export function setConversations(conversations) {
  _conversations.clear();
  for (const conv of conversations) {
    _conversations.set(conv.id, conv);
  }
}

export function getConversation(id) {
  return _conversations.get(id) ?? null;
}

export function setActiveId(id) {
  _activeId = id;
}

export function getActiveId() {
  return _activeId;
}
