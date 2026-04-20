/**
 * Tenrary-X Chat Dashboard — Main Application
 * Integrates all modules: storage, markdown, connections, shortcuts, tokens, conversations
 */

import { renderMarkdown, stripThinking, renderThinkingBlock } from './markdownRenderer.js';
import {
  saveConversation, loadConversation, listConversations,
  deleteConversation as deleteStoredConversation, createConversation as createStoredConversation,
  exportAsMarkdown, exportAsJSON, exportAsText, getActiveConversationId, setActiveConversationId, autoSave,
  generateShareData, importShareData,
} from './chatStorage.js';
import { ConnectionManager, categorizeError } from './connectionManager.js';
import { initShortcuts, getShortcutsList } from './keyboardShortcuts.js';
import { estimateTokens, calculateContextUsage, updateSessionStats, getSessionStats, formatTokenCount, recordUsage, getAnalyticsSummary } from './tokenCounter.js';
import {
  createConversation, switchConversation, getActiveConversation,
  searchConversations, generateTitle, generateTitleViaLLM, renderConversationList,
  setFolder, renameConversation as renameConv, createFolder, deleteFolder, getFolders,
  syncFoldersFromConversations,
} from './conversationManager.js';
import { executeCommand, getCommands } from './pluginManager.js';

// ── System Prompt Templates ────────────────────────────────────
const SYSTEM_PROMPT_TEMPLATES = [
  { name: 'Default', prompt: 'You are a helpful assistant.' },
  { name: 'Coding Assistant', prompt: 'You are an expert programmer. Write clean, efficient code with clear explanations. Always include error handling.' },
  { name: 'Translator', prompt: 'You are a professional translator. Translate text between languages accurately while preserving tone and context.' },
  { name: 'Creative Writer', prompt: 'You are a creative writing assistant. Help with stories, poems, scripts, and creative content.' },
  { name: 'Tutor', prompt: 'You are a patient tutor. Explain concepts step-by-step, use examples, and check understanding.' },
  { name: 'Analyst', prompt: 'You are a data analyst. Analyze information systematically, identify patterns, and provide evidence-based conclusions.' },
];

// ── State ──────────────────────────────────────────────────────
const state = {
  messages: [],
  isStreaming: false,
  abortController: null,
  conversationId: null,
  folder: '',
  attachedFiles: [],
  _pendingBranches: null,
  settings: {
    temperature: 0.7,
    maxTokens: 1024,
    maxContext: 65536,
    systemPrompt: 'You are a helpful assistant.',
    apiEndpoint: '/v1/chat/completions',
    enableThinking: false,
    showThinking: true,
    language: 'auto',
    timezone: 'auto',
  },
  mode: 'turboquant',
};

// Single-port architecture: manager on :3002 controls inference server

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
const promptTemplateSelect = $('#prompt-template');
const contextMenu = $('#conv-context-menu');
const newFolderBtn = $('#new-folder-btn');
const newProjectModal = $('#new-project-modal');
const newProjectNameInput = $('#new-project-name');
const newProjectCreateBtn = $('#new-project-create');
const newProjectCancelBtn = $('#new-project-cancel');
const deleteProjectModal = $('#delete-project-modal');
const deleteProjectNameEl = $('#delete-project-name');
const deleteProjectConfirmBtn = $('#delete-project-confirm');
const deleteProjectCancelBtn = $('#delete-project-cancel');
const themeToggle = $('#theme-toggle');
const analyticsBtn = $('#analytics-btn');
const analyticsModal = $('#analytics-modal');
const analyticsClose = $('#analytics-close');
const analyticsContent = $('#analytics-content');
const voiceBtn = $('#voice-btn');
const viewChat = $('#view-chat');
const viewPlayground = $('#view-playground');
const navTabs = document.querySelectorAll('.nav-tab');
const playgroundPrompt = $('#playground-prompt');
const playgroundRun = $('#playground-run');
const playgroundOutput = $('#playground-output');
const playgroundClear = $('#playground-clear');
const playgroundHistory = $('#playground-history');
const pgTemp = $('#pg-temp');
const pgTempVal = $('#pg-temp-val');
const pgMaxTokens = $('#pg-max-tokens');

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

function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast${type ? ` toast--${type}` : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('toast--visible'));
  });
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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
  syncPromptTemplate();
}

// ── Message Rendering ──────────────────────────────────────────
function createMessageEl(role, content, stats = null, images = [], msgData = {}) {
  const div = document.createElement('div');
  div.className = `message ${role}${msgData.pinned ? ' pinned' : ''}`;

  const avatar = role === 'user' ? 'U' : 'AI';
  const roleName = role === 'user' ? 'You' : 'Bonsai-8B';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let renderedContent;
  if (role === 'user') {
    renderedContent = `<p>${escapeHtml(content)}</p>`;
    if (images && images.length > 0) {
      renderedContent += images
        .filter(img => img.dataUrl && img.dataUrl.startsWith('data:image/'))
        .map(img => `<img src="${img.dataUrl}" class="chat-image" alt="uploaded image: ${escapeHtml(img.name)}" loading="lazy" />`)
        .join('');
    }
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
        <button class="pin-msg-btn" title="Pin message">📌</button>
        ${role === 'user' ? '<button class="edit-msg-btn" title="Edit">Edit</button>' : '<button class="regen-btn" title="Regenerate">Redo</button>'}
        ${role === 'assistant' ? '<button class="reaction-btn" data-reaction="up" title="Good response">👍</button><button class="reaction-btn" data-reaction="down" title="Poor response">👎</button>' : ''}
      </div>
      <div class="message-content">${renderedContent}</div>
      ${stats ? `<div class="message-stats">${stats}</div>` : ''}
    </div>
  `;

  // Code copy buttons
  div.querySelectorAll('.copy-btn, [data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wrapper = btn.closest('.code-block-wrapper');
      const code = wrapper?.querySelector('pre code')?.textContent || wrapper?.querySelector('pre')?.textContent || '';
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

  // Pin button
  const pinBtn = div.querySelector('.pin-msg-btn');
  if (pinBtn) {
    pinBtn.addEventListener('click', () => {
      div.classList.toggle('pinned');
      const msgIndex = Array.from(messagesEl.children).indexOf(div);
      if (msgIndex >= 0 && state.messages[msgIndex]) {
        state.messages[msgIndex].pinned = div.classList.contains('pinned');
      }
    });
  }

  // Reaction buttons
  div.querySelectorAll('.reaction-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const reaction = btn.dataset.reaction;
      const msgIndex = Array.from(messagesEl.children).indexOf(div);
      const isActive = btn.classList.contains('active');
      div.querySelectorAll('.reaction-btn').forEach((b) => b.classList.remove('active'));
      if (!isActive) {
        btn.classList.add('active');
        if (msgIndex >= 0 && state.messages[msgIndex]) {
          state.messages[msgIndex].reaction = reaction;
        }
      } else {
        if (msgIndex >= 0 && state.messages[msgIndex]) {
          delete state.messages[msgIndex].reaction;
        }
      }
    });
  });

  // Restore reaction state from loaded data
  if (msgData.reaction) {
    const activeBtn = div.querySelector(`.reaction-btn[data-reaction="${msgData.reaction}"]`);
    if (activeBtn) activeBtn.classList.add('active');
  }

  // Branch navigation for messages with multiple regenerations
  addBranchNavToEl(div, msgData);

  return div;
}

function addBranchNavToEl(msgEl, msg) {
  if (!msg || !msg.branches || msg.branches.length <= 1) return;

  const nav = document.createElement('div');
  nav.className = 'branch-nav';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'branch-prev';
  prevBtn.title = 'Previous version';
  prevBtn.textContent = '←';

  const info = document.createElement('span');
  info.className = 'branch-info';
  info.textContent = `${(msg.activeBranch ?? 0) + 1}/${msg.branches.length}`;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'branch-next';
  nextBtn.title = 'Next version';
  nextBtn.textContent = '→';

  function updateBranchView() {
    const branch = msg.branches[msg.activeBranch];
    const contentEl = msgEl.querySelector('.message-content');
    const { thinking, content: mainContent } = stripThinking(branch.content);
    let html = '';
    if (thinking && state.settings.showThinking) {
      html += renderThinkingBlock(branch.content);
    }
    html += renderMarkdown(mainContent || branch.content);
    contentEl.innerHTML = html;

    const statsEl = msgEl.querySelector('.message-stats');
    if (statsEl && branch.stats) {
      statsEl.textContent = branch.stats;
    }

    info.textContent = `${msg.activeBranch + 1}/${msg.branches.length}`;
    prevBtn.disabled = msg.activeBranch === 0;
    nextBtn.disabled = msg.activeBranch === msg.branches.length - 1;

    msg.content = branch.content;
    msg.stats = branch.stats;
  }

  prevBtn.addEventListener('click', () => {
    if (msg.activeBranch > 0) {
      msg.activeBranch--;
      updateBranchView();
    }
  });

  nextBtn.addEventListener('click', () => {
    if (msg.activeBranch < msg.branches.length - 1) {
      msg.activeBranch++;
      updateBranchView();
    }
  });

  nav.appendChild(prevBtn);
  nav.appendChild(info);
  nav.appendChild(nextBtn);

  prevBtn.disabled = (msg.activeBranch ?? 0) === 0;
  nextBtn.disabled = (msg.activeBranch ?? 0) === msg.branches.length - 1;

  msgEl.querySelector('.message-body').appendChild(nav);
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
      <div class="live-stats"></div>
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

  // Initialize branches with current content if not already branched
  if (!lastMsg.branches) {
    lastMsg.branches = [{ content: lastMsg.content, stats: lastMsg.stats, timestamp: lastMsg.timestamp }];
    lastMsg.activeBranch = 0;
  }

  // Store branches so sendToAPI can attach them to the new response
  state._pendingBranches = lastMsg.branches;

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

  // Plugin command interception
  const trimmed = userText.trim();
  if (trimmed.startsWith('/')) {
    const cmdResult = executeCommand(trimmed);
    if (cmdResult) {
      hideCommandAutocomplete();
      userInput.value = '';
      autoResize(userInput);
      updateSendButton();
      if (cmdResult.type === 'system') {
        welcomeEl.classList.add('hidden');
        messagesEl.appendChild(createMessageEl('assistant', cmdResult.content));
        scrollToBottom();
      } else if (cmdResult.type === 'action') {
        if (cmdResult.action === 'clear') {
          startNewConversation();
        }
        if (cmdResult.action === 'stats') {
          const stats = getSessionStats();
          const content = `**Session Statistics:**\n- Messages: ${state.messages.length}\n- Total tokens: ${formatTokenCount(stats.totalTokens)}\n- Mode: ${state.mode}`;
          welcomeEl.classList.add('hidden');
          messagesEl.appendChild(createMessageEl('assistant', content));
          scrollToBottom();
        }
        if (cmdResult.action === 'switch-mode') {
          modeSelect.value = cmdResult.data;
          modeSelect.dispatchEvent(new Event('change'));
        }
      }
      return;
    }
  }

  state.isStreaming = true; // Guard immediately to prevent duplicate calls

  welcomeEl.classList.add('hidden');

  // Clear input early to prevent re-entry from parallel keydown handlers
  userInput.value = '';
  autoResize(userInput);
  updateSendButton();

  // Hide markdown preview
  if (inputPreview) {
    inputPreview.hidden = true;
    inputPreview.innerHTML = '';
  }

  // Append file contents if attached
  let fullContent = userText;
  let imageDataUrls = [];
  if (state.attachedFiles.length > 0) {
    const fileTexts = await Promise.all(
      state.attachedFiles.map(async (file) => {
        if (file.type.startsWith('image/')) {
          const dataUrl = await readFileAsDataURL(file);
          imageDataUrls.push({ name: file.name, dataUrl });
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

  const userMsg = { role: 'user', content: fullContent, timestamp: Date.now(), images: imageDataUrls };
  state.messages.push(userMsg);
  messagesEl.appendChild(createMessageEl('user', userText, null, imageDataUrls));
  scrollToBottom();

  if (state.messages.filter((m) => m.role === 'user').length === 1) {
    const title = generateTitle(userText);
    const conv = getActiveConversation();
    if (conv) conv.title = title;
    // Async LLM title generation — will update once response arrives
    state._pendingAutoTitle = userText;
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
  const liveStatsEl = streamEl.querySelector('.live-stats');

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

  const statsInterval = setInterval(() => {
    const elapsed = (performance.now() - startTime) / 1000;
    const tps = tokenCount > 0 ? (tokenCount / elapsed).toFixed(1) : '0';
    if (liveStatsEl) liveStatsEl.textContent = `${tokenCount} tokens • ${tps} t/s`;
  }, 500);

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

    const requestPayload = {
      messages: apiMessages,
      max_tokens: state.settings.maxTokens,
      temperature: state.settings.temperature,
      chat_template_kwargs: {
        enable_thinking: state.settings.enableThinking,
      },
    };

    // Try WebSocket first, fall back to SSE on connection failure
    let useSSE = false;
    try {
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
          ws.send(JSON.stringify(requestPayload));
        };

        ws.onmessage = (event) => {
          if (aborted || settled) return;
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }

          if (message.type === 'queued' && Number.isFinite(message.position)) {
            contentEl.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div> <em class="text-muted">Queued (position ${message.position})</em>`;
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
    } catch (wsErr) {
      // If WebSocket failed to connect (not an abort or mid-stream error), fall back to SSE
      if (wsErr.name !== 'AbortError' && !fullContent) {
        useSSE = true;
      } else {
        throw wsErr;
      }
    }

    // SSE fallback
    if (useSSE) {
      const sseResponse = await fetch('/manager/chat/sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
        signal: state.abortController.signal,
      });

      if (!sseResponse.ok) {
        const errText = await sseResponse.text().catch(() => 'SSE request failed');
        throw new Error(errText);
      }

      const reader = sseResponse.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let pendingRender = 0;

      function scheduleRender() {
        if (pendingRender) return;
        pendingRender = requestAnimationFrame(() => {
          pendingRender = 0;
          renderStream(true);
        });
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;

            let message;
            try {
              message = JSON.parse(data);
            } catch {
              continue;
            }

            if (message.type === 'queued' && Number.isFinite(message.position)) {
              contentEl.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div> <em class="text-muted">Queued (position ${message.position})</em>`;
              continue;
            }

            if (message.type === 'delta' && message.delta) {
              fullContent += message.delta;
              tokenCount += 1;
              scheduleRender();
              continue;
            }

            if (message.type === 'done') {
              renderStream(false);
              break;
            }

            if (message.type === 'error') {
              throw new Error(message.message || 'SSE stream failed.');
            }
          }
        }
      } finally {
        if (pendingRender) {
          cancelAnimationFrame(pendingRender);
        }
        reader.releaseLock();
      }

      if (!fullContent) {
        renderStream(false);
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
      regenBtn.textContent = 'Redo';
      regenBtn.addEventListener('click', () => regenerateLastResponse());
      metaEl.appendChild(regenBtn);
    }

    // Add pin button to streamed message
    if (metaEl && !metaEl.querySelector('.pin-msg-btn')) {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'pin-msg-btn';
      pinBtn.title = 'Pin message';
      pinBtn.textContent = '📌';
      pinBtn.addEventListener('click', () => {
        streamEl.classList.toggle('pinned');
        const msgIndex = Array.from(messagesEl.children).indexOf(streamEl);
        if (msgIndex >= 0 && state.messages[msgIndex]) {
          state.messages[msgIndex].pinned = streamEl.classList.contains('pinned');
        }
      });
      metaEl.appendChild(pinBtn);
    }

    // Add reaction buttons to streamed message
    if (metaEl && !metaEl.querySelector('.reaction-btn')) {
      ['up', 'down'].forEach((reaction) => {
        const btn = document.createElement('button');
        btn.className = 'reaction-btn';
        btn.dataset.reaction = reaction;
        btn.title = reaction === 'up' ? 'Good response' : 'Poor response';
        btn.textContent = reaction === 'up' ? '👍' : '👎';
        btn.addEventListener('click', () => {
          const isActive = btn.classList.contains('active');
          streamEl.querySelectorAll('.reaction-btn').forEach((b) => b.classList.remove('active'));
          const msgIndex = Array.from(messagesEl.children).indexOf(streamEl);
          if (!isActive) {
            btn.classList.add('active');
            if (msgIndex >= 0 && state.messages[msgIndex]) {
              state.messages[msgIndex].reaction = reaction;
            }
          } else {
            if (msgIndex >= 0 && state.messages[msgIndex]) {
              delete state.messages[msgIndex].reaction;
            }
          }
        });
        metaEl.appendChild(btn);
      });
    }

    const newMsg = { role: 'assistant', content: fullContent, timestamp: Date.now(), stats: statsHtml };
    if (state._pendingBranches) {
      newMsg.branches = [...state._pendingBranches, { content: fullContent, stats: statsHtml, timestamp: Date.now() }];
      newMsg.activeBranch = newMsg.branches.length - 1;
      state._pendingBranches = null;
      addBranchNavToEl(streamEl, newMsg);
    }
    state.messages.push(newMsg);
    const promptTokensEst = estimateTokens(apiMessages.map((m) => m.content).join(''));
    updateSessionStats({ prompt_tokens: promptTokensEst, completion_tokens: tokenCount });
    recordUsage(promptTokensEst, tokenCount, state.mode);

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
    clearInterval(statsInterval);
    if (liveStatsEl) liveStatsEl.remove();
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

    // Feature 3: Auto-title via LLM after first exchange
    if (state._pendingAutoTitle) {
      const msgText = state._pendingAutoTitle;
      state._pendingAutoTitle = null;
      generateTitleViaLLM(msgText).then((llmTitle) => {
        if (llmTitle && state.conversationId) {
          const conv = getActiveConversation();
          if (conv) conv.title = llmTitle;
          persistCurrentConversation();
          refreshSidebar();
        }
      });
    }
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
    folder: state.folder || '',
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
  state.folder = conv.folder || '';
  state.settings = { ...state.settings, ...(conv.settings || {}) };
  setActiveConversationId(id);
  applySettingsToUi();

  messagesEl.innerHTML = '';
  if (state.messages.length > 0) {
    welcomeEl.classList.add('hidden');
    state.messages.forEach((msg) => {
      messagesEl.appendChild(createMessageEl(msg.role, msg.content, msg.stats, msg.images, msg));
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
  state.folder = '';
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
  syncFoldersFromConversations(convs);
  const activeId = state.conversationId;
  conversationListEl.innerHTML = renderConversationList(convs, activeId);

  conversationListEl.querySelectorAll('[data-conv-id]').forEach((el) => {
    el.addEventListener('click', () => {
      loadConversationById(el.dataset.convId);
    });

    // Right-click context menu
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, el.dataset.convId);
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

  // Folder collapse toggling + delete
  conversationListEl.querySelectorAll('.folder-header').forEach((header) => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.folder-delete')) return;
      header.classList.toggle('collapsed');
      const folder = header.dataset.folder;
      const content = conversationListEl.querySelector(`.folder-content[data-folder="${folder}"]`);
      if (content) content.hidden = header.classList.contains('collapsed');
      const toggle = header.querySelector('.folder-toggle');
      if (toggle) toggle.textContent = header.classList.contains('collapsed') ? '\u25b8' : '\u25be';
    });

    const delBtn = header.querySelector('.folder-delete');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDeleteProjectModal(header.dataset.folder);
      });
    }
  });
}

// ── Export ──────────────────────────────────────────────────────
function exportChat(format) {
  if (format === 'share') {
    handleShare();
    return;
  }
  if (format === 'import-share') {
    handleImportShare();
    return;
  }

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

// ── Share / Import ─────────────────────────────────────────────
function handleShare() {
  const conv = {
    id: state.conversationId || 'export',
    title: generateTitle(state.messages.find((m) => m.role === 'user')?.content || 'Chat'),
    messages: state.messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode: state.mode,
  };

  const encoded = generateShareData(conv);

  if (navigator.share) {
    navigator.share({
      title: `Tenrary-X: ${conv.title}`,
      text: `Check out this Tenrary-X conversation: ${conv.title}`,
      url: `${location.origin}${location.pathname}?share=${encoded}`,
    }).catch(() => { /* user cancelled */ });
  } else {
    // Copy a self-contained HTML snippet to clipboard
    const htmlSnippet = buildShareHtml(conv);
    navigator.clipboard.writeText(htmlSnippet).then(() => {
      alert('Share HTML copied to clipboard!');
    }).catch(() => {
      // Fallback: copy just the base64 string
      navigator.clipboard.writeText(encoded).then(() => {
        alert('Share data copied to clipboard (base64).');
      }).catch(() => {
        alert('Failed to copy share data.');
      });
    });
  }
  closeModal(exportModal);
}

function buildShareHtml(conv) {
  const msgs = conv.messages.map(m => {
    const role = m.role === 'user' ? '🧑 You' : '🤖 Bonsai-8B';
    const escapedContent = m.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div style="margin:8px 0;padding:10px;border-radius:8px;background:${m.role === 'user' ? '#1a3a5c' : '#1c1c2e'}"><strong>${role}</strong><pre style="white-space:pre-wrap;margin:6px 0 0;font-family:inherit">${escapedContent}</pre></div>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${conv.title}</title><style>body{background:#0d1117;color:#e6edf3;font-family:-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:20px}</style></head><body><h2>${conv.title}</h2><p style="color:#8b949e">Exported from Tenrary-X • Bonsai-8B</p>${msgs}</body></html>`;
}

function handleImportShare() {
  closeModal(exportModal);
  const encoded = prompt('Paste the shared base64 string:');
  if (!encoded || !encoded.trim()) return;

  const data = importShareData(encoded.trim());
  if (!data) {
    alert('Invalid share data. Please check the string and try again.');
    return;
  }

  // Create a new conversation from the imported data
  const ts = Date.now();
  const conv = createStoredConversation(data.title || 'Shared Chat');
  conv.messages = data.messages.map(m => ({
    role: m.role,
    content: m.content,
    timestamp: m.timestamp || ts,
  }));
  saveConversation(conv).then(() => {
    loadConversationById(conv.id);
  });
}

// Check URL for shared data on load
function checkShareUrl() {
  const params = new URLSearchParams(location.search);
  const shareParam = params.get('share');
  if (!shareParam) return;

  const data = importShareData(shareParam);
  if (!data) return;

  const ts = Date.now();
  const conv = createStoredConversation(data.title || 'Shared Chat');
  conv.messages = data.messages.map(m => ({
    role: m.role,
    content: m.content,
    timestamp: m.timestamp || ts,
  }));
  saveConversation(conv).then(() => {
    loadConversationById(conv.id);
    // Clean URL
    history.replaceState(null, '', location.pathname);
  });
}

// ── Command Autocomplete ───────────────────────────────────────
let autocompleteEl = null;
let autocompleteSelectedIdx = -1;

function createAutocompleteEl() {
  if (autocompleteEl) return autocompleteEl;
  autocompleteEl = document.createElement('div');
  autocompleteEl.className = 'command-autocomplete';
  autocompleteEl.hidden = true;
  const inputWrapper = document.querySelector('.input-wrapper');
  inputWrapper.style.position = 'relative';
  inputWrapper.appendChild(autocompleteEl);
  return autocompleteEl;
}

function showCommandAutocomplete(filter) {
  const el = createAutocompleteEl();
  const cmds = getCommands();
  const query = filter.slice(1).toLowerCase();
  const matches = query
    ? cmds.filter(c => c.command.toLowerCase().startsWith(query))
    : cmds;

  if (matches.length === 0) {
    el.hidden = true;
    return;
  }

  autocompleteSelectedIdx = -1;
  el.innerHTML = matches.map((c, i) =>
    `<div class="command-item" data-idx="${i}" data-cmd="/${c.command}">
      <span class="command-name">/${c.command}</span>
      <span class="command-desc">${escapeHtml(c.description)}</span>
    </div>`
  ).join('');
  el.hidden = false;

  el.querySelectorAll('.command-item').forEach(item => {
    item.addEventListener('click', () => {
      userInput.value = item.dataset.cmd + ' ';
      hideCommandAutocomplete();
      userInput.focus();
      autoResize(userInput);
      updateSendButton();
    });
  });
}

function hideCommandAutocomplete() {
  if (autocompleteEl) {
    autocompleteEl.hidden = true;
    autocompleteSelectedIdx = -1;
  }
}

function navigateAutocomplete(direction) {
  if (!autocompleteEl || autocompleteEl.hidden) return false;
  const items = autocompleteEl.querySelectorAll('.command-item');
  if (items.length === 0) return false;

  items.forEach(it => it.classList.remove('selected'));
  autocompleteSelectedIdx += direction;
  if (autocompleteSelectedIdx < 0) autocompleteSelectedIdx = items.length - 1;
  if (autocompleteSelectedIdx >= items.length) autocompleteSelectedIdx = 0;

  items[autocompleteSelectedIdx].classList.add('selected');
  items[autocompleteSelectedIdx].scrollIntoView({ block: 'nearest' });
  return true;
}

function selectAutocompleteItem() {
  if (!autocompleteEl || autocompleteEl.hidden || autocompleteSelectedIdx < 0) return false;
  const items = autocompleteEl.querySelectorAll('.command-item');
  if (autocompleteSelectedIdx < items.length) {
    userInput.value = items[autocompleteSelectedIdx].dataset.cmd + ' ';
    hideCommandAutocomplete();
    autoResize(userInput);
    updateSendButton();
    return true;
  }
  return false;
}

// ── Context Menu ───────────────────────────────────────────────
let _contextMenuConvId = null;

function showContextMenu(event, convId) {
  _contextMenuConvId = convId;
  contextMenu.hidden = false;
  contextMenu.style.top = `${event.clientY}px`;
  contextMenu.style.left = `${event.clientX}px`;

  // Keep menu within viewport
  requestAnimationFrame(() => {
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      contextMenu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      contextMenu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  });
}

function hideContextMenu() {
  contextMenu.hidden = true;
  _contextMenuConvId = null;
}

document.addEventListener('click', () => hideContextMenu());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.conv-item')) hideContextMenu();
});

contextMenu.addEventListener('click', async (e) => {
  const action = e.target.dataset?.action;
  if (!action || !_contextMenuConvId) return;
  e.stopPropagation();
  const convId = _contextMenuConvId;
  hideContextMenu();

  if (action === 'rename') {
    const newTitle = prompt('Rename conversation:');
    if (newTitle && newTitle.trim()) {
      // Load full conversation to avoid overwriting messages
      const conv = await loadConversation(convId);
      if (conv) {
        conv.title = newTitle.trim();
        await autoSave(conv);
        refreshSidebar();
      }
    }
  } else if (action === 'move-folder') {
    const folders = getFolders();
    const folderList = folders.map((f, i) => `${i + 1}. ${f}`).join('\n');
    const choice = prompt(`Select folder number:\n${folderList}\n\nOr enter a new folder name:`);
    if (choice !== null) {
      const num = parseInt(choice);
      let selectedFolder = '';
      if (!isNaN(num) && num >= 1 && num <= folders.length) {
        selectedFolder = folders[num - 1];
      } else if (choice.trim()) {
        selectedFolder = choice.trim();
        createFolder(selectedFolder);
      }
      // Load full conversation to avoid overwriting messages
      const conv = await loadConversation(convId);
      if (conv) {
        conv.folder = selectedFolder;
        await autoSave(conv);
        refreshSidebar();
      }
    }
  } else if (action === 'delete') {
    await deleteStoredConversation(convId);
    if (convId === state.conversationId) {
      startNewConversation();
    }
    refreshSidebar();
  }
});

// ── System Prompt Templates ────────────────────────────────────
function populatePromptTemplates() {
  if (!promptTemplateSelect) return;
  promptTemplateSelect.innerHTML = '<option value="">Custom</option>';
  SYSTEM_PROMPT_TEMPLATES.forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = t.name;
    promptTemplateSelect.appendChild(opt);
  });
}

function syncPromptTemplate() {
  if (!promptTemplateSelect) return;
  const match = SYSTEM_PROMPT_TEMPLATES.findIndex((t) => t.prompt === state.settings.systemPrompt);
  promptTemplateSelect.value = match >= 0 ? String(match) : '';
}

if (promptTemplateSelect) {
  promptTemplateSelect.addEventListener('change', () => {
    const idx = parseInt(promptTemplateSelect.value);
    if (!isNaN(idx) && SYSTEM_PROMPT_TEMPLATES[idx]) {
      state.settings.systemPrompt = SYSTEM_PROMPT_TEMPLATES[idx].prompt;
      systemPromptInput.value = state.settings.systemPrompt;
    }
  });
}

// ── New Project Modal ───────────────────────────────────────────
function openNewProjectModal() {
  if (newProjectModal) {
    newProjectNameInput.value = '';
    openModal(newProjectModal, newFolderBtn);
    setTimeout(() => newProjectNameInput?.focus(), 100);
  }
}

function handleCreateProject() {
  const name = newProjectNameInput?.value?.trim();
  if (!name) return;
  const success = createFolder(name);
  closeModal(newProjectModal);
  if (success) {
    refreshSidebar();
    showToast(`Project "${name}" created`, 'success');
  } else {
    showToast(`Project "${name}" already exists`, 'error');
  }
}

if (newFolderBtn) {
  newFolderBtn.addEventListener('click', openNewProjectModal);
}

if (newProjectCreateBtn) {
  newProjectCreateBtn.addEventListener('click', handleCreateProject);
}

if (newProjectCancelBtn) {
  newProjectCancelBtn.addEventListener('click', () => closeModal(newProjectModal));
}

if (newProjectNameInput) {
  newProjectNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateProject();
    }
  });
}

// ── Delete Project Modal ────────────────────────────────────────
let _pendingDeleteFolder = null;

function openDeleteProjectModal(folderName) {
  _pendingDeleteFolder = folderName;
  if (deleteProjectNameEl) deleteProjectNameEl.textContent = folderName;
  openModal(deleteProjectModal, null);
}

if (deleteProjectConfirmBtn) {
  deleteProjectConfirmBtn.addEventListener('click', () => {
    if (_pendingDeleteFolder) {
      deleteFolder(_pendingDeleteFolder);
      showToast(`Project "${_pendingDeleteFolder}" deleted`, 'success');
      _pendingDeleteFolder = null;
      closeModal(deleteProjectModal);
      refreshSidebar();
    }
  });
}

if (deleteProjectCancelBtn) {
  deleteProjectCancelBtn.addEventListener('click', () => {
    _pendingDeleteFolder = null;
    closeModal(deleteProjectModal);
  });
}

// ── View Navigation ────────────────────────────────────────────────
function switchView(viewName) {
  const views = { chat: viewChat, playground: viewPlayground };
  for (const [name, el] of Object.entries(views)) {
    if (el) el.hidden = name !== viewName;
  }
  navTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === viewName);
  });
}

navTabs.forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

// ── Playground ─────────────────────────────────────────────────────
let playgroundHistoryData = [];

if (pgTemp) {
  pgTemp.addEventListener('input', () => {
    pgTempVal.textContent = pgTemp.value;
  });
}

if (playgroundRun) {
  playgroundRun.addEventListener('click', runPlayground);
}

if (playgroundClear) {
  playgroundClear.addEventListener('click', () => {
    playgroundHistoryData = [];
    renderPlaygroundHistory();
  });
}

async function runPlayground() {
  const prompt = playgroundPrompt.value.trim();
  if (!prompt) return;

  playgroundRun.disabled = true;
  playgroundRun.innerHTML = '<span class="pg-run-icon">⏳</span> Running...';
  playgroundOutput.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';

  try {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${location.host}/manager/ws/chat`;

    const requestPayload = {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: parseInt(pgMaxTokens.value) || 256,
      temperature: parseFloat(pgTemp.value) || 0.7,
    };

    let fullContent = '';
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;

      ws.onopen = () => {
        ws.send(JSON.stringify(requestPayload));
      };

      ws.onmessage = (event) => {
        if (settled) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === 'queued' && Number.isFinite(message.position)) {
          playgroundOutput.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div> <em class="text-muted">Queued (position ${message.position})</em>`;
          return;
        }

        if (message.type === 'delta' && message.delta) {
          fullContent += message.delta;
          playgroundOutput.innerHTML = renderMarkdown(fullContent);
          return;
        }

        if (message.type === 'done') {
          settled = true;
          ws.close(1000, 'complete');
          resolve();
          return;
        }

        if (message.type === 'error') {
          reject(new Error(message.message || 'WebSocket stream failed.'));
          ws.close(1011, 'error');
        }
      };

      ws.onclose = (event) => {
        if (settled) return;
        if (fullContent) {
          settled = true;
          resolve();
        } else {
          reject(new Error(event.reason || 'WebSocket connection closed unexpectedly.'));
        }
      };

      ws.onerror = () => {
        if (settled) return;
        reject(new Error('WebSocket connection failed.'));
      };
    });

    playgroundOutput.innerHTML = renderMarkdown(fullContent);

    // Add to history
    playgroundHistoryData.unshift({
      prompt,
      output: fullContent,
      temp: pgTemp.value,
      maxTokens: pgMaxTokens.value,
      timestamp: Date.now(),
    });
    if (playgroundHistoryData.length > 10) {
      playgroundHistoryData.pop();
    }
    renderPlaygroundHistory();
  } catch (err) {
    playgroundOutput.innerHTML = `<p class="text-danger">Error: ${err.message}</p>`;
  } finally {
    playgroundRun.disabled = false;
    playgroundRun.innerHTML = '<span class="pg-run-icon">▶</span> Run <kbd class="pg-kbd">Ctrl+Enter</kbd>';
  }
}

function renderPlaygroundHistory() {
  if (!playgroundHistory) return;
  playgroundHistory.innerHTML = '';
  if (playgroundHistoryData.length === 0) {
    playgroundHistory.innerHTML = '<em class="text-muted">No history yet</em>';
    return;
  }

  playgroundHistoryData.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'playground-history-item';
    div.innerHTML = `
      <div class="history-prompt">${escapeHtml(item.prompt.substring(0, 50))}${item.prompt.length > 50 ? '...' : ''}</div>
      <div class="history-meta">Temp: ${item.temp} • Max: ${item.maxTokens}</div>
    `;
    div.addEventListener('click', () => {
      playgroundPrompt.value = item.prompt;
      pgTemp.value = item.temp;
      pgTempVal.textContent = item.temp;
      pgMaxTokens.value = item.maxTokens;
      playgroundOutput.innerHTML = renderMarkdown(item.output);
    });
    playgroundHistory.appendChild(div);
  });
}

// ── Event Listeners ────────────────────────────────────────────

// Input
userInput.addEventListener('input', () => {
  autoResize(userInput);
  updateSendButton();
  // Command autocomplete
  const val = userInput.value;
  if (val.startsWith('/') && !val.includes('\n')) {
    showCommandAutocomplete(val);
  } else {
    hideCommandAutocomplete();
  }
});

userInput.addEventListener('keydown', (e) => {
  // Autocomplete navigation
  if (autocompleteEl && !autocompleteEl.hidden) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateAutocomplete(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateAutocomplete(-1);
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && autocompleteSelectedIdx >= 0)) {
      e.preventDefault();
      if (selectAutocompleteItem()) return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideCommandAutocomplete();
      return;
    }
  }

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

// ── Drag & Drop File Upload ────────────────────────────────────
const chatMain = document.querySelector('.chat-main') || chatContainer;

chatMain.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  chatMain.classList.add('drag-over');
});

chatMain.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  chatMain.classList.remove('drag-over');
});

chatMain.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  chatMain.classList.remove('drag-over');

  const files = Array.from(e.dataTransfer.files);
  files.forEach((file) => {
    if (file.size > MAX_FILE_SIZE) {
      alert(`File "${file.name}" exceeds 10MB limit.`);
      return;
    }
    if (state.attachedFiles.some((f) => f.name === file.name)) return;
    state.attachedFiles.push(file);
  });
  renderAttachedFiles();
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
systemPromptInput.addEventListener('change', () => {
  state.settings.systemPrompt = systemPromptInput.value;
  syncPromptTemplate();
});
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

// Analytics
analyticsBtn.addEventListener('click', () => {
  const summary = getAnalyticsSummary();
  analyticsContent.innerHTML = `
    <div class="analytics-card"><div class="label">Today</div><div class="value">${formatTokenCount(summary.today.total)}</div><div class="sub">${summary.today.count} requests</div></div>
    <div class="analytics-card"><div class="label">This Week</div><div class="value">${formatTokenCount(summary.week.total)}</div><div class="sub">${summary.week.count} requests</div></div>
    <div class="analytics-card"><div class="label">All Time</div><div class="value">${formatTokenCount(summary.allTime.total)}</div><div class="sub">${summary.allTime.count} requests</div></div>
    <div class="analytics-card"><div class="label">By Mode</div><div class="value">&nbsp;</div><div class="sub">TurboQuant: ${formatTokenCount(summary.byMode.turboquant)}<br>Standard: ${formatTokenCount(summary.byMode.standard)}</div></div>
  `;
  openModal(analyticsModal, analyticsBtn);
});
analyticsClose.addEventListener('click', () => closeModal(analyticsModal));
analyticsModal.addEventListener('click', (e) => { if (e.target === analyticsModal) closeModal(analyticsModal); });

// Voice input
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (!SpeechRecognition) {
  voiceBtn.hidden = true;
} else {
  voiceBtn.addEventListener('click', () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    const locale = state.settings.language === 'auto' ? (navigator.language || 'en-US') : state.settings.language;
    recognition.lang = locale;

    voiceBtn.classList.add('recording');

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      // Replace interim text: store the final length to avoid duplication
      if (!recognition._finalLen) recognition._finalLen = userInput.value.length;
      userInput.value = userInput.value.slice(0, recognition._finalLen) + transcript;
      autoResize(userInput);
      updateSendButton();

      // Update final length when results are final
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          recognition._finalLen = userInput.value.length;
        }
      }
    };

    recognition.onend = () => {
      voiceBtn.classList.remove('recording');
      recognition = null;
    };

    recognition.onerror = () => {
      voiceBtn.classList.remove('recording');
      recognition = null;
    };

    recognition.start();
  });
}

// Theme toggle
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  themeToggle.textContent = next === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19';
  localStorage.setItem('theme', next);
});

// Suggestions
document.querySelectorAll('.suggestion-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    sendMessage(chip.dataset.prompt);
  });
});

// ── Conversation Search (Ctrl+F in messages) ──────────────────
const msgSearchBar = $('#msg-search-bar');
const msgSearchInput = $('#msg-search-input');
const msgSearchCount = $('#msg-search-count');
const msgSearchPrev = $('#msg-search-prev');
const msgSearchNext = $('#msg-search-next');
const msgSearchClose = $('#msg-search-close');

let searchMatches = [];
let searchCurrentIdx = -1;

function clearSearchHighlights() {
  messagesEl.querySelectorAll('mark.search-highlight').forEach((mark) => {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  searchMatches = [];
  searchCurrentIdx = -1;
  msgSearchCount.textContent = '';
}

function highlightSearchMatches(query) {
  clearSearchHighlights();
  if (!query) return;

  const lowerQuery = query.toLowerCase();
  const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement.closest('.msg-search-bar')) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest('.message-content')) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  textNodes.forEach((textNode) => {
    const text = textNode.textContent;
    const lowerText = text.toLowerCase();
    let idx = lowerText.indexOf(lowerQuery);
    if (idx === -1) return;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;

    while (idx !== -1) {
      if (idx > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
      }
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      lastIdx = idx + query.length;
      idx = lowerText.indexOf(lowerQuery, lastIdx);
    }

    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }

    textNode.parentNode.replaceChild(frag, textNode);
  });

  searchMatches = Array.from(messagesEl.querySelectorAll('mark.search-highlight'));
  if (searchMatches.length > 0) {
    searchCurrentIdx = 0;
    searchMatches[0].classList.add('current');
    searchMatches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  msgSearchCount.textContent = searchMatches.length > 0
    ? `${searchCurrentIdx + 1}/${searchMatches.length}`
    : 'No results';
}

function navigateSearch(direction) {
  if (searchMatches.length === 0) return;
  searchMatches[searchCurrentIdx]?.classList.remove('current');
  searchCurrentIdx = (searchCurrentIdx + direction + searchMatches.length) % searchMatches.length;
  searchMatches[searchCurrentIdx].classList.add('current');
  searchMatches[searchCurrentIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
  msgSearchCount.textContent = `${searchCurrentIdx + 1}/${searchMatches.length}`;
}

function openMsgSearch() {
  msgSearchBar.hidden = false;
  msgSearchInput.focus();
  msgSearchInput.select();
}

function closeMsgSearch() {
  msgSearchBar.hidden = true;
  clearSearchHighlights();
  msgSearchInput.value = '';
}

let _msgSearchDebounce = null;
msgSearchInput.addEventListener('input', () => {
  clearTimeout(_msgSearchDebounce);
  _msgSearchDebounce = setTimeout(() => {
    highlightSearchMatches(msgSearchInput.value.trim());
  }, 200);
});

msgSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    navigateSearch(e.shiftKey ? -1 : 1);
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMsgSearch();
  }
});

msgSearchPrev.addEventListener('click', () => navigateSearch(-1));
msgSearchNext.addEventListener('click', () => navigateSearch(1));
msgSearchClose.addEventListener('click', closeMsgSearch);

// ── Markdown Preview in Input ──────────────────────────────────
const inputPreview = $('#input-preview');
const MD_PATTERN = /(`{1,3}|#{1,6}\s|\*{1,2}[^*]|\[.*\]\(|^>\s|^-\s|^\d+\.\s|~~|__)/m;

let _previewDebounce = null;
userInput.addEventListener('input', () => {
  clearTimeout(_previewDebounce);
  _previewDebounce = setTimeout(() => {
    const text = userInput.value;
    if (!text.trim() || !MD_PATTERN.test(text)) {
      inputPreview.hidden = true;
      inputPreview.innerHTML = '';
      return;
    }
    inputPreview.innerHTML = renderMarkdown(text);
    inputPreview.hidden = false;
  }, 300);
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
  // Ctrl+F / Cmd+F → open conversation search
  if ((event.ctrlKey || event.metaKey) && event.key === 'f' && state.messages.length > 0) {
    event.preventDefault();
    openMsgSearch();
    return;
  }

  if (event.key === 'Escape') {
    // Close message search first if open
    if (!msgSearchBar.hidden) {
      event.preventDefault();
      closeMsgSearch();
      return;
    }

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
// Restore theme preference
const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;
themeToggle.textContent = savedTheme === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19';

initShortcuts();
populateTimezones();
populatePromptTemplates();
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
checkShareUrl();

if (typeof mermaid !== 'undefined') {
  mermaid.initialize({ startOnLoad: false, theme: 'dark' });
}

// ── Service Worker Registration ────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
