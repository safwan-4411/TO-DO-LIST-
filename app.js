'use strict';

/* ===========================
   SUPABASE
=========================== */
let sb = null;
let currentUser = null;

function initSupabase() {
  const cfg = window.TASKR_SUPABASE;
  if (cfg && cfg.url && cfg.anon) {
    try { sb = supabase.createClient(cfg.url, cfg.anon); } catch (e) { console.warn('Supabase init failed', e); }
  }
}

/* ===========================
   PWA INSTALL
=========================== */
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('install-btn');
  if (btn) btn.classList.remove('hidden');
  const btnL = document.getElementById('install-btn-landing');
  if (btnL) btnL.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('install-btn');
  if (btn) btn.classList.add('hidden');
});

function handleInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => { deferredInstallPrompt = null; });
}

/* ===========================
   LOCAL STORAGE
=========================== */
const LS_TASKS = 'taskr_tasks';
const LS_PAGE  = 'taskr_page';

function getTasks()  { try { return JSON.parse(localStorage.getItem(LS_TASKS)) || []; } catch { return []; } }
function saveTasks(t) { localStorage.setItem(LS_TASKS, JSON.stringify(t)); }

/* ===========================
   UTILITIES
=========================== */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function formatDateLong(s) {
  return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function formatDateShort(s) {
  return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ===========================
   TASK OPERATIONS
=========================== */
function getActiveTasks()   { return getTasks().filter(t => !t.archived); }
function getArchivedTasks() { return getTasks().filter(t =>  t.archived); }

function addTask(text) {
  const tasks = getTasks();
  const task = {
    id: uid(), text: text.trim(),
    status: 'pending', // pending | done | undone
    reason: '',
    task_date: todayStr(),
    archived: false,
    history_date: null,
    carried_from: null,
    created_at: new Date().toISOString(),
  };
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

function toggleDone(id) {
  const tasks = getTasks();
  const task = tasks.find(t => t.id === id);
  if (!task || task.archived) return;
  if (task.status === 'done') {
    task.status = 'pending';
  } else {
    task.status = 'done';
    task.reason = '';
  }
  saveTasks(tasks);
  renderRoute();
}

function setReason(id, reason) {
  if (!reason || !reason.trim()) return;
  const tasks = getTasks();
  const task = tasks.find(t => t.id === id);
  if (!task || task.archived) return;
  task.reason = reason.trim();
  task.status = 'undone';
  saveTasks(tasks);
  renderRoute();
}

function clearReason(id) {
  const tasks = getTasks();
  const task = tasks.find(t => t.id === id);
  if (!task || task.archived) return;
  task.reason = '';
  task.status = 'pending';
  saveTasks(tasks);
  renderRoute();
}

function deleteTask(id) {
  saveTasks(getTasks().filter(t => t.id !== id));
  renderRoute();
}

function endDay() {
  const tasks = getTasks();
  const dateKey = todayStr();
  const newCarried = [];

  tasks.forEach(task => {
    if (task.archived) return;
    task.archived = true;
    task.history_date = dateKey;
    // pending or undone → carry forward as a fresh task
    if (task.status !== 'done') {
      newCarried.push({
        id: uid(), text: task.text,
        status: 'pending', reason: '',
        task_date: dateKey,
        archived: false, history_date: null,
        carried_from: task.id,
        created_at: new Date().toISOString(),
      });
    }
  });

  tasks.push(...newCarried);
  saveTasks(tasks);

  const done    = tasks.filter(t => t.archived && t.history_date === dateKey && t.status === 'done').length;
  const undone  = tasks.filter(t => t.archived && t.history_date === dateKey && t.status === 'undone').length;
  const pending = tasks.filter(t => t.archived && t.history_date === dateKey && t.status === 'pending').length;
  return { done, undone, pending, carried: newCarried.length };
}

/* ===========================
   CLOUD SYNC (optional)
=========================== */
async function syncAll() {
  if (!sb || !currentUser) return;
  try {
    const tasks = getTasks();
    if (!tasks.length) return;
    const rows = tasks.map(t => ({
      task_id: t.id, user_id: currentUser.id,
      text: t.text, status: t.status, reason: t.reason || '',
      task_date: t.task_date, archived: t.archived,
      history_date: t.history_date, carried_from: t.carried_from,
    }));
    await sb.from('tasks').upsert(rows, { onConflict: 'task_id' });
  } catch (e) { console.warn('Sync failed', e); }
}

async function loadFromCloud() {
  if (!sb || !currentUser) return;
  try {
    const { data, error } = await sb.from('tasks').select('*').eq('user_id', currentUser.id);
    if (error || !data || !data.length) return;
    const tasks = data.map(r => ({
      id: r.task_id, text: r.text, status: r.status,
      reason: r.reason || '', task_date: r.task_date,
      archived: r.archived, history_date: r.history_date,
      carried_from: r.carried_from, created_at: r.created_at,
    }));
    saveTasks(tasks);
  } catch (e) { console.warn('Load failed', e); }
}

/* ===========================
   AUTH
=========================== */
async function signInWithGoogle() {
  if (!sb) { showApp(); return; }
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });
  if (error) showToast('Sign-in error: ' + error.message);
}

async function signOut() {
  if (sb) await sb.auth.signOut();
  currentUser = null;
  renderLanding();
}

/* ===========================
   VIEWS
=========================== */
function showApp() {
  document.getElementById('landing').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  renderRoute();
}

function renderLanding() {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('landing').classList.remove('hidden');

  const navRight = document.getElementById('landing-nav-right');
  const cta = document.getElementById('landing-cta-row');

  if (currentUser) {
    const name = currentUser.user_metadata?.full_name || currentUser.email || 'User';
    navRight.innerHTML = `
      <span style="font-size:13px;color:var(--muted-1)">${esc(name)}</span>
      <button class="btn-outline btn-sm" onclick="signOut()">Sign out</button>
    `;
    cta.innerHTML = `<button class="btn-primary btn-lg" onclick="showApp()">Open App</button>`;
  } else {
    navRight.innerHTML = `<button class="btn-outline btn-sm" onclick="showApp()">Use Offline</button>`;
    cta.innerHTML = `
      <button class="google-btn" onclick="signInWithGoogle()">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
        Continue with Google
      </button>
      <button class="btn-outline btn-lg" onclick="showApp()">Use Without Login</button>
    `;
  }
}

/* ===========================
   ROUTING
=========================== */
let currentPage = 'today';

function navTo(page) {
  currentPage = page;
  localStorage.setItem(LS_PAGE, page);
  renderRoute();
}

function renderRoute() {
  ['today', 'history'].forEach(p => {
    document.getElementById('page-' + p).classList.toggle('hidden', currentPage !== p);
  });
  renderNav();
  if (currentPage === 'today')   renderToday();
  if (currentPage === 'history') renderHistory();
}

/* ===========================
   NAV
=========================== */
const NAV_ITEMS = [
  { id: 'today',   label: 'Today',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>` },
  { id: 'history', label: 'History',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/></svg>` },
];

function renderNav() {
  const html = NAV_ITEMS.map(n => `
    <button class="nav-item ${currentPage === n.id ? 'active' : ''}" onclick="navTo('${n.id}')">
      ${n.icon} ${n.label}
    </button>
  `).join('');
  document.getElementById('main-nav').innerHTML = html;
  document.getElementById('mobile-nav').innerHTML = html;

  // User badge
  const badge = document.getElementById('user-badge');
  if (currentUser) {
    const name = currentUser.user_metadata?.full_name || currentUser.email || 'U';
    const avatar = currentUser.user_metadata?.avatar_url;
    badge.classList.remove('hidden');
    badge.innerHTML = avatar
      ? `<img src="${esc(avatar)}" title="Sign out — ${esc(name)}" onclick="signOut()" />`
      : `<div class="avatar-initials" onclick="signOut()" title="Sign out">${esc(name[0].toUpperCase())}</div>`;
  } else {
    badge.classList.add('hidden');
  }
}

/* ===========================
   TODAY PAGE
=========================== */
function renderToday() {
  const el = document.getElementById('page-today');
  const active = getActiveTasks();
  const total  = active.length;
  const done   = active.filter(t => t.status === 'done').length;
  const pct    = total > 0 ? Math.round((done / total) * 100) : 0;

  // Sort: pending & undone first, done at bottom
  const sorted = [
    ...active.filter(t => t.status === 'undone'),
    ...active.filter(t => t.status === 'pending'),
    ...active.filter(t => t.status === 'done'),
  ];

  el.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Today</h1>
        <div class="page-subtitle">${esc(formatDateLong(todayStr()))}</div>
      </div>
      <div class="page-header-actions">
        ${total > 0 ? `<span class="mono small muted-2">${done}/${total}</span>` : ''}
        ${total > 0 ? `<button class="btn-danger btn-sm" onclick="confirmEndDay()">End Day</button>` : ''}
      </div>
    </div>

    <div class="add-task-row">
      <input
        type="text" id="new-task-input" class="task-input"
        placeholder="Add a task and press Enter…"
        onkeydown="if(event.key==='Enter')submitNewTask()"
        autocomplete="off"
      />
      <button class="btn-primary btn-sm" onclick="submitNewTask()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add
      </button>
    </div>

    ${total > 0 ? `
      <div class="progress-bar-wrap">
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <span class="progress-label mono">${pct}% done</span>
      </div>
    ` : ''}

    ${sorted.length === 0 ? `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted-3);margin-bottom:16px"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 11 12 14 22 4"/></svg>
        <p>Nothing here yet — add your first task above.</p>
      </div>
    ` : `
      <div class="tasks-list">
        ${sorted.map(t => renderTaskCard(t)).join('')}
      </div>
    `}
  `;
}

function renderTaskCard(task) {
  const isDone   = task.status === 'done';
  const isUndone = task.status === 'undone';
  const carried  = task.carried_from
    ? `<span class="carried-badge">carried</span>`
    : '';

  let checkClass = '';
  let checkIcon  = '';
  if (isDone) {
    checkClass = 'checked';
    checkIcon  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  } else if (isUndone) {
    checkClass = 'check-btn-x';
    checkIcon  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  }

  return `
    <div class="task-card ${isDone ? 'task-done' : ''} ${isUndone ? 'task-undone' : ''}">
      <div class="task-main">
        <button class="check-btn ${checkClass}" onclick="toggleDone('${esc(task.id)}')" title="${isDone ? 'Mark undone' : 'Mark done'}">
          ${checkIcon}
        </button>
        <span class="task-text">${esc(task.text)}${carried}</span>
        <button class="icon-btn task-del" onclick="deleteTask('${esc(task.id)}')" title="Delete task">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
      ${!isDone ? `
        <div class="reason-row">
          ${isUndone && task.reason ? `
            <div class="reason-set">
              <span class="reason-text">"${esc(task.reason)}"</span>
              <button class="reason-clear" onclick="clearReason('${esc(task.id)}')">clear</button>
            </div>
          ` : `
            <input
              type="text"
              class="reason-input"
              placeholder="Reason for skipping… (press Enter to set)"
              onkeydown="if(event.key==='Enter'&&this.value.trim()){setReason('${esc(task.id)}',this.value);this.value='';}"
            />
          `}
        </div>
      ` : ''}
    </div>
  `;
}

function submitNewTask() {
  const input = document.getElementById('new-task-input');
  const text  = input ? input.value.trim() : '';
  if (!text) return;
  addTask(text);
  input.value = '';
  renderRoute();
  document.getElementById('new-task-input')?.focus();
}

/* ===========================
   END DAY MODAL
=========================== */
const _modalActions = {};

function confirmEndDay() {
  const active  = getActiveTasks();
  const done    = active.filter(t => t.status === 'done').length;
  const undone  = active.filter(t => t.status === 'undone').length;
  const pending = active.filter(t => t.status === 'pending').length;

  openModal('End of Day', `
    <p style="font-size:13px;color:var(--muted-1);margin-bottom:18px;line-height:1.6">
      Here's your summary for today. Incomplete and pending tasks will be carried forward to tomorrow.
    </p>
    <div class="endday-summary">
      <div class="summary-item">
        <span class="summary-dot green"></span>
        <span class="summary-count accent-green">${done}</span>
        <span style="font-size:14px;color:var(--muted-1)">completed — archived ✓</span>
      </div>
      <div class="summary-item">
        <span class="summary-dot red"></span>
        <span class="summary-count accent-red">${undone}</span>
        <span style="font-size:14px;color:var(--muted-1)">incomplete (with reason) — carried forward</span>
      </div>
      <div class="summary-item">
        <span class="summary-dot grey"></span>
        <span class="summary-count" style="color:var(--muted-1)">${pending}</span>
        <span style="font-size:14px;color:var(--muted-1)">pending (no action) — carried forward</span>
      </div>
    </div>
  `, [
    { label: 'End Day', cls: 'btn-primary', key: 'end' },
    { label: 'Cancel',  cls: 'btn-secondary', key: 'cancel' },
  ]);

  _modalActions['end']    = () => { doEndDay(); closeModal(); };
  _modalActions['cancel'] = closeModal;
}

function doEndDay() {
  const res = endDay();
  syncAll();
  renderRoute();
  showToast(`Day ended — ${res.done} done · ${res.carried} carried forward`);
}

/* ===========================
   HISTORY PAGE
=========================== */
function renderHistory() {
  const el       = document.getElementById('page-history');
  const archived = getArchivedTasks();

  // Group by history_date
  const byDate = {};
  archived.forEach(t => {
    const d = t.history_date || t.task_date;
    (byDate[d] = byDate[d] || []).push(t);
  });
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  el.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">History</h1>
        <div class="page-subtitle">Past day-end archives</div>
      </div>
    </div>
    ${dates.length === 0 ? `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted-3);margin-bottom:16px"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/></svg>
        <p>No history yet. Complete your first day by tapping "End Day".</p>
      </div>
    ` : `
      <div class="history-list">
        ${dates.map(date => {
          const tasks   = byDate[date];
          const done    = tasks.filter(t => t.status === 'done').length;
          const undone  = tasks.filter(t => t.status === 'undone').length;
          const pending = tasks.filter(t => t.status === 'pending').length;
          const order   = { done: 0, undone: 1, pending: 2 };
          const sorted  = [...tasks].sort((a,b) => (order[a.status]||2) - (order[b.status]||2));

          return `
            <div class="history-day">
              <div class="history-day-header">
                <span class="history-date">${esc(formatDateShort(date))}</span>
                <div class="history-stats">
                  ${done    > 0 ? `<span class="hist-badge green">${done} done</span>` : ''}
                  ${undone  > 0 ? `<span class="hist-badge red">${undone} skipped</span>` : ''}
                  ${pending > 0 ? `<span class="hist-badge grey">${pending} carried</span>` : ''}
                </div>
              </div>
              <div class="history-tasks">
                ${sorted.map(t => {
                  const cls = t.status;
                  let icon = '';
                  if (t.status === 'done')    icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
                  else if (t.status === 'undone') icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
                  else icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 8 12 12 14 14"/></svg>`;
                  const textCls = cls === 'done' ? 'done-text' : cls === 'undone' ? 'undone-text' : 'pending-text';
                  return `
                    <div class="history-task ${cls}">
                      <span class="hist-icon">${icon}</span>
                      <div class="hist-task-body">
                        <span class="hist-task-text ${textCls}">${esc(t.text)}</span>
                        ${t.reason ? `<span class="hist-reason">"${esc(t.reason)}"</span>` : ''}
                        ${t.carried_from ? `<span class="hist-carried">↑ carried forward</span>` : ''}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `}
  `;
}

/* ===========================
   MODAL
=========================== */
function openModal(title, body, buttons = []) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = buttons.map(b =>
    `<button class="${b.cls}" onclick="_modalActions['${b.key}']()">${b.label}</button>`
  ).join('');
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-backdrop')) return;
  document.getElementById('modal-backdrop').classList.add('hidden');
}

/* ===========================
   TOAST
=========================== */
let _toastTimer;
function showToast(msg, ms = 3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ===========================
   INIT
=========================== */
async function init() {
  initSupabase();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Restore page
  currentPage = localStorage.getItem(LS_PAGE) || 'today';

  if (sb) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session?.user) {
        currentUser = session.user;
        await loadFromCloud();
        showApp();
        return;
      }
      sb.auth.onAuthStateChange(async (event, session) => {
        if (session?.user) {
          currentUser = session.user;
          await loadFromCloud();
          showApp();
        }
      });
    } catch (e) { console.warn('Auth check failed', e); }
  }

  // If tasks exist, go straight to app
  if (getTasks().length > 0) { showApp(); return; }
  renderLanding();
}

document.addEventListener('DOMContentLoaded', init);
