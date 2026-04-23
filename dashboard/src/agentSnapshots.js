/**
 * agentSnapshots.js — Workspace versioning/snapshots UI for agent rooms.
 * Renders a compact snapshot list inside the workspace sidebar.
 */

import { listAgentRoomSnapshots, createAgentRoomSnapshot, deleteAgentRoomSnapshot, getAgentRoomSnapshot } from './authClient.js';
import { rs, escapeHtml } from './roomsUtils.js';
import { showToast } from './utils.js';

let _snapshots = [];
let _loading = false;

function formatSnapshotTime(ts) {
  if (!ts) return '';
  const ms = Number(ts) < 1e11 ? Number(ts) * 1000 : Number(ts);
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function renderSnapshotSection(container) {
  if (!container) return;

  const html = `
    <details class="snapshot-section" open>
      <summary class="snapshot-header">
        <span>📸 Snapshots</span>
        <span class="snapshot-count">${_snapshots.length}</span>
      </summary>
      <div class="snapshot-body">
        <div class="snapshot-create-row">
          <input type="text" class="snapshot-label-input" placeholder="Snapshot label…" maxlength="120" />
          <button type="button" class="snapshot-create-btn" title="Create snapshot">📷</button>
        </div>
        <div class="snapshot-list">
          ${_loading ? '<div class="snapshot-loading">Loading…</div>' : ''}
          ${!_loading && _snapshots.length === 0 ? '<div class="snapshot-empty">No snapshots yet</div>' : ''}
          ${_snapshots.map(s => `
            <div class="snapshot-item" data-id="${escapeHtml(s.id)}">
              <div class="snapshot-item-top">
                <span class="snapshot-item-label" title="${escapeHtml(s.description || s.label)}">${escapeHtml(s.label)}</span>
                <button type="button" class="snapshot-delete-btn" data-id="${escapeHtml(s.id)}" title="Delete">×</button>
              </div>
              <div class="snapshot-item-meta">
                <span>${s.file_count} files</span>
                <span>${formatSize(s.total_size)}</span>
                <span>${formatSnapshotTime(s.created_at)}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </details>
  `;

  // Find or create the snapshot container
  let section = container.querySelector('.snapshot-section-wrapper');
  if (!section) {
    section = document.createElement('div');
    section.className = 'snapshot-section-wrapper';
    container.appendChild(section);
  }
  section.innerHTML = html;

  // Bind create
  const input = section.querySelector('.snapshot-label-input');
  const createBtn = section.querySelector('.snapshot-create-btn');
  if (createBtn && input) {
    createBtn.addEventListener('click', () => handleCreateSnapshot(input, container));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleCreateSnapshot(input, container);
    });
  }

  // Bind delete
  section.querySelectorAll('.snapshot-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteSnapshot(btn.dataset.id, container);
    });
  });

  // Bind detail view on click
  section.querySelectorAll('.snapshot-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.snapshot-delete-btn')) return;
      handleViewSnapshot(item.dataset.id, container);
    });
  });
}

async function handleCreateSnapshot(input, container) {
  const label = input.value.trim();
  if (!label) { showToast('Enter a snapshot label', 'error'); return; }
  if (!rs.currentAgentRoomId) return;

  try {
    input.disabled = true;
    await createAgentRoomSnapshot(rs.currentAgentRoomId, label);
    input.value = '';
    showToast('Snapshot created');
    await loadSnapshots(container);
  } catch (err) {
    showToast(err.message || 'Failed to create snapshot', 'error');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function handleDeleteSnapshot(snapshotId, container) {
  if (!rs.currentAgentRoomId || !snapshotId) return;
  try {
    await deleteAgentRoomSnapshot(rs.currentAgentRoomId, snapshotId);
    showToast('Snapshot deleted');
    await loadSnapshots(container);
  } catch (err) {
    showToast(err.message || 'Failed to delete snapshot', 'error');
  }
}

async function handleViewSnapshot(snapshotId, container) {
  if (!rs.currentAgentRoomId || !snapshotId) return;
  try {
    const data = await getAgentRoomSnapshot(rs.currentAgentRoomId, snapshotId);
    const snapshot = data?.snapshot;
    if (!snapshot) return;

    const files = snapshot.snapshot_data?.files || [];
    const detail = container.querySelector('.snapshot-detail-overlay');
    if (detail) detail.remove();

    const overlay = document.createElement('div');
    overlay.className = 'snapshot-detail-overlay';
    overlay.innerHTML = `
      <div class="snapshot-detail-header">
        <strong>${escapeHtml(snapshot.label)}</strong>
        <button type="button" class="snapshot-detail-close" title="Close">×</button>
      </div>
      ${snapshot.description ? `<div class="snapshot-detail-desc">${escapeHtml(snapshot.description)}</div>` : ''}
      <div class="snapshot-detail-meta">${files.length} files · ${formatSize(snapshot.total_size)} · by ${escapeHtml(snapshot.created_by || 'unknown')}</div>
      <div class="snapshot-detail-files">
        ${files.map(f => `<div class="snapshot-file-row"><span>📄 ${escapeHtml(f.path)}</span><span>${formatSize(f.size)}</span></div>`).join('')}
        ${files.length === 0 ? '<div class="snapshot-empty">No files recorded</div>' : ''}
      </div>
    `;
    container.querySelector('.snapshot-section-wrapper')?.appendChild(overlay);

    overlay.querySelector('.snapshot-detail-close')?.addEventListener('click', () => overlay.remove());
  } catch (err) {
    showToast(err.message || 'Failed to load snapshot', 'error');
  }
}

export async function loadSnapshots(container) {
  if (!rs.currentAgentRoomId) { _snapshots = []; renderSnapshotSection(container); return; }
  _loading = true;
  renderSnapshotSection(container);
  try {
    const data = await listAgentRoomSnapshots(rs.currentAgentRoomId);
    _snapshots = data?.snapshots || [];
  } catch {
    _snapshots = [];
  }
  _loading = false;
  renderSnapshotSection(container);
}

export function clearSnapshots() {
  _snapshots = [];
}
