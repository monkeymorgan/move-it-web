// Move It — movement break reminders + exercise flows. No build step; plain ES module.
/* global jsyaml */

// ---------------------------------------------------------------- storage
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('moveit.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('moveit.' + key, JSON.stringify(value)); } catch { /* private mode etc. */ }
  },
};

const DEFAULT_SETTINGS = {
  enabled: true,
  intervalMin: 30,
  workStart: '09:00',
  workEnd: '17:30',
  workDays: [1, 2, 3, 4, 5],
  notify: true,
  sound: true,
  snoozeMin: 5,
  onlyCurated: false,
  includeKit: false,
  posture: 'sitting',
};
let settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

// timer: { nextAt, due, suggestionId, manual }
let timer = store.get('timer', { nextAt: 0, due: false, suggestionId: null });
const saveTimer = () => store.set('timer', timer);
let recent = store.get('recent', []);
let log = store.get('log', []);
let curationOverrides = store.get('curation', {});

// ---------------------------------------------------------------- data
let EX = [];          // exercises
let EX_BY_ID = {};
let FLOWS = [];
let TIPS = {};
let BASE_CURATION = {};

async function loadYaml(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return jsyaml.load(await res.text());
}

async function loadData() {
  const [ex, flows, cur, tips] = await Promise.all([
    loadYaml('data/exercises.yaml'), loadYaml('data/flows.yaml'),
    loadYaml('data/curation.yaml'), loadYaml('data/tips.yaml'),
  ]);
  EX = ex.map(e => ({ ...e, aka: [].concat(e.aka || []), targets: e.targets || [], images: e.images || [], tips: [].concat(e.tips || []) }));
  EX_BY_ID = Object.fromEntries(EX.map(e => [e.id, e]));
  FLOWS = flows;
  TIPS = tips;
  BASE_CURATION = {};
  for (const status of ['star', 'keep', 'drop']) for (const id of (cur?.[status] || [])) BASE_CURATION[id] = status;
}

const statusOf = id => curationOverrides[id] || BASE_CURATION[id] || 'unsorted';
function setStatus(id, status) {
  if ((BASE_CURATION[id] || 'unsorted') === status) delete curationOverrides[id];
  else curationOverrides[id] = status;
  store.set('curation', curationOverrides);
}

function resolveStep(step) {
  if (typeof step === 'string') step = { id: step };
  if (step.id) {
    const ex = EX_BY_ID[step.id];
    if (!ex) return { title: `Unknown exercise: ${step.id}`, seconds: step.seconds || 30, missing: true };
    return { ex, title: ex.title, seconds: step.seconds || ex.seconds || 30, note: step.note, dose: ex.dose };
  }
  return { title: step.text, seconds: step.seconds || 30, note: step.note };
}

// ---------------------------------------------------------------- helpers
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtClock = sec => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function thumb(ex, cls = '') {
  const img = ex?.images?.[0];
  return img
    ? `<div class="thumb ${cls}"><img src="img/${esc(img)}" alt="${esc(ex.title)}" loading="lazy"></div>`
    : `<div class="thumb empty ${cls}" aria-hidden="true">${typeIcon(ex?.type)}</div>`;
}
const typeIcon = t => ({ stretch: '🧘', mobility: '🔄', strength: '💪', balance: '🦩', cardio: '🏃', breathing: '🌬️', eyes: '👀', test: '📏' }[t] || '🤸');

function pills(ex) {
  const st = statusOf(ex.id);
  const out = [];
  if (st !== 'unsorted') out.push(`<span class="pill ${st}">${st === 'star' ? '★ star' : st}</span>`);
  if (ex.mode) out.push(`<span class="pill">${esc(ex.mode)}</span>`);
  if (ex.type) out.push(`<span class="pill">${esc(ex.type)}</span>`);
  if (ex.desk) out.push(`<span class="pill">desk</span>`);
  return out.join('');
}

function curationButtons(id) {
  const st = statusOf(id);
  return `<div class="row">
    <button class="star" data-action="curate" data-id="${esc(id)}" data-status="star" aria-pressed="${st === 'star'}">★ Star</button>
    <button data-action="curate" data-id="${esc(id)}" data-status="keep" aria-pressed="${st === 'keep'}">Keep</button>
    <button class="drop" data-action="curate" data-id="${esc(id)}" data-status="drop" aria-pressed="${st === 'drop'}">Drop</button>
    ${st !== 'unsorted' ? `<button class="ghost" data-action="curate" data-id="${esc(id)}" data-status="unsorted">Clear</button>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- sound + notifications
let audioCtx;
function chime(times = 2) {
  if (!settings.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [660, 880, 990].slice(0, times + 1).forEach((freq, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, now + i * 0.18);
      g.gain.linearRampToValueAtTime(0.18, now + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.18 + 0.6);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + i * 0.18); o.stop(now + i * 0.18 + 0.65);
    });
  } catch { /* no audio */ }
}
// browsers only allow audio after a user gesture — warm the context on the first click
document.addEventListener('pointerdown', () => { if (!audioCtx) try { audioCtx = new AudioContext(); } catch {} }, { once: true });

const notifSupported = 'Notification' in window;
function notify(title, body) {
  if (!settings.notify || !notifSupported || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: 'moveit-break', requireInteraction: true, renotify: true });
    n.onclick = () => { window.focus(); location.hash = '#/now'; n.close(); };
  } catch { /* some browsers need a service worker for notifications */ }
}

// ---------------------------------------------------------------- scheduling
function isWorkTime(d = new Date()) {
  if (!settings.workDays.includes(d.getDay())) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= toMin(settings.workStart) && m < toMin(settings.workEnd);
}
function nextWorkStart(from = new Date()) {
  const [h, m] = settings.workStart.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0);
    if (d > from && settings.workDays.includes(d.getDay())) return d;
  }
  return null;
}
function scheduleNext(minutes = settings.intervalMin) {
  let t = new Date(Date.now() + minutes * 60_000);
  if (!isWorkTime(t)) {
    const start = nextWorkStart(new Date());
    t = start ? new Date(+start + settings.intervalMin * 60_000) : t;
  }
  timer = { nextAt: +t, due: false, suggestionId: null };
  saveTimer();
}

function suggestionPool() {
  const weights = { star: 6, keep: 3, unsorted: 1, drop: 0 };
  const eligible = e => e.type !== 'test' && (e.desk || (settings.includeKit && ['standing', 'sitting'].includes(e.mode)));
  let pool = EX.filter(e => eligible(e) && statusOf(e.id) !== 'drop');
  if (settings.onlyCurated) {
    const curated = pool.filter(e => ['star', 'keep'].includes(statusOf(e.id)));
    if (curated.length) pool = curated;
  }
  return pool.map(e => {
    let w = weights[statusOf(e.id)] * (e.rating >= 8 ? 1.3 : 1);
    if (recent.includes(e.id)) w *= 0.1;
    return { e, w };
  });
}
function pickSuggestion(exclude) {
  const pool = suggestionPool().filter(p => p.e.id !== exclude);
  const total = pool.reduce((s, p) => s + p.w, 0);
  let r = Math.random() * total;
  for (const p of pool) { r -= p.w; if (r <= 0) return p.e; }
  return pool[0]?.e;
}
function remember(id) {
  recent = [id, ...recent.filter(x => x !== id)].slice(0, 6);
  store.set('recent', recent);
}

function triggerBreak() {
  const ex = pickSuggestion();
  timer = { ...timer, due: true, suggestionId: ex?.id || null };
  saveTimer();
  if (ex) remember(ex.id);
  chime(2);
  notify('Time to move 🤸', ex ? `${ex.title}${ex.dose ? ' — ' + ex.dose : ''}` : 'Get up and move for a minute.');
  if (route().view === 'now') render();
}

function tick() {
  updateChrome();
  if (!settings.enabled || timer.due) return;
  const now = Date.now();
  if (!timer.nextAt) return scheduleNext();
  if (now < timer.nextAt) return;
  // If we're way past due (laptop was asleep / tab closed) just reschedule quietly.
  if (now - timer.nextAt > settings.intervalMin * 60_000 || !isWorkTime()) { scheduleNext(); return; }
  triggerBreak();
}

const offHours = () => !isWorkTime() && timer.nextAt - Date.now() > settings.intervalMin * 60_000;

function updateChrome() {
  const chip = $('#countdown-chip');
  let text, cls = '';
  if (!settings.enabled) text = 'Reminders off';
  else if (timer.due) { text = 'Move now'; cls = 'due'; }
  else if (offHours()) text = `Off until ${new Date(timer.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
  else { text = `Next break ${fmtClock((timer.nextAt - Date.now()) / 1000)}`; cls = 'on'; }
  chip.textContent = text;
  chip.className = 'chip ' + cls;
  document.title = timer.due && settings.enabled ? '⏰ Move! — Move It' : 'Move It';
  const big = $('#big-time');
  if (big && settings.enabled && !timer.due) big.textContent = fmtClock((timer.nextAt - Date.now()) / 1000);
}

function logEvent(kind, id) {
  log.push({ t: Date.now(), kind, id });
  if (log.length > 5000) log = log.slice(-5000);
  store.set('log', log);
}

// ---------------------------------------------------------------- routing
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { view: parts[0] || 'now', id: parts[1], sub: parts[2] };
}
function render() {
  const r = route();
  document.querySelectorAll('.tabs a').forEach(a => a.dataset.tab === r.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  const views = { now: viewNow, flows: r.id ? (r.sub === 'play' ? viewPlayer : viewFlow) : viewFlows, library: viewLibrary, curate: viewCurate, settings: viewSettings };
  if (r.view !== 'flows' || r.sub !== 'play') stopPlayer();
  $('#app').innerHTML = (views[r.view] || viewNow)(r);
  updateChrome();
  if (r.view === 'flows' && r.sub === 'play') startPlayer(r.id);
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

// ---------------------------------------------------------------- view: Now
let breakCountdown = null; // { endsAt, interval }

function viewNow() {
  const parts = [];
  if (settings.notify && notifSupported && Notification.permission === 'default') {
    parts.push(`<div class="banner info"><span>Allow notifications so break reminders reach you while this tab is in the background.</span><span class="spacer"></span><button class="primary" data-action="ask-notify">Allow notifications</button></div>`);
  } else if (settings.notify && notifSupported && Notification.permission === 'denied') {
    parts.push(`<div class="banner"><span>Notifications are blocked for this site — you'll only get the chime and tab title. Re-enable them in your browser's site settings.</span></div>`);
  }

  const ex = timer.suggestionId && EX_BY_ID[timer.suggestionId];
  if (timer.due || timer.manual) {
    parts.push(breakCard(ex));
  } else {
    parts.push(`<section class="card now-status">
      ${!settings.enabled
        ? `<div><p class="muted small">Reminders are paused</p><div class="big-time">—</div></div>`
        : offHours()
        ? `<div><p class="muted small">Outside work hours — first break</p>
           <div class="big-time">${new Date(timer.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div></div>`
        : `<div><p class="muted small">Next movement break at ${fmtTime(timer.nextAt)}</p>
           <div class="big-time" id="big-time">${fmtClock((timer.nextAt - Date.now()) / 1000)}</div></div>`}
      <div class="row">
        <button class="primary big" data-action="break-now">Move now</button>
        ${settings.enabled
          ? `<button data-action="toggle-enabled">Pause reminders</button><button class="ghost" data-action="reset-timer">Restart ${settings.intervalMin}-min timer</button>`
          : `<button class="primary" data-action="toggle-enabled">Resume reminders</button>`}
        <span class="spacer"></span>
        <span class="muted small">Every ${settings.intervalMin} min · ${esc(settings.workStart)}–${esc(settings.workEnd)}</span>
      </div>
    </section>`);
  }

  parts.push(`<div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))">
    <section class="card stack">
      <div class="row"><h2>Posture check</h2><span class="spacer"></span>
        <button class="small" data-action="posture" data-p="sitting" aria-pressed="${settings.posture === 'sitting'}">Sitting</button>
        <button class="small" data-action="posture" data-p="standing" aria-pressed="${settings.posture === 'standing'}">Standing</button>
      </div>
      <p class="tip">“${esc(pick([...(TIPS[settings.posture] || []), ...(TIPS.general || [])]) || '')}”</p>
      <button class="ghost small" data-action="rerender">Another tip</button>
    </section>
    <section class="card stack">${weekStrip()}</section>
  </div>`);

  const starred = FLOWS.filter(f => f.starred);
  if (starred.length) {
    parts.push(`<section class="stack"><h2>Your flows</h2><div class="grid">${starred.map(flowCard).join('')}</div></section>`);
  }
  return `<div class="stack">${parts.join('')}</div>`;
}

function breakCard(ex) {
  if (!ex) return `<section class="card due"><h2>Time to move</h2><p>Stand up and walk for a minute.</p>
    <div class="row"><button class="primary" data-action="break-done">Done</button><button data-action="break-snooze">Snooze ${settings.snoozeMin} min</button></div></section>`;
  const running = breakCountdown && breakCountdown.id === ex.id;
  return `<section class="card suggestion ${timer.due ? 'due' : ''}">
    ${thumb(ex, 'hero-img')}
    <div class="stack">
      <p class="muted small">${timer.due ? '⏰ Movement break' : 'Movement break'}</p>
      <h1>${esc(ex.title)}</h1>
      <div class="ex-meta">${pills(ex)}${ex.dose ? `<span class="pill">${esc(ex.dose)}</span>` : ''}</div>
      ${ex.how ? `<p>${esc(ex.how)}</p>` : ''}
      ${ex.tips.length ? `<ul class="tips">${ex.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${ex.why ? `<p class="muted small">Why: ${esc(ex.why)}</p>` : ''}
      <div class="row">
        <span class="timer-ring" id="break-timer">${fmtClock(running ? (breakCountdown.endsAt - Date.now()) / 1000 : ex.seconds || 30)}</span>
        <button data-action="break-start">${running ? 'Restart' : 'Start timer'}</button>
      </div>
      <div class="row">
        <button class="primary big" data-action="break-done">Done ✓</button>
        <button data-action="break-another">Another</button>
        ${timer.due ? `<button data-action="break-snooze">Snooze ${settings.snoozeMin} min</button>` : ''}
        <button class="ghost" data-action="break-skip">Skip</button>
      </div>
      <details><summary class="muted small">Rate this one</summary><div style="margin-top:.5rem">${curationButtons(ex.id)}</div></details>
    </div>
  </section>`;
}

function weekStrip() {
  const days = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const end = +d + 86_400_000;
    const n = log.filter(e => e.t >= +d && e.t < end).length;
    days.push({ d, n, isToday: i === 0 });
  }
  const max = Math.max(4, ...days.map(x => x.n));
  const todayN = days.at(-1).n;
  return `<div class="row"><h2>This week</h2><span class="spacer"></span><span class="muted small">${todayN} break${todayN === 1 ? '' : 's'} today</span></div>
    <div class="week" role="img" aria-label="Breaks per day over the last 7 days">${days.map(x => `
      <div class="day ${x.isToday ? 'today' : ''}" title="${x.n} on ${x.d.toLocaleDateString()}">
        <div class="bar"><span style="height:${(x.n / max) * 100}%"></span></div>
        ${x.d.toLocaleDateString([], { weekday: 'narrow' })}<br>${x.n || ''}
      </div>`).join('')}</div>`;
}

function startBreakCountdown(ex) {
  clearInterval(breakCountdown?.interval);
  const endsAt = Date.now() + (ex.seconds || 30) * 1000;
  breakCountdown = { id: ex.id, endsAt, interval: setInterval(() => {
    const el = $('#break-timer');
    const left = (endsAt - Date.now()) / 1000;
    if (el) el.textContent = fmtClock(left);
    if (left <= 0) { clearInterval(breakCountdown.interval); breakCountdown = null; chime(1); if (el) el.textContent = 'Done!'; }
  }, 250) };
}
function endBreak() {
  clearInterval(breakCountdown?.interval); breakCountdown = null;
  scheduleNext();
}

// ---------------------------------------------------------------- view: Flows
function flowSeconds(f) { return f.steps.map(resolveStep).reduce((s, x) => s + x.seconds, 0); }

function flowCard(f) {
  const first = f.steps.map(resolveStep).find(s => s.ex?.images?.length)?.ex;
  return `<a class="card flow-card" href="#/flows/${esc(f.id)}">
    ${thumb(first)}
    <div class="row"><h3>${f.starred ? '<span style="color:var(--star)">★</span> ' : ''}${esc(f.title)}</h3></div>
    <p class="muted small" style="margin:0">${f.steps.length} steps · ~${Math.round(flowSeconds(f) / 60)} min${f.when ? ' · ' + esc(f.when) : ''}</p>
  </a>`;
}

function viewFlows() {
  const sorted = [...FLOWS].sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
  return `<div class="stack">
    <div><h1>Flows</h1><p class="muted">Routines you like. Edit <code>web/data/flows.yaml</code> to add or reorder; <code>starred: true</code> pins one to the Now page.</p></div>
    <div class="grid">${sorted.map(flowCard).join('')}</div>
  </div>`;
}

function viewFlow({ id }) {
  const f = FLOWS.find(x => x.id === id);
  if (!f) return `<p>Flow not found. <a href="#/flows">Back to flows</a></p>`;
  const steps = f.steps.map(resolveStep);
  return `<div class="stack">
    <p><a href="#/flows">← Flows</a></p>
    <div class="row"><div><h1>${esc(f.title)}</h1>
      <p class="muted">${[f.when, f.source && 'Source: ' + f.source, `~${Math.round(flowSeconds(f) / 60)} min`].filter(Boolean).map(esc).join(' · ')}</p></div>
      <span class="spacer"></span><a class="btn primary" href="#/flows/${esc(f.id)}/play" style="background:var(--accent);color:var(--accent-ink);border-color:transparent">▶ Start flow</a></div>
    <ol class="steps">${steps.map((s, i) => stepRow(s, i)).join('')}</ol>
  </div>`;
}
function stepRow(s, i, cls = '') {
  if (!s.ex) return `<li class="text-step ${cls}"><span class="n">${i + 1}</span><div><strong>${esc(s.title)}</strong>${s.note ? `<div class="muted small">${esc(s.note)}</div>` : ''}</div><span class="muted small">${fmtClock(s.seconds)}</span></li>`;
  return `<li class="${cls}" data-action="detail" data-id="${esc(s.ex.id)}" style="cursor:pointer"><span class="n">${i + 1}</span>${thumb(s.ex)}
    <div><strong>${esc(s.title)}</strong><div class="muted small">${esc([s.dose, s.note].filter(Boolean).join(' — '))}</div></div>
    <span class="muted small">${fmtClock(s.seconds)}</span></li>`;
}

// flow player
let player = null; // { flow, steps, idx, endsAt, pausedLeft, interval }
function viewPlayer({ id }) {
  const f = FLOWS.find(x => x.id === id);
  if (!f) return `<p>Flow not found.</p>`;
  return `<div class="stack"><p><a href="#/flows/${esc(f.id)}">← ${esc(f.title)}</a></p><div id="player"></div></div>`;
}
function startPlayer(id) {
  const flow = FLOWS.find(x => x.id === id);
  if (!flow) return;
  if (!player || player.flow.id !== id) {
    stopPlayer();
    player = { flow, steps: flow.steps.map(resolveStep), idx: 0, endsAt: null, pausedLeft: null, finished: false };
  }
  player.interval = setInterval(playerTick, 250);
  drawPlayer();
}
function stopPlayer() { if (player) { clearInterval(player.interval); player = null; } }
function playerLeft() {
  const s = player.steps[player.idx];
  if (player.endsAt) return (player.endsAt - Date.now()) / 1000;
  return player.pausedLeft ?? s.seconds;
}
function playerTick() {
  if (!player || !player.endsAt) return;
  const left = playerLeft();
  const el = $('#player-time');
  if (el) el.textContent = fmtClock(left);
  const bar = $('#player-bar');
  if (bar) bar.style.width = `${100 - (left / player.steps[player.idx].seconds) * 100}%`;
  if (left <= 0) { chime(1); playerGo(player.idx + 1, true); }
}
function playerGo(idx, autoplay) {
  if (idx >= player.steps.length) {
    player.endsAt = null; player.finished = true;
    logEvent('flow', player.flow.id);
    chime(2);
  } else {
    player.idx = Math.max(0, idx);
    player.pausedLeft = null;
    player.endsAt = autoplay ? Date.now() + player.steps[player.idx].seconds * 1000 : null;
  }
  drawPlayer();
}
function drawPlayer() {
  const el = $('#player');
  if (!el || !player) return;
  if (player.finished) {
    el.innerHTML = `<section class="card player"><h1>Flow complete 🎉</h1><p class="muted">${esc(player.flow.title)} — logged.</p>
      <div class="row"><a class="btn" href="#/now">Back to Now</a><button data-action="player-restart">Do it again</button></div></section>`;
    return;
  }
  const s = player.steps[player.idx];
  const running = !!player.endsAt;
  el.innerHTML = `<section class="card player">
    <p class="muted small">Step ${player.idx + 1} of ${player.steps.length}</p>
    <div class="progress"><span id="player-bar" style="width:${100 - (playerLeft() / s.seconds) * 100}%"></span></div>
    ${s.ex ? thumb(s.ex, 'hero-img') : ''}
    <h1>${esc(s.title)}</h1>
    ${s.dose || s.note ? `<p class="muted">${esc([s.dose, s.note].filter(Boolean).join(' — '))}</p>` : ''}
    ${s.ex?.how ? `<p style="max-width:60ch">${esc(s.ex.how)}</p>` : ''}
    <div class="big-time" id="player-time">${fmtClock(playerLeft())}</div>
    <div class="row" style="justify-content:center">
      <button data-action="player-prev" ${player.idx === 0 ? 'disabled' : ''}>← Prev</button>
      <button class="primary big" data-action="player-toggle">${running ? 'Pause' : 'Start'}</button>
      <button data-action="player-next">${player.idx === player.steps.length - 1 ? 'Finish' : 'Next →'}</button>
    </div>
  </section>
  <ol class="steps">${player.steps.map((st, i) => stepRow(st, i, i === player.idx ? 'active' : i < player.idx ? 'done' : '')).join('')}</ol>`;
}

// ---------------------------------------------------------------- view: Library
const libFilter = { q: '', mode: 'all', type: 'all', status: 'active', desk: false, ...store.get('libFilter', {}) };

function libraryMatches() {
  const q = libFilter.q.trim().toLowerCase();
  return EX.filter(e => {
    const st = statusOf(e.id);
    if (libFilter.status === 'active' && st === 'drop') return false;
    if (!['all', 'active'].includes(libFilter.status) && st !== libFilter.status) return false;
    if (libFilter.mode !== 'all' && e.mode !== libFilter.mode) return false;
    if (libFilter.type !== 'all' && e.type !== libFilter.type) return false;
    if (libFilter.desk && !e.desk) return false;
    if (q && ![e.title, ...e.aka, ...e.targets, e.how, e.type, e.mode, e.source].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
}

function chipGroup(key, options) {
  return `<div class="filters">${options.map(([v, label]) =>
    `<button data-action="lib-filter" data-key="${key}" data-value="${v}" aria-pressed="${libFilter[key] === v}">${label}</button>`).join('')}</div>`;
}

function viewLibrary() {
  const types = [...new Set(EX.map(e => e.type).filter(Boolean))];
  return `<div class="stack">
    <div><h1>Library</h1><p class="muted">${EX.length} exercises. Tap one for details and to rate it.</p></div>
    <input type="search" id="lib-q" placeholder="Search by name, muscle, source…" value="${esc(libFilter.q)}" aria-label="Search exercises">
    ${chipGroup('status', [['active', 'Not dropped'], ['star', '★ Starred'], ['keep', 'Kept'], ['unsorted', 'Unsorted'], ['drop', 'Dropped'], ['all', 'All']])}
    ${chipGroup('mode', [['all', 'Any position'], ['standing', 'Standing'], ['sitting', 'Sitting'], ['floor', 'Floor'], ['lying', 'Lying']])}
    ${chipGroup('type', [['all', 'Any type'], ...types.map(t => [t, t[0].toUpperCase() + t.slice(1)])])}
    <label class="check"><input type="checkbox" id="lib-desk" ${libFilter.desk ? 'checked' : ''}> Desk-friendly only</label>
    <div class="grid" id="lib-results">${libraryResults()}</div>
  </div>`;
}
function libraryResults() {
  const list = libraryMatches();
  if (!list.length) return `<p class="muted">Nothing matches.</p>`;
  return list.map(e => `<article class="card ex-card" data-action="detail" data-id="${esc(e.id)}" tabindex="0">
    ${thumb(e)}<h3>${esc(e.title)}</h3><div class="ex-meta">${pills(e)}</div>
    ${e.targets.length ? `<p class="muted small" style="margin:0">${esc(e.targets.join(', '))}</p>` : ''}
  </article>`).join('');
}

// ---------------------------------------------------------------- detail dialog
function openDetail(id) {
  const e = EX_BY_ID[id];
  if (!e) return;
  const facts = [
    ['Dose', e.dose], ['Position', e.mode], ['Type', e.type], ['Targets', e.targets.join(', ')],
    ['Kit', [].concat(e.equipment || []).join(', ')], ['Also', e.aka.join(', ')], ['Source', e.source],
  ].filter(([, v]) => v);
  const dlg = $('#detail');
  dlg.innerHTML = `<div class="inner">
    <div class="row"><h2 style="margin:0">${esc(e.title)}</h2><span class="spacer"></span><button class="ghost" data-action="close-detail" aria-label="Close">✕</button></div>
    ${e.images.length ? `<div class="imgs">${e.images.map(i => `<div class="thumb"><img src="img/${esc(i)}" alt="${esc(e.title)}"></div>`).join('')}</div>` : ''}
    ${e.how ? `<p>${esc(e.how)}</p>` : '<p class="muted">No instructions yet — add a <code>how:</code> in exercises.yaml.</p>'}
    ${e.tips.length ? `<ul class="tips">${e.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${e.why ? `<p class="muted">Why: ${esc(e.why)}</p>` : ''}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${e.link ? `<p><a href="${esc(e.link)}" target="_blank" rel="noopener">Watch / read more ↗</a></p>` : ''}
    <div id="detail-curate">${curationButtons(e.id)}</div>
    <div class="row"><button class="primary" data-action="do-now" data-id="${esc(e.id)}">Do this now</button><span class="muted small">id: ${esc(e.id)}</span></div>
  </div>`;
  if (!dlg.open) dlg.showModal();
}
$('#detail').addEventListener('click', ev => { if (ev.target.id === 'detail') ev.target.close(); });

// ---------------------------------------------------------------- view: Curate
let curateAll = false;
let curateSkipped = new Set();
let curateCurrent = null;

function curateQueue() {
  const list = curateAll ? EX : EX.filter(e => statusOf(e.id) === 'unsorted');
  return [...list.filter(e => !curateSkipped.has(e.id)), ...list.filter(e => curateSkipped.has(e.id))];
}

function viewCurate() {
  const counts = { star: 0, keep: 0, drop: 0, unsorted: 0 };
  EX.forEach(e => counts[statusOf(e.id)]++);
  const sorted = EX.length - counts.unsorted;
  const queue = curateQueue();
  if (curateAll) {
    if (!curateCurrent || !EX_BY_ID[curateCurrent]) curateCurrent = queue[0]?.id;
  } else if (!queue.some(e => e.id === curateCurrent)) curateCurrent = queue[0]?.id;
  const e = EX_BY_ID[curateCurrent];
  const changed = Object.keys(curationOverrides).length;

  return `<div class="stack">
    <div class="row"><div><h1>Curate</h1>
      <p class="muted">Sort the library so only the good ones get suggested. ${sorted} of ${EX.length} sorted ·
        <span class="pill star">★ ${counts.star}</span> <span class="pill keep">${counts.keep} kept</span> <span class="pill drop">${counts.drop} dropped</span></p></div>
      <span class="spacer"></span>
      <label class="check small"><input type="checkbox" id="curate-all" ${curateAll ? 'checked' : ''}> Review all, not just unsorted</label>
    </div>
    <div class="progress"><span style="width:${(sorted / EX.length) * 100}%"></span></div>
    ${e ? `<section class="card curate">
        ${thumb(e, 'hero-img')}
        <div class="stack">
          <p class="muted small">${curateAll ? `${EX.indexOf(e) + 1} of ${EX.length}` : `${queue.length} left to sort`}</p>
          <h1>${esc(e.title)}</h1>
          <div class="ex-meta">${pills(e)}${e.dose ? `<span class="pill">${esc(e.dose)}</span>` : ''}</div>
          ${e.how ? `<p>${esc(e.how)}</p>` : '<p class="muted">No instructions.</p>'}
          ${e.why ? `<p class="muted small">Why: ${esc(e.why)}</p>` : ''}
          ${e.source ? `<p class="muted small">Source: ${esc(e.source)}</p>` : ''}
          ${curationButtons(e.id)}
          <div class="row"><button class="ghost" data-action="curate-skip">Skip →</button><span class="spacer"></span>
            <span class="muted small"><kbd>S</kbd> star <kbd>K</kbd> keep <kbd>D</kbd> drop <kbd>→</kbd> skip</span></div>
        </div>
      </section>`
    : `<section class="card"><h2>All sorted 🎉</h2><p>Export your choices below and commit them.</p></section>`}
    <section class="card stack">
      <h2>Save your choices</h2>
      <p class="muted">Ratings live in this browser until you export them. Replace <code>web/data/curation.yaml</code> with the export and commit it so they ship with the site (and survive a cleared browser).
        ${changed ? `<strong>${changed} change${changed === 1 ? '' : 's'}</strong> not yet in curation.yaml.` : 'Nothing new since curation.yaml.'}</p>
      <div class="row">
        <button class="primary" data-action="export-curation">Download curation.yaml</button>
        <button data-action="copy-curation">Copy to clipboard</button>
        ${changed ? `<button class="ghost" data-action="reset-curation">Discard browser changes</button>` : ''}
      </div>
    </section>
  </div>`;
}

function curationYaml() {
  const out = { star: [], keep: [], drop: [] };
  for (const e of EX) { const st = statusOf(e.id); if (out[st]) out[st].push(e.id); }
  return `# Curation for exercises.yaml — exported from the Move It app ${new Date().toISOString().slice(0, 10)}\n` +
    `#   star: best ones, favoured in break suggestions\n#   keep: good, normal weight\n#   drop: never suggested\n` +
    jsyaml.dump(out, { flowLevel: -1 });
}

// ---------------------------------------------------------------- view: Settings
function viewSettings() {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const perm = notifSupported ? Notification.permission : 'unsupported';
  return `<div class="stack">
    <h1>Settings</h1>
    <section class="card stack">
      <h2>Reminders</h2>
      <label class="check"><input type="checkbox" data-setting="enabled" ${settings.enabled ? 'checked' : ''}> Remind me to take movement breaks</label>
      <div class="row" style="gap:1rem">
        <label class="field">Every (minutes)<input type="number" min="5" max="180" step="5" data-setting="intervalMin" value="${settings.intervalMin}"></label>
        <label class="field">Snooze (minutes)<input type="number" min="1" max="60" data-setting="snoozeMin" value="${settings.snoozeMin}"></label>
        <label class="field">Work starts<input type="time" data-setting="workStart" value="${esc(settings.workStart)}"></label>
        <label class="field">Work ends<input type="time" data-setting="workEnd" value="${esc(settings.workEnd)}"></label>
      </div>
      <div><p class="small" style="font-weight:550;margin-bottom:.3rem">Work days</p>
        <div class="filters">${days.map((d, i) => `<button data-action="toggle-day" data-day="${i}" aria-pressed="${settings.workDays.includes(i)}">${d}</button>`).join('')}</div></div>
    </section>
    <section class="card stack">
      <h2>Alerts</h2>
      <label class="check"><input type="checkbox" data-setting="notify" ${settings.notify ? 'checked' : ''}> Desktop notifications</label>
      <p class="muted small" style="margin:0">Browser permission: <strong>${perm}</strong>.
        ${perm === 'default' ? `<button class="small" data-action="ask-notify">Allow</button>` : ''}
        ${perm === 'denied' ? 'Unblock this site in your browser settings to get notifications.' : ''}</p>
      <label class="check"><input type="checkbox" data-setting="sound" ${settings.sound ? 'checked' : ''}> Chime</label>
      <div class="row"><button data-action="test-alert">Test alert</button></div>
      <p class="muted small" style="margin:0">Keep this tab open (pinned is ideal). Browsers can't fire reminders once the tab is closed.</p>
    </section>
    <section class="card stack">
      <h2>Suggestions</h2>
      <label class="check"><input type="checkbox" data-setting="onlyCurated" ${settings.onlyCurated ? 'checked' : ''}> Only suggest starred / kept exercises</label>
      <label class="check"><input type="checkbox" data-setting="includeKit" ${settings.includeKit ? 'checked' : ''}> Include standing/sitting moves that aren't marked desk-friendly</label>
      <p class="muted small" style="margin:0">${suggestionPool().length} exercises currently in the break pool.</p>
    </section>
    <section class="card stack">
      <h2>History</h2>
      <p class="muted small" style="margin:0">${log.length} breaks and flows logged in this browser.</p>
      <div class="row"><button data-action="export-log">Download log (JSON)</button><button class="ghost" data-action="clear-log">Clear log</button></div>
    </section>
  </div>`;
}

function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- events
const actions = {
  'ask-notify': async () => { await Notification.requestPermission(); render(); },
  'toggle-enabled': () => { settings.enabled = !settings.enabled; saveSettings(); if (settings.enabled) scheduleNext(); render(); },
  'reset-timer': () => { scheduleNext(); render(); },
  'break-now': () => { const ex = pickSuggestion(); if (ex) remember(ex.id); timer = { ...timer, manual: true, suggestionId: ex?.id }; saveTimer(); render(); },
  'break-start': () => { const ex = EX_BY_ID[timer.suggestionId]; if (ex) { startBreakCountdown(ex); render(); } },
  'break-done': () => { logEvent('break', timer.suggestionId); endBreak(); render(); },
  'break-another': () => { clearInterval(breakCountdown?.interval); breakCountdown = null; const ex = pickSuggestion(timer.suggestionId); if (ex) remember(ex.id); timer.suggestionId = ex?.id; saveTimer(); render(); },
  'break-snooze': () => { clearInterval(breakCountdown?.interval); breakCountdown = null; scheduleNext(settings.snoozeMin); render(); },
  'break-skip': () => {
    if (timer.due) endBreak();
    else { clearInterval(breakCountdown?.interval); breakCountdown = null; timer = { ...timer, manual: false, suggestionId: null }; saveTimer(); }
    render();
  },
  'posture': el => { settings.posture = el.dataset.p; saveSettings(); render(); },
  'rerender': () => render(),
  'detail': el => openDetail(el.dataset.id),
  'close-detail': () => $('#detail').close(),
  'do-now': el => { $('#detail').close(); timer = { ...timer, manual: true, suggestionId: el.dataset.id }; saveTimer(); location.hash = '#/now'; render(); },
  'curate': el => {
    setStatus(el.dataset.id, el.dataset.status);
    const r = route();
    if ($('#detail').open) $('#detail-curate').innerHTML = curationButtons(el.dataset.id);
    if (r.view === 'curate' && curateAll && el.dataset.status !== 'unsorted') curateAdvance();
    if (r.view !== 'now' || !$('#detail').open) render();
  },
  'curate-skip': () => curateAdvance(true),
  'export-curation': () => download('curation.yaml', curationYaml(), 'text/yaml'),
  'copy-curation': async el => { await navigator.clipboard.writeText(curationYaml()); el.textContent = 'Copied ✓'; },
  'reset-curation': () => { if (confirm('Discard the ratings saved in this browser and go back to curation.yaml?')) { curationOverrides = {}; store.set('curation', {}); render(); } },
  'lib-filter': el => { libFilter[el.dataset.key] = el.dataset.value; store.set('libFilter', libFilter); render(); },
  'toggle-day': el => { const d = +el.dataset.day; settings.workDays = settings.workDays.includes(d) ? settings.workDays.filter(x => x !== d) : [...settings.workDays, d]; saveSettings(); scheduleNext(); render(); },
  'test-alert': () => { chime(2); notify('Move It test 🤸', 'This is what a break reminder looks like.'); },
  'export-log': () => download('moveit-log.json', JSON.stringify(log, null, 2), 'application/json'),
  'clear-log': () => { if (confirm('Clear all logged breaks?')) { log = []; store.set('log', log); render(); } },
  'player-toggle': () => {
    if (player.endsAt) { player.pausedLeft = playerLeft(); player.endsAt = null; }
    else { player.endsAt = Date.now() + playerLeft() * 1000; player.pausedLeft = null; }
    drawPlayer();
  },
  'player-next': () => playerGo(player.idx + 1, !!player.endsAt),
  'player-prev': () => playerGo(player.idx - 1, !!player.endsAt),
  'player-restart': () => { const id = player.flow.id; stopPlayer(); startPlayer(id); },
};

function curateAdvance(skip) {
  if (curateAll) {
    const i = EX.findIndex(e => e.id === curateCurrent);
    curateCurrent = EX[(i + 1) % EX.length].id;
  } else if (skip) {
    curateSkipped.add(curateCurrent);
    curateCurrent = curateQueue().find(e => e.id !== curateCurrent)?.id;
  }
  render();
}

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  if (el.tagName === 'A') ev.preventDefault();
  actions[el.dataset.action](el);
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && ev.target.matches('.ex-card')) return openDetail(ev.target.dataset.id);
  if (route().view !== 'curate' || ev.target.matches('input, textarea') || ev.metaKey || ev.ctrlKey || $('#detail').open) return;
  const map = { s: 'star', k: 'keep', d: 'drop' };
  const k = ev.key.toLowerCase();
  if (map[k] && curateCurrent) { setStatus(curateCurrent, map[k]); curateAll ? curateAdvance() : render(); }
  else if (k === 'arrowright' || k === 'n') curateAdvance(true);
});
document.addEventListener('input', ev => {
  if (ev.target.id === 'lib-q') { libFilter.q = ev.target.value; store.set('libFilter', libFilter); $('#lib-results').innerHTML = libraryResults(); }
});
document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.id === 'lib-desk') { libFilter.desk = t.checked; store.set('libFilter', libFilter); render(); return; }
  if (t.id === 'curate-all') { curateAll = t.checked; curateCurrent = null; render(); return; }
  const key = t.dataset.setting;
  if (!key) return;
  settings[key] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Math.max(+t.min || 1, +t.value || DEFAULT_SETTINGS[key]) : t.value;
  saveSettings();
  if (['intervalMin', 'workStart', 'workEnd', 'enabled'].includes(key)) scheduleNext();
  render();
});
document.addEventListener('visibilitychange', tick);

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    await loadData();
  } catch (err) {
    $('#app').innerHTML = `<div class="banner"><div><strong>Couldn't load the exercise data.</strong><br>
      <span class="small">${esc(err.message)}. If you opened index.html directly from disk, serve the folder instead: <code>python3 -m http.server -d web</code></span></div></div>`;
    return;
  }
  if (!timer.nextAt) scheduleNext();
  render();
  tick();
  setInterval(tick, 1000);
})();
