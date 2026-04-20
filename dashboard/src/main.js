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
import { ConnectionManager, categorizeError } from './connectionManager.js';
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
  attachedFiles: [],
  settings: {
    temperature: 0.7,
    maxTokens: 1024,
    maxContext: 65536,
    systemPrompt: 'You are a helpful assistant.',
    apiEndpoint: `http://${window.location.hostname}:8080/v1/chat/completions`,
    enableThinking: false,
    showThinking: true,
    language: 'auto',
    timezone: 'auto',
  },
  mode: 'turboquant',
};

// Single-port architecture: manager on :3002 controls server on :8080

// ── DOM refs ───────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const appEl = $('#app');
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
const enableThinkingInput = $('#enable-thinking');
const maxTokensInput = $('#max-tokens');
const ctxWindowInput = $('#ctx-window');
const systemPromptInput = $('#system-prompt');
const showThinkingInput = $('#show-thinking');
const apiEndpointInput = $('#api-endpoint');
const userLanguageSelect = $('#user-language');
const userTimezoneSelect = $('#user-timezone');
const localePreview = $('#locale-preview');
const sidebar = $('#sidebar');
const sidebarBackdrop = $('#sidebar-backdrop');
const sidebarToggle = $('#sidebar-toggle');
const newChatBtn = $('#new-chat-btn');
const searchInput = $('#search-conversations');
const conversationListEl = $('#conversation-list');
const contextFill = $('#context-fill');
const contextLabel = $('#context-label');
const plusBtn = $('#plus-btn');
const plusMenu = $('#plus-menu');
const reasoningToggleBtn = $('#reasoning-toggle-btn');
const fileUploadDoc = $('#file-upload-doc');
const fileUploadImg = $('#file-upload-img');

const MODAL_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'summary',
].join(', ');

let activeModal = null;
let activeModalTrigger = null;

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
connMgr.startHealthPolling('/manager/health', 10000);

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

function updateReasoningControls() {
  const enabled = Boolean(state.settings.enableThinking);
  enableThinkingInput.checked = enabled;
  reasoningToggleBtn.textContent = enabled ? 'Reasoning On' : 'Reasoning Off';
  reasoningToggleBtn.classList.toggle('active', enabled);
  reasoningToggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  reasoningToggleBtn.setAttribute('aria-label', enabled ? 'Disable reasoning generation' : 'Enable reasoning generation');
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function getModalFocusableElements(modal) {
  return Array.from(modal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)).filter((element) => element.getClientRects().length > 0);
}

function syncPlusMenuState() {
  plusBtn.setAttribute('aria-expanded', plusMenu.hidden ? 'false' : 'true');
}

function closePlusMenu() {
  plusMenu.hidden = true;
  syncPlusMenuState();
}

function syncSidebarBackdrop() {
  const sidebarOpen = !sidebar.classList.contains('collapsed');
  const showBackdrop = isMobileViewport() && sidebarOpen;
  sidebarBackdrop.hidden = !showBackdrop;
  appEl.classList.toggle('sidebar-open', showBackdrop);
  sidebarToggle.setAttribute('aria-expanded', sidebarOpen ? 'true' : 'false');
  sidebarToggle.setAttribute('aria-label', sidebarOpen ? 'Close sidebar' : 'Open sidebar');
}

function closeSidebar() {
  if (!isMobileViewport()) return;
  sidebar.classList.add('collapsed');
  syncSidebarBackdrop();
}

function openModal(modal, trigger, onOpen) {
  if (activeModal && activeModal !== modal) {
    closeModal(activeModal, { restoreFocus: false });
  }

  activeModal = modal;
  activeModalTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement;
  modal.hidden = false;
  onOpen?.();

  window.requestAnimationFrame(() => {
    const panel = modal.querySelector('.modal');
    const focusable = getModalFocusableElements(modal);
    (focusable[0] || panel)?.focus();
  });
}

function closeModal(modal, { restoreFocus = true } = {}) {
  if (!modal || modal.hidden) return;

  modal.hidden = true;

  if (activeModal === modal) {
    const trigger = activeModalTrigger;
    activeModal = null;
    activeModalTrigger = null;
    if (restoreFocus && trigger instanceof HTMLElement) {
      trigger.focus();
    }
  }
}

function applySettingsToUi() {
  tempSlider.value = String(state.settings.temperature);
  tempValue.textContent = String(state.settings.temperature);
  updateReasoningControls();
  maxTokensInput.value = String(state.settings.maxTokens);
  ctxWindowInput.value = String(state.settings.maxContext);
  systemPromptInput.value = state.settings.systemPrompt;
  showThinkingInput.checked = Boolean(state.settings.showThinking);
  apiEndpointInput.value = state.settings.apiEndpoint;
  userLanguageSelect.value = state.settings.language;
  userTimezoneSelect.value = state.settings.timezone;
  updateLocalePreview();
}

// ── Message Rendering ──────────────────────────────────────────
function createMessageEl(role, content, stats = null) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const avatar = role === 'user' ? 'U' : 'AI';
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
        ${role === 'user' ? '<button class="edit-msg-btn" title="Edit">Edit</button>' : '<button class="regen-btn" title="Regenerate">Redo</button>'}
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
      }).catch(() => {
        btn.textContent = 'Failed';
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
    <div class="message-avatar">AI</div>
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
  if (state.isStreaming) return;
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
  state.isStreaming = true; // Guard immediately to prevent duplicate calls

  welcomeEl.classList.add('hidden');

  // Clear input early to prevent re-entry from parallel keydown handlers
  userInput.value = '';
  autoResize(userInput);
  updateSendButton();

  // Append file contents if attached
  let fullContent = userText;
  if (state.attachedFiles.length > 0) {
    const fileTexts = await Promise.all(
      state.attachedFiles.map(async (file) => {
        if (file.type.startsWith('image/')) {
          return `[Attached image: ${file.name}]`;
        }
        try {
          const text = await file.text();
          return `--- ${file.name} ---\n${text}`;
        } catch {
          return `[Attached file: ${file.name}]`;
        }
      })
    );
    fullContent = userText + '\n\n' + fileTexts.join('\n\n');
    state.attachedFiles = [];
    renderAttachedFiles();
  }

  const userMsg = { role: 'user', content: fullContent, timestamp: Date.now() };
  state.messages.push(userMsg);
  messagesEl.appendChild(createMessageEl('user', userText));
  scrollToBottom();

  if (state.messages.filter((m) => m.role === 'user').length === 1) {
    const title = generateTitle(userText);
    const conv = getActiveConversation();
    if (conv) conv.title = title;
  }

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
    const now = new Date();
    const locale = state.settings.language === 'auto' ? (navigator.language || 'en-US') : state.settings.language;
    const tz = state.settings.timezone === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : state.settings.timezone;
    const datetime = now.toLocaleString(locale, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: tz, timeZoneName: 'long',
    });
    apiMessages.push({ role: 'system', content: `${state.settings.systemPrompt}\n\nCurrent date and time: ${datetime}\nTimezone: ${tz}\nUser language: ${locale}` });
  }
  const recent = state.messages.slice(-20);
  apiMessages.push(...recent.map((m) => ({ role: m.role, content: m.content })));

  const startTime = performance.now();
  let fullContent = '';
  let tokenCount = 0;

  try {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${location.host}/manager/ws/chat`;

    function renderStream(showCursor = true) {
      const { thinking, content: mainContent } = stripThinking(fullContent);
      let html = '';
      if (thinking && state.settings.showThinking) {
        html += renderThinkingBlock(fullContent);
      }
      html += renderMarkdown(mainContent || fullContent);
      if (showCursor) {
        html += '<span class="stream-cursor"></span>';
      }
      contentEl.innerHTML = html;
      scrollToBottom();
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let pendingRender = 0;
      let settled = false;
      let aborted = false;

      function scheduleRender() {
        if (pendingRender) return;
        pendingRender = requestAnimationFrame(() => {
          pendingRender = 0;
          renderStream(true);
        });
      }

      function cleanup() {
        state.abortController?.signal.removeEventListener('abort', onAbort);
        if (pendingRender) {
          cancelAnimationFrame(pendingRender);
          pendingRender = 0;
        }
      }

      function resolveOnce() {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }

      function rejectOnce(error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }

      const onAbort = () => {
        aborted = true;
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'cancelled');
        }
        rejectOnce(new DOMException('The operation was aborted.', 'AbortError'));
      };

      state.abortController.signal.addEventListener('abort', onAbort);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          messages: apiMessages,
          max_tokens: state.settings.maxTokens,
          temperature: state.settings.temperature,
          chat_template_kwargs: {
            enable_thinking: state.settings.enableThinking,
          },
        }));
      };

      ws.onmessage = (event) => {
        if (aborted || settled) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === 'delta' && message.delta) {
          fullContent += message.delta;
          tokenCount += 1;
          scheduleRender();
          return;
        }

        if (message.type === 'done') {
          renderStream(false);
          resolveOnce();
          ws.close(1000, 'complete');
          return;
        }

        if (message.type === 'error') {
          rejectOnce(new Error(message.message || 'WebSocket stream failed.'));
          ws.close(1011, 'error');
        }
      };

      ws.onclose = (event) => {
        if (settled) return;
        if (aborted) {
          rejectOnce(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        if (fullContent) {
          if (event.code !== 1000) {
            fullContent += '\n\n⚠️ *Response may be truncated (connection closed unexpectedly).*';
          }
          renderStream(false);
          resolveOnce();
          return;
        }
        rejectOnce(new Error(event.reason || 'WebSocket connection closed unexpectedly.'));
      };

      ws.onerror = () => {
        if (settled || aborted) return;
        rejectOnce(new Error('WebSocket connection failed.'));
      };
    });

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
      regenBtn.textContent = 'Redo';
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
          }).catch(() => {
            btn.textContent = 'Failed';
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
    streamEl.id = '';
    if (err.name === 'AbortError') {
      contentEl.innerHTML = '<em class="text-muted">Generation stopped.</em>';
      if (fullContent) {
        state.messages.push({ role: 'assistant', content: fullContent, timestamp: Date.now() });
      }
    } else {
      const errCat = categorizeError(err);
      contentEl.innerHTML = `<span class="error-msg">Error: ${escapeHtml(errCat.message)}</span>`;
      if (errCat.retryable) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'retry-btn';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => {
          if (state.isStreaming) return;
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
    userInput.focus();
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
  if (state.isStreaming) return;
  const conv = await loadConversation(id);
  if (!conv) return;

  state.conversationId = conv.id;
  state.messages = conv.messages || [];
  state.settings = { ...state.settings, ...(conv.settings || {}) };
  setActiveConversationId(id);
  applySettingsToUi();

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
  closeModal(exportModal);
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

// Plus menu (tool list)
plusBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  plusMenu.hidden = !plusMenu.hidden;
  syncPlusMenuState();
});

reasoningToggleBtn.addEventListener('click', () => {
  state.settings.enableThinking = !state.settings.enableThinking;
  updateReasoningControls();
});

document.addEventListener('click', () => { closePlusMenu(); });
plusMenu.addEventListener('click', (e) => e.stopPropagation());

document.querySelectorAll('.plus-menu-item').forEach((item) => {
  item.addEventListener('click', () => {
    const action = item.dataset.action;
    closePlusMenu();
    if (action === 'upload-doc') fileUploadDoc.click();
    else if (action === 'upload-image') fileUploadImg.click();
  });
});

fileUploadDoc.addEventListener('change', () => handleFileAttach(fileUploadDoc));
fileUploadImg.addEventListener('change', () => handleFileAttach(fileUploadImg));

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_DOC_TYPES = new Set([
  'text/plain', 'text/markdown', 'application/json', 'text/csv',
  'application/pdf', 'text/x-python', 'application/javascript',
  'application/typescript', 'video/mp2t',
]);
const ALLOWED_DOC_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.pdf', '.py', '.js', '.ts']);

function handleFileAttach(input) {
  const files = Array.from(input.files);
  const isImageInput = input === fileUploadImg;
  files.forEach((file) => {
    if (file.size > MAX_FILE_SIZE) {
      alert(`File "${file.name}" exceeds the 10 MB limit.`);
      return;
    }
    if (isImageInput) {
      if (!file.type.startsWith('image/')) {
        alert(`File "${file.name}" is not a valid image.`);
        return;
      }
    } else {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!ALLOWED_DOC_TYPES.has(file.type) && !ALLOWED_DOC_EXTENSIONS.has(ext)) {
        alert(`File "${file.name}" has an unsupported type.`);
        return;
      }
    }
    if (state.attachedFiles.some((f) => f.name === file.name)) return;
    state.attachedFiles.push(file);
  });
  renderAttachedFiles();
  input.value = '';
}

function renderAttachedFiles() {
  let container = document.querySelector('.attached-files');
  if (state.attachedFiles.length === 0) {
    if (container) container.remove();
    return;
  }
  if (!container) {
    container = document.createElement('div');
    container.className = 'attached-files';
    const inputArea = document.querySelector('.input-area');
    const inputWrapper = inputArea.querySelector('.input-wrapper');
    inputArea.insertBefore(container, inputWrapper.nextSibling);
  }
  container.innerHTML = state.attachedFiles
    .map((f, i) => `<span class="attached-file">${escapeHtml(f.name)}<button class="remove-file" data-idx="${i}" title="Remove">×</button></span>`)
    .join('');
  container.querySelectorAll('.remove-file').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.attachedFiles.splice(parseInt(btn.dataset.idx), 1);
      renderAttachedFiles();
    });
  });
}

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
      state.settings.apiEndpoint = `http://${window.location.hostname}:8080/v1/chat/completions`;
      connMgr.setState('connected');
    } else {
      connMgr.setState('disconnected');
    }
  } catch {
    // Manager not available — fallback: assume server is already running in requested mode
    state.mode = newMode;
    state.settings.apiEndpoint = `http://${window.location.hostname}:8080/v1/chat/completions`;
    connMgr.setState('disconnected');
  }
});

// Sidebar
sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  syncSidebarBackdrop();
});

sidebarBackdrop.addEventListener('click', () => closeSidebar());

newChatBtn.addEventListener('click', startNewConversation);

let _searchDebounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(async () => {
    const convs = await listConversations();
    const query = searchInput.value;
    const filtered = query ? searchConversations(query, convs) : convs;
    conversationListEl.innerHTML = renderConversationList(filtered, state.conversationId);
  }, 200);
});

// Settings
settingsBtn.addEventListener('click', () => openModal(settingsModal, settingsBtn));
settingsClose.addEventListener('click', () => closeModal(settingsModal));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeModal(settingsModal); });

// Settings tabs
document.querySelectorAll('.settings-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.settings-panel').forEach((p) => (p.hidden = true));
    tab.classList.add('active');
    document.querySelector(`[data-panel="${tab.dataset.tab}"]`).hidden = false;
    if (tab.dataset.tab === 'locale') updateLocalePreview();
  });
});

tempSlider.addEventListener('input', () => {
  state.settings.temperature = parseFloat(tempSlider.value);
  tempValue.textContent = tempSlider.value;
});
enableThinkingInput.addEventListener('change', () => {
  state.settings.enableThinking = enableThinkingInput.checked;
  updateReasoningControls();
});
maxTokensInput.addEventListener('change', () => { state.settings.maxTokens = parseInt(maxTokensInput.value) || 1024; });
ctxWindowInput.addEventListener('change', () => {
  state.settings.maxContext = parseInt(ctxWindowInput.value) || 65536;
  updateContextBar();
});
systemPromptInput.addEventListener('change', () => { state.settings.systemPrompt = systemPromptInput.value; });
showThinkingInput.addEventListener('change', () => { state.settings.showThinking = showThinkingInput.checked; });
apiEndpointInput.addEventListener('change', () => { state.settings.apiEndpoint = apiEndpointInput.value; });

// Locale settings
userLanguageSelect.addEventListener('change', () => {
  state.settings.language = userLanguageSelect.value;
  updateLocalePreview();
});
userTimezoneSelect.addEventListener('change', () => {
  state.settings.timezone = userTimezoneSelect.value;
  updateLocalePreview();
});

function updateLocalePreview() {
  const now = new Date();
  const locale = state.settings.language === 'auto' ? (navigator.language || 'en-US') : state.settings.language;
  const tz = state.settings.timezone === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : state.settings.timezone;
  const datetime = now.toLocaleString(locale, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: tz, timeZoneName: 'long',
  });
  localePreview.textContent = `${datetime}\nTimezone: ${tz}\nLanguage: ${locale}`;
}

function populateTimezones() {
  const timezones = Intl.supportedValuesOf('timeZone');
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  timezones.forEach((tz) => {
    const opt = document.createElement('option');
    opt.value = tz;
    opt.textContent = tz.replace(/_/g, ' ');
    userTimezoneSelect.appendChild(opt);
  });
  // Update auto label
  userTimezoneSelect.querySelector('[value="auto"]').textContent = `Auto-detect (${detected})`;
  userLanguageSelect.querySelector('[value="auto"]').textContent = `Auto-detect (${navigator.language})`;
}

// Shortcuts modal
function openShortcutsModal(trigger = shortcutsBtn) {
  shortcutsList.innerHTML = getShortcutsList()
    .map((s) => `<div class="shortcut-item"><kbd>${s.combo}</kbd><span>${s.description}</span></div>`)
    .join('');
  openModal(shortcutsModal, trigger);
}

shortcutsBtn.addEventListener('click', () => {
  openShortcutsModal(shortcutsBtn);
});
shortcutsClose.addEventListener('click', () => closeModal(shortcutsModal));
shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) closeModal(shortcutsModal); });

// Export
exportBtn.addEventListener('click', () => openModal(exportModal, exportBtn));
exportClose.addEventListener('click', () => closeModal(exportModal));
exportModal.addEventListener('click', (e) => { if (e.target === exportModal) closeModal(exportModal); });
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
document.addEventListener('chat:export', () => openModal(exportModal, exportBtn));
document.addEventListener('chat:regenerate', regenerateLastResponse);
document.addEventListener('chat:shortcuts', () => openShortcutsModal(shortcutsBtn));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!plusMenu.hidden) {
      event.preventDefault();
      closePlusMenu();
      plusBtn.focus();
      return;
    }

    if (activeModal) {
      event.preventDefault();
      closeModal(activeModal);
      return;
    }

    if (isMobileViewport() && !sidebar.classList.contains('collapsed')) {
      event.preventDefault();
      closeSidebar();
    }
    return;
  }

  if (event.key !== 'Tab' || !activeModal) return;

  const focusable = getModalFocusableElements(activeModal);
  const panel = activeModal.querySelector('.modal');

  if (focusable.length === 0) {
    event.preventDefault();
    panel?.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeElement = document.activeElement;

  if (!activeModal.contains(activeElement)) {
    event.preventDefault();
    first.focus();
    return;
  }

  if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// ── Init ───────────────────────────────────────────────────────
initShortcuts();
populateTimezones();
applySettingsToUi();
syncPlusMenuState();

if (isMobileViewport()) {
  sidebar.classList.add('collapsed');
}

syncSidebarBackdrop();
window.addEventListener('resize', syncSidebarBackdrop);

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
