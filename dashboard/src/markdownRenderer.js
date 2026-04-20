/**
 * Advanced Markdown Renderer for Chat Dashboard
 * XSS-safe rendering with code highlighting, LaTeX math, tables,
 * thinking blocks, mermaid diagrams, and streaming-safe partial parsing.
 *
 * External dependencies (loaded globally via CDN):
 *   - hljs       (highlight.js)
 *   - katex      (KaTeX)
 *   - mermaid    (Mermaid)
 */

// ── HTML entity escaping (XSS layer — runs FIRST) ─────────────

const ENTITY_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (ch) => ENTITY_MAP[ch]);
}

// ── Sentinel helpers ───────────────────────────────────────────
// We replace protected regions with unique sentinels so later regex
// passes don't corrupt them.

let _sentinelCounter = 0;
const _sentinels = new Map();

function sentinel(html) {
  const key = `\x00SENTINEL_${_sentinelCounter++}\x00`;
  _sentinels.set(key, html);
  return key;
}

function restoreSentinels(text) {
  let result = text;
  // Iterate until no sentinels remain (handles nested)
  let safety = 0;
  while (result.includes('\x00SENTINEL_') && safety++ < 200) {
    for (const [key, value] of _sentinels) {
      if (result.includes(key)) {
        result = result.split(key).join(value);
        _sentinels.delete(key);
      }
    }
  }
  return result;
}

// ── Thinking block extraction ──────────────────────────────────

/**
 * Strip <think>…</think> blocks, returning separated thinking and content.
 * Handles streaming where the closing tag may not yet exist.
 */
export function stripThinking(text) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const parts = [];
  let match;
  while ((match = thinkRegex.exec(text)) !== null) {
    parts.push(match[1].trim());
  }

  // Handle unclosed <think> at end of streaming text
  const unclosedMatch = text.match(/<think>([\s\S]*)$/i);
  if (unclosedMatch && !/<\/think>/i.test(unclosedMatch[0])) {
    parts.push(unclosedMatch[1].trim());
  }

  const content = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '') // remove unclosed trailing think
    .trim();

  return {
    thinking: parts.join('\n\n'),
    content,
  };
}

/**
 * Render thinking blocks as collapsible <details> elements.
 */
export function renderThinkingBlock(text) {
  const { thinking } = stripThinking(text);
  if (!thinking) return '';

  const rendered = renderInlineMarkdown(escapeHtml(thinking));
  return (
    '<details class="thinking-block">' +
    '<summary class="thinking-summary">💭 Thinking…</summary>' +
    `<div class="thinking-content">${rendered}</div>` +
    '</details>'
  );
}

// ── Code highlighting ──────────────────────────────────────────

/**
 * Syntax-highlight a code string. Falls back to escaped plain text.
 */
export function highlightCode(code, language) {
  const escaped = escapeHtml(code);

  if (typeof hljs === 'undefined') {
    return `<code class="hljs">${escaped}</code>`;
  }

  try {
    if (language && hljs.getLanguage(language)) {
      const result = hljs.highlight(code, { language, ignoreIllegals: true });
      return `<code class="hljs language-${escapeHtml(language)}">${result.value}</code>`;
    }
    const result = hljs.highlightAuto(code);
    return `<code class="hljs">${result.value}</code>`;
  } catch {
    return `<code class="hljs">${escaped}</code>`;
  }
}

// ── Fenced code blocks (``` … ```) ────────────────────────────

const MERMAID_ID_PREFIX = 'mermaid-';
let _mermaidCounter = 0;

function renderCodeBlocks(text) {
  // Match complete fenced code blocks
  return text.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const trimmed = code.replace(/\n$/, '');
      const langLower = lang.toLowerCase();

      // Mermaid diagram
      if (langLower === 'mermaid') {
        const id = `${MERMAID_ID_PREFIX}${_mermaidCounter++}`;
        const escapedCode = escapeHtml(trimmed);
        return sentinel(
          `<div class="mermaid-container">` +
          `<pre class="mermaid" id="${id}">${escapedCode}</pre>` +
          `</div>`
        );
      }

      const highlighted = highlightCode(trimmed, langLower || undefined);
      const langLabel = langLower ? `<span class="code-lang">${escapeHtml(langLower)}</span>` : '';
      return sentinel(
        `<div class="code-block-wrapper">` +
        `<div class="code-block-header">${langLabel}<button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-block-wrapper').querySelector('code').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button></div>` +
        `<pre class="code-block">${highlighted}</pre>` +
        `</div>`
      );
    }
  );
}

/**
 * Handle unclosed code blocks at end of streaming text.
 * Shows them as in-progress code blocks.
 */
function renderPartialCodeBlock(text) {
  const unclosedMatch = text.match(/```(\w*)\n([\s\S]*)$/);
  if (!unclosedMatch) return text;

  const lang = unclosedMatch[1].toLowerCase();
  const code = unclosedMatch[2];
  const highlighted = highlightCode(code, lang || undefined);
  const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';

  const before = text.slice(0, unclosedMatch.index);
  const block =
    `<div class="code-block-wrapper streaming">` +
    `<div class="code-block-header">${langLabel}<span class="streaming-indicator">…</span></div>` +
    `<pre class="code-block">${highlighted}</pre>` +
    `</div>`;

  return before + sentinel(block);
}

// ── LaTeX math rendering ───────────────────────────────────────

/**
 * Render LaTeX expressions using KaTeX.
 * Handles both $$block$$ and $inline$ math.
 */
export function renderMath(text) {
  if (typeof katex === 'undefined') return text;

  // Block math: $$…$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, expr) => {
    try {
      return sentinel(katex.renderToString(expr.trim(), {
        displayMode: true,
        throwOnError: false,
        output: 'htmlAndMathml',
      }));
    } catch {
      return `<span class="math-error">${escapeHtml(expr)}</span>`;
    }
  });

  // Inline math: $…$ (but not $$ and not inside words like price$10)
  text = text.replace(/(?<!\$|\w)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$|\d)/g, (_match, expr) => {
    try {
      return sentinel(katex.renderToString(expr.trim(), {
        displayMode: false,
        throwOnError: false,
        output: 'htmlAndMathml',
      }));
    } catch {
      return `<span class="math-error">${escapeHtml(expr)}</span>`;
    }
  });

  return text;
}

// ── Markdown tables ────────────────────────────────────────────

/**
 * Parse and render a markdown table string to HTML <table>.
 */
export function renderTable(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return text;

  const parseRow = (line) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  // Detect alignment row (second line with ---/:--- etc.)
  const isSeparator = (line) => /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);

  if (!isSeparator(lines[1])) return text;

  const headers = parseRow(lines[0]);
  const aligns = parseRow(lines[1]).map((cell) => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return 'left';
  });

  let html = '<div class="table-wrapper"><table class="md-table"><thead><tr>';
  for (let i = 0; i < headers.length; i++) {
    const align = aligns[i] || 'left';
    html += `<th style="text-align:${align}">${renderInlineMarkdown(headers[i])}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (let r = 2; r < lines.length; r++) {
    if (!lines[r].trim()) continue;
    const cells = parseRow(lines[r]);
    html += '<tr>';
    for (let i = 0; i < headers.length; i++) {
      const align = aligns[i] || 'left';
      const cellContent = cells[i] !== undefined ? cells[i] : '';
      html += `<td style="text-align:${align}">${renderInlineMarkdown(cellContent)}</td>`;
    }
    html += '</tr>';
  }

  html += '</tbody></table></div>';
  return html;
}

function renderTables(text) {
  // Match blocks of lines that look like a table
  return text.replace(
    /((?:^\|.+\|$\n?){2,})/gm,
    (tableBlock) => sentinel(renderTable(tableBlock))
  );
}

// ── Inline markdown transforms ─────────────────────────────────

function renderInlineMarkdown(text) {
  // Inline code (protect first)
  text = text.replace(/`([^`]+)`/g, (_m, code) =>
    sentinel(`<code class="inline-code">${escapeHtml(code)}</code>`)
  );

  // Bold + italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Auto-linkify URLs (http/https)
  text = text.replace(
    /(?<!")(?<!')\b(https?:\/\/[^\s<>\])"']+)/g,
    (url) => {
      const safeUrl = escapeHtml(url);
      return sentinel(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`);
    }
  );

  return text;
}

// ── Block-level markdown ───────────────────────────────────────

function renderBlockElements(text) {
  const lines = text.split('\n');
  const result = [];
  let inList = false;
  let listType = null;
  let listItems = [];

  function flushList() {
    if (!inList) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    result.push(`<${tag}>${listItems.join('')}</${tag}>`);
    listItems = [];
    inList = false;
    listType = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headings
    const headingMatch = line.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      result.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim()) || /^_{3,}$/.test(line.trim())) {
      flushList();
      result.push('<hr>');
      continue;
    }

    // Blockquote
    if (line.startsWith('&gt; ') || line.startsWith('&gt;')) {
      flushList();
      const quoteContent = line.replace(/^&gt;\s?/, '');
      // Collect consecutive blockquote lines
      let quoteBlock = quoteContent;
      while (i + 1 < lines.length && (lines[i + 1].startsWith('&gt; ') || lines[i + 1].startsWith('&gt;'))) {
        i++;
        quoteBlock += '\n' + lines[i].replace(/^&gt;\s?/, '');
      }
      result.push(`<blockquote>${renderInlineMarkdown(quoteBlock)}</blockquote>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        flushList();
        inList = true;
        listType = 'ul';
      }
      listItems.push(`<li>${renderInlineMarkdown(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        flushList();
        inList = true;
        listType = 'ol';
      }
      listItems.push(`<li>${renderInlineMarkdown(olMatch[2])}</li>`);
      continue;
    }

    // Regular line
    flushList();
    if (line.trim() === '') {
      result.push('');
    } else {
      result.push(renderInlineMarkdown(line));
    }
  }

  flushList();
  return result.join('\n');
}

// ── Paragraph wrapping ─────────────────────────────────────────

function wrapParagraphs(html) {
  // Split on double newlines and wrap plain text groups in <p>
  const blocks = html.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      // Don't wrap if it's already a block-level element
      if (/^<(?:h[1-6]|ul|ol|li|blockquote|hr|pre|div|table|details|p)/i.test(trimmed)) {
        return trimmed;
      }
      // Don't wrap sentinels that resolve to block elements
      if (/^\x00SENTINEL_\d+\x00$/.test(trimmed)) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

// ── Mermaid post-render ────────────────────────────────────────

function triggerMermaidRender() {
  if (typeof mermaid === 'undefined') return;
  try {
    mermaid.run({ querySelector: '.mermaid:not([data-processed])' });
  } catch {
    // silently ignore — mermaid may not be initialized yet
  }
}

// ── Main render pipeline ───────────────────────────────────────

/**
 * Render a markdown string (typically an LLM response) to safe HTML.
 * Handles streaming partial text gracefully.
 *
 * @param {string} text  Raw markdown text
 * @returns {string}     Sanitized HTML string
 */
export function renderMarkdown(text) {
  if (!text) return '';

  // Reset sentinels for this render pass
  _sentinelCounter = 0;
  _sentinels.clear();

  // 1. Extract thinking blocks
  const thinkingHtml = renderThinkingBlock(text);
  const { content } = stripThinking(text);

  // 2. Escape HTML entities FIRST (XSS protection)
  let html = escapeHtml(content);

  // 3. Fenced code blocks (before other transforms to protect contents)
  html = renderCodeBlocks(html);
  html = renderPartialCodeBlock(html);

  // 4. Math rendering (before inline transforms eat the $)
  html = renderMath(html);

  // 5. Tables
  html = renderTables(html);

  // 6. Block-level elements (headings, lists, blockquotes, hr)
  html = renderBlockElements(html);

  // 7. Paragraph wrapping
  html = wrapParagraphs(html);

  // 8. Restore all protected regions
  html = restoreSentinels(html);

  // 9. Prepend thinking block if present
  if (thinkingHtml) {
    html = thinkingHtml + html;
  }

  // 10. Schedule mermaid rendering (next tick so DOM is updated)
  queueMicrotask(triggerMermaidRender);

  return html;
}
