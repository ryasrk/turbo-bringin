/**
 * Tenrary-X Chat Dashboard — Main Application
 * Integrates all modules: storage, markdown, connections, shortcuts, tokens, conversations
 */

import { renderMarkdown, stripThinking, renderThinkingBlock } from './markdownRenderer.js';
import {
  saveConversation, loadConversation, listConversations,
  deleteConversation as deleteStoredConversation, createConversation as createStoredConversation,
  exportAsMarkdown, exportAsJSON, exportAsText, getActiveConversationId, setActiveConversationId, autoSave,
} from './chatStorage.js';
import { fetchWithRetry, ConnectionManager, categorizeError } from './connectionManager.js';
import { initShortcuts, getShortcutsList } from './keyboardShortcuts.js';
import { estimateTokens, calculateContextUsage, updateSessionStats, getSessionStats, formatTokenCount } from './tokenCounter.js';
import {
  createConversation, switchConversation, getActiveConversation,
  searchConversations, generateTitle, renderConversationList,
} from './conversationManager.js';

// ── State ──────────────────────────────────────────────────────
const state = {
  messages: [],
  isStreaming: false,
  abortController: null,
  conversationId: null,
  settings: {
    temperature: 0.7,
    maxTokens: 1024,
    maxContext: 16384,
    systemPrompt: 'You are a helpful assistant.',
    apiEndpoint: '/v1/chat/completions',
    showThinking: true,
  },
  mode: 'turboquant',
};

const PORT_MAP = { standard: 8080, turboquant: 8081 };

// ── DOM refs ───────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const chatContainer = $('#chat-container');
const messagesEl = $('#messages');
const welcomeEl = $('#welcome');
const userInput = $('#user-input');
const sendBtn = $('#send-btn');
const stopBtn = $('#stop-btn');
const statusIndicator = $('#status-indicator');
const tokenInfo = $('#token-info');
const modeSelect = $('#mode-select');
const modeBadge = $('#mode-badge');
const settingsBtn = $('#settings-btn');
const settingsModal = $('#settings-modal');
const settingsClose = $('#settings-close');
const shortcutsBtn = $('#shortcuts-btn');
const shortcutsModal = $('#shortcuts-modal');
const shortcutsClose = $('#shortcuts-close');
const shortcutsList = $('#shortcuts-list');
const exportBtn = $('#export-btn');
const exportModal = $('#export-modal');
const exportClose = $('#export-close');
const tempSlider = $('#temp-slider');
const tempValue = $('#temp-value');
const maxTokensInput = $('#max-tokens');
const ctxWindowInput = $('#ctx-window');
const systemPromptInput = $('#system-prompt');
const showThinkingInput = $('#show-thinking');
const apiEndpointInput = $('#api-endpoint');
const sidebar = $('#sidebar');
const sidebarToggle = $('#sidebar-toggle');
const newChatBtn = $('#new-chat-btn');
const searchInput = $('#search-conversations');
const conversationListEl = $('#conversation-list');
const contextFill = $('#context-fill');
const contextLabel = $('#context-label');

// ── Connection Manager ─────────────────────────────────────────
const connMgr = new ConnectionManager();
connMgr.onStateChange((newState) => {
  const labels = {
    connected: '● Connected',
    disconnected: '● Disconnected',
    reconnecting: '● Reconnecting...',
    streaming: '● Generating...',
  };
  const classes = {
    connected: 'online',
    disconnected: 'offline',
    reconnecting: 'offline',
    streaming: 'streaming',
  };
  statusIndicator.className = `status ${classes[newState] || 'offline'}`;
  statusIndicator.textContent = labels[newState] || '● Unknown';
});
connMgr.startHealthPolling('/health', 10000);

// ── Helpers ────────────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
}

function updateSendButton() {
  sendBtn.disabled = !userInput.value.trim() || state.isStreaming;
}

function updateContextBar() {
  const usage = calculateContextUsage(state.messages, state.settings.systemPrompt, state.settings.maxContext);
  const pct = Math.min(usage.percentage, 100);
  contextFill.style.width = `${pct}%`;
  contextLabel.textContent = `${Math.round(pct)}%`;

  contextFill.className = 'context-fill';
  if (usage.warning === 'critical') contextFill.classList.add('critical');
  else if (usage.warning === 'high') contextFill.classList.add('high');
  else if (usage.warning === 'approaching') contextFill.classList.add('approaching');
}

function updateTokenInfo() {
  const stats = getSessionStats();
  tokenInfo.textContent = `${state.messages.length} msgs • ${formatTokenCount(stats.totalTokens)} tokens`;
}

// ── Message Rendering ──────────────────────────────────────────
function createMessageEl(role, content, stats = null) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const avatar = role === 'user' ? '👤' : '⚡';
  const roleName = role === 'user' ? 'You' : 'Bonsai-8B';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let renderedContent;
  if (role === 'user') {
    renderedContent = `<p>${escapeHtml(content)}</p>`;
  } else {
    const { thinking, content: mainContent } = stripThinking(content);
    let thinkingHtml = '';
    if (thinking && state.settings.showThinking) {
      thinkingHtml = renderThinkingBlock(content);
    }
    renderedContent = thinkingHtml + renderMarkdown(mainContent || content);
  }

  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-role">${roleName}</span>
        <span class="message-time">${time}</span>
        ${role === 'user' ? '<button class="edit-msg-btn" title="Edit">✏️</button>' : '<button class="regen-btn" title="Regenerate">🔄</button>'}
      </div>
      <div class="message-content">${renderedContent}</div>
      ${stats ? `<div class="message-stats">${stats}</div>` : ''}
    </div>
  `;

  // Code copy buttons
  div.querySelectorAll('.copy-btn, [data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.closest('pre')?.querySelector('code')?.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = 'Copy'), 2000);
      });
    });
  });

  // Edit button
  const editBtn = div.querySelector('.edit-msg-btn');
  if (editBtn) {
    editBtn.addEventListener('click', () => editMessage(div, content));
  }

  // Regen button
  const regenBtn = div.querySelector('.regen-btn');
  if (regenBtn) {
    regenBtn.addEventListener('click', () => regenerateLastResponse());
  }

  return div;
}

function addStreamingIndicator() {
  const div = document.createElement('div');
  div.className = 'message assistant streaming';
  div.id = 'streaming-msg';
  div.innerHTML = `
    <div class="message-avatar">⚡</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-role">Bonsai-8B</span>
        <span class="message-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="message-content"><div class="thinking-dots"><span></span><span></span><span></span></div></div>
    </div>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

// ── Edit & Regenerate ──────────────────────────────────────────
function editMessage(msgEl, originalContent) {
  const msgIndex = Array.from(messagesEl.children).indexOf(msgEl);
  if (msgIndex < 0) return;

  userInput.value = originalContent;
  autoResize(userInput);
  userInput.focus();

  while (messagesEl.children.length > msgIndex) {
    messagesEl.removeChild(messagesEl.lastChild);
  }
  state.messages = state.messages.slice(0, msgIndex);
  updateContextBar();
  updateTokenInfo();
}

function regenerateLastResponse() {
  if (state.isStreaming || state.messages.length < 2) return;

  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg.role !== 'assistant') return;

  state.messages.pop();
  messagesEl.removeChild(messagesEl.lastChild);

  const lastUserMsg = state.messages[state.messages.length - 1];
  if (lastUserMsg?.role === 'user') {
    sendToAPI();
  }
}

// ── API Communication (Streaming with retry) ───────────────────
async function sendMessage(userText) {
  if (state.isStreaming || !userText.trim()) return;

  welcomeEl.classList.add('hidden');

  const userMsg = { role: 'user', content: userText, timestamp: Date.now() };
  state.messages.push(userMsg);
  messagesEl.appendChild(createMessageEl('user', userText));
  scrollToBottom();

  if (state.messages.filter((m) => m.role === 'user').length === 1) {
    const title = generateTitle(userText);
    const conv = getActiveConversation();
    if (conv) conv.title = title;
  }

  userInput.value = '';
  autoResize(userInput);
  updateSendButton();
  updateContextBar();

  await sendToAPI();
}

async function sendToAPI() {
  state.isStreaming = true;
  state.abortController = new AbortController();
  connMgr.setState('streaming');
  sendBtn.disabled = true;
  stopBtn.hidden = false;

  const streamEl = addStreamingIndicator();
  const contentEl = streamEl.querySelector('.message-content');

  const apiMessages = [];
  if (state.settings.systemPrompt) {
    apiMessages.push({ role: 'system', content: state.settings.systemPrompt });
  }
  const recent = state.messages.slice(-20);
  apiMessages.push(...recent.map((m) => ({ role: m.role, content: m.content })));

  const startTime = performance.now();
  let fullContent = '';
  let tokenCount = 0;

  try {
    const response = await fetchWithRetry(state.settings.apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: apiMessages,
        max_tokens: state.settings.maxTokens,
        temperature: state.settings.temperature,
        stream: true,
      }),
      signal: state.abortController.signal,
    }, { maxRetries: 2, signal: state.abortController.signal });

    if (!response.ok) {
      const errCat = categorizeError(null, response);
      throw new Error(errCat.message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            tokenCount++;

            const { thinking, content: mainContent } = stripThinking(fullContent);
            let html = '';
            if (thinking && state.settings.showThinking) {
              html += renderThinkingBlock(fullContent);
            }
            html += renderMarkdown(mainContent || fullContent);
            html += '<span class="stream-cursor"></span>';
            contentEl.innerHTML = html;
            scrollToBottom();
          }
        } catch {
          // Ignore malformed chunks
        }
      }
    }

    const elapsed = (performance.now() - startTime) / 1000;
    const tps = tokenCount > 0 ? (tokenCount / elapsed).toFixed(1) : '?';

    streamEl.classList.remove('streaming');
    streamEl.id = '';

    const statsHtml = `${tokenCount} tokens • ${elapsed.toFixed(2)}s • ${tps} t/s • ${state.mode}`;
    const statsEl = document.createElement('div');
    statsEl.className = 'message-stats';
    statsEl.textContent = statsHtml;
    streamEl.querySelector('.message-body').appendChild(statsEl);

    const metaEl = streamEl.querySelector('.message-meta');
    if (metaEl && !metaEl.querySelector('.regen-btn')) {
      const regenBtn = document.createElement('button');
      regenBtn.className = 'regen-btn';
      regenBtn.title = 'Regenerate';
      regenBtn.textContent = '🔄';
      regenBtn.addEventListener('click', () => regenerateLastResponse());
      metaEl.appendChild(regenBtn);
    }

    streamEl.querySelectorAll('pre').forEach((pre) => {
      if (!pre.querySelector('.copy-btn')) {
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(pre.querySelector('code')?.textContent || pre.textContent).then(() => {
            btn.textContent = 'Copied!';
            setTimeout(() => (btn.textContent = 'Copy'), 2000);
          });
        });
        pre.appendChild(btn);
      }
    });

    state.messages.push({ role: 'assistant', content: fullContent, timestamp: Date.now(), stats: statsHtml });
    updateSessionStats({ prompt_tokens: estimateTokens(apiMessages.map((m) => m.content).join('')), completion_tokens: tokenCount });

  } catch (err) {
    streamEl.classList.remove('streaming');
    if (err.name === 'AbortError') {
      contentEl.innerHTML = '<em class="text-muted">Generation stopped.</em>';
      if (fullContent) {
        state.messages.push({ role: 'assistant', content: fullContent, timestamp: Date.now() });
      }
    } else {
      const errCat = categorizeError(err);
      contentEl.innerHTML = `<span class="error-msg">⚠️ ${escapeHtml(errCat.message)}</span>`;
      if (errCat.retryable) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'retry-btn';
        retryBtn.textContent = '↻ Retry';
        retryBtn.addEventListener('click', () => {
          messagesEl.removeChild(streamEl);
          sendToAPI();
        });
        contentEl.appendChild(retryBtn);
      }
    }
  } finally {
    state.isStreaming = false;
    state.abortController = null;
    connMgr.setState('connected');
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    updateSendButton();
    updateContextBar();
    updateTokenInfo();
    persistCurrentConversation();
  }
}

// ── Persistence ────────────────────────────────────────────────
function persistCurrentConversation() {
  if (!state.conversationId) {
    const conv = createStoredConversation(generateTitle(state.messages[0]?.content || 'New Chat'));
    state.conversationId = conv.id;
    setActiveConversationId(conv.id);
  }

  const conv = {
    id: state.conversationId,
    title: generateTitle(state.messages.find((m) => m.role === 'user')?.content || 'Chat'),
    messages: state.messages,
    updatedAt: Date.now(),
    mode: state.mode,
    settings: state.settings,
  };
  autoSave(conv);
  refreshSidebar();
}

async function loadConversationById(id) {
  const conv = await loadConversation(id);
  if (!conv) return;

  state.conversationId = conv.id;
  state.messages = conv.messages || [];
  setActiveConversationId(id);

  messagesEl.innerHTML = '';
  if (state.messages.length > 0) {
    welcomeEl.classList.add('hidden');
    state.messages.forEach((msg) => {
      messagesEl.appendChild(createMessageEl(msg.role, msg.content, msg.stats));
    });
    scrollToBottom();
  } else {
    welcomeEl.classList.remove('hidden');
  }

  updateContextBar();
  updateTokenInfo();
  refreshSidebar();
}

function startNewConversation() {
  state.messages = [];
  state.conversationId = null;
  messagesEl.innerHTML = '';
  welcomeEl.classList.remove('hidden');
  userInput.value = '';
  updateContextBar();
  updateTokenInfo();
  refreshSidebar();
}

// ── Sidebar ────────────────────────────────────────────────────
async function refreshSidebar() {
  const convs = await listConversations();
  const activeId = state.conversationId;
  conversationListEl.innerHTML = renderConversationList(convs, activeId);

  conversationListEl.querySelectorAll('[data-conv-id]').forEach((el) => {
    el.addEventListener('click', () => {
      loadConversationById(el.dataset.convId);
    });

    const delBtn = el.querySelector('.conv-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteStoredConversation(el.dataset.convId);
        if (el.dataset.convId === state.conversationId) {
          startNewConversation();
        }
        refreshSidebar();
      });
    }
  });
}

// ── Export ──────────────────────────────────────────────────────
function exportChat(format) {
  const conv = {
    id: state.conversationId || 'export',
    title: generateTitle(state.messages.find((m) => m.role === 'user')?.content || 'Chat'),
    messages: state.messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode: state.mode,
  };

  let content, filename, mime;
  if (format === 'markdown') {
    content = exportAsMarkdown(conv);
    filename = `chat_${Date.now()}.md`;
    mime = 'text/markdown';
  } else if (format === 'json') {
    content = exportAsJSON(conv);
    filename = `chat_${Date.now()}.json`;
    mime = 'application/json';
  } else {
    content = exportAsText(conv);
    filename = `chat_${Date.now()}.txt`;
    mime = 'text/plain';
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  exportModal.hidden = true;
}

// ── Event Listeners ────────────────────────────────────────────

// Input
userInput.addEventListener('input', () => {
  autoResize(userInput);
  updateSendButton();
});

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.isStreaming && userInput.value.trim()) {
      sendMessage(userInput.value);
    }
  }
});

sendBtn.addEventListener('click', () => {
  if (!state.isStreaming && userInput.value.trim()) {
    sendMessage(userInput.value);
  }
});

stopBtn.addEventListener('click', () => {
  state.abortController?.abort();
});

// Mode
modeSelect.addEventListener('change', async () => {
  const newMode = modeSelect.value;
  modeBadge.textContent = newMode;
  connMgr.setState('reconnecting');

  try {
    // Tell the inference manager to switch modes (single model, single port)
    const res = await fetch(`/manager/switch?mode=${newMode}`, { method: 'POST', signal: AbortSignal.timeout(35000) });
    const data = await res.json();

    if (data.status === 'ok') {
      state.mode = newMode;
      state.settings.apiEndpoint = '/v1/chat/completions';
      connMgr.setState('connected');
    } else {
      connMgr.setState('disconnected');
    }
  } catch {
    // Manager not available — fallback: assume server is already running in requested mode
    state.mode = newMode;
    state.settings.apiEndpoint = '/v1/chat/completions';
    connMgr.setState('disconnected');
  }
});

// Sidebar
sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

newChatBtn.addEventListener('click', startNewConversation);

searchInput.addEventListener('input', async () => {
  const convs = await listConversations();
  const query = searchInput.value;
  const filtered = query ? searchConversations(query, convs) : convs;
  conversationListEl.innerHTML = renderConversationList(filtered, state.conversationId);
});

// Settings
settingsBtn.addEventListener('click', () => (settingsModal.hidden = false));
settingsClose.addEventListener('click', () => (settingsModal.hidden = true));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.hidden = true; });

tempSlider.addEventListener('input', () => {
  state.settings.temperature = parseFloat(tempSlider.value);
  tempValue.textContent = tempSlider.value;
});
maxTokensInput.addEventListener('change', () => { state.settings.maxTokens = parseInt(maxTokensInput.value) || 1024; });
ctxWindowInput.addEventListener('change', () => {
  state.settings.maxContext = parseInt(ctxWindowInput.value) || 16384;
  updateContextBar();
});
systemPromptInput.addEventListener('change', () => { state.settings.systemPrompt = systemPromptInput.value; });
showThinkingInput.addEventListener('change', () => { state.settings.showThinking = showThinkingInput.checked; });
apiEndpointInput.addEventListener('change', () => { state.settings.apiEndpoint = apiEndpointInput.value; });

// Shortcuts modal
shortcutsBtn.addEventListener('click', () => {
  shortcutsList.innerHTML = getShortcutsList()
    .map((s) => `<div class="shortcut-item"><kbd>${s.combo}</kbd><span>${s.description}</span></div>`)
    .join('');
  shortcutsModal.hidden = false;
});
shortcutsClose.addEventListener('click', () => (shortcutsModal.hidden = true));
shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) shortcutsModal.hidden = true; });

// Export
exportBtn.addEventListener('click', () => (exportModal.hidden = false));
exportClose.addEventListener('click', () => (exportModal.hidden = true));
exportModal.addEventListener('click', (e) => { if (e.target === exportModal) exportModal.hidden = true; });
document.querySelectorAll('.export-option').forEach((btn) => {
  btn.addEventListener('click', () => exportChat(btn.dataset.format));
});

// Suggestions
document.querySelectorAll('.suggestion-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    sendMessage(chip.dataset.prompt);
  });
});

// Custom events from keyboard shortcuts
document.addEventListener('chat:send', () => {
  if (!state.isStreaming && userInput.value.trim()) sendMessage(userInput.value);
});
document.addEventListener('chat:abort', () => state.abortController?.abort());
document.addEventListener('chat:new', startNewConversation);
document.addEventListener('chat:export', () => (exportModal.hidden = false));
document.addEventListener('chat:regenerate', regenerateLastResponse);
document.addEventListener('chat:shortcuts', () => {
  shortcutsList.innerHTML = getShortcutsList()
    .map((s) => `<div class="shortcut-item"><kbd>${s.combo}</kbd><span>${s.description}</span></div>`)
    .join('');
  shortcutsModal.hidden = false;
});

// ── Init ───────────────────────────────────────────────────────
initShortcuts();

const lastConvId = getActiveConversationId();
if (lastConvId) {
  loadConversationById(lastConvId);
} else {
  refreshSidebar();
}

updateContextBar();
updateTokenInfo();

if (typeof mermaid !== 'undefined') {
  mermaid.initialize({ startOnLoad: false, theme: 'dark' });
}
