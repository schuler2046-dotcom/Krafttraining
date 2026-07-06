'use strict';

/* ============================================================
   Krafttraining Tracker – vanilla PWA
   Datenmodell in localStorage, ein JSON-Objekt.
   ============================================================ */

const STORAGE_KEY = 'kraft_tracker_v1';
const DEFAULTS = {
  settings: { unit: 'kg', restDefaultSec: 120, theme: 'dark', weeklyGoal: 2 },
  exercises: [],
  sessions: [],
  bodyweight: [],
  active: null
};

/* ---------- Store ---------- */
const store = {
  db: null,
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.db = raw ? JSON.parse(raw) : structuredClone(DEFAULTS);
    } catch (e) {
      this.db = structuredClone(DEFAULTS);
    }
    // Fülle fehlende Felder auf (Migration/Robustheit).
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in this.db)) this.db[k] = structuredClone(DEFAULTS[k]);
    }
    for (const k of Object.keys(DEFAULTS.settings)) {
      if (!(k in this.db.settings)) this.db.settings[k] = DEFAULTS.settings[k];
    }
    return this.db;
  },
  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.db));
  }
};

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// Lokales Datum als YYYY-MM-DD (nicht UTC), damit Kalendertage zu Trainingstagen passen.
function localISO(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
const todayISO = () => localISO(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function startOfWeekMon(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Montag = Wochenstart
  return x;
}
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtWeight(w) {
  if (w == null) return '–';
  const r = Math.round(w * 10) / 10;
  return (Number.isInteger(r) ? r : r.toFixed(1));
}
function fmtDateLong(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateShort(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' });
}
function exById(id) { return store.db.exercises.find((e) => e.id === id); }

/* ---------- Kraft-Metriken ---------- */
function est1RM(weight, reps) {
  if (reps <= 0) return 0;
  return weight * (1 + reps / 30); // Epley
}

// Aggregiert Werte einer Übung pro Session (chronologisch aufsteigend).
function seriesForExercise(exId) {
  const out = [];
  const sorted = [...store.db.sessions].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  for (const s of sorted) {
    const entry = s.entries.find((e) => e.exerciseId === exId);
    if (!entry) continue;
    let maxW = 0, maxR = 0, best1RM = 0, vol = 0, totReps = 0, any = false;
    for (const set of entry.sets) {
      const r = num(set.reps), w = num(set.weight);
      if (r <= 0) continue;
      any = true;
      maxW = Math.max(maxW, w);
      maxR = Math.max(maxR, r);
      best1RM = Math.max(best1RM, est1RM(w, r));
      vol += r * w;
      totReps += r;
    }
    if (any) out.push({ dateISO: s.dateISO, maxWeight: maxW, maxReps: maxR, e1rm: best1RM, volume: vol, totalReps: totReps });
  }
  return out;
}

// Persönliche Rekorde aus abgeschlossenen Sessions.
function prsForExercise(exId) {
  const ser = seriesForExercise(exId);
  const pr = { maxWeight: 0, maxReps: 0, e1rm: 0 };
  for (const p of ser) {
    pr.maxWeight = Math.max(pr.maxWeight, p.maxWeight);
    pr.maxReps = Math.max(pr.maxReps, p.maxReps);
    pr.e1rm = Math.max(pr.e1rm, p.e1rm);
  }
  return pr;
}

// Auto-Progression: Vorschlag fürs Zusatzgewicht der nächsten Session.
function suggestWeight(exId) {
  const ex = exById(exId);
  const sorted = [...store.db.sessions].sort((a, b) => b.dateISO.localeCompare(a.dateISO));
  for (const s of sorted) {
    const entry = s.entries.find((e) => e.exerciseId === exId);
    if (!entry || !entry.sets.length) continue;
    const first = entry.sets.find((st) => num(st.reps) > 0) || entry.sets[0];
    const base = num(first.weight);
    const prog = ex.progression || {};
    if (prog.enabled && num(first.reps) >= num(prog.triggerReps)) {
      return { weight: base + num(prog.stepKg), bumped: true, prevReps: num(first.reps) };
    }
    return { weight: base, bumped: false, prevReps: num(first.reps) };
  }
  return { weight: 0, bumped: false, prevReps: 0 };
}

/* ============================================================
   UI-State + Rendering
   ============================================================ */
const ui = {
  tab: 'training',
  progressExId: null,
  progressMetric: 'maxWeight',
  calMonth: null,
  expanded: new Set() // exerciseIds mit aufgeklappten Satz-Details
};

const TAB_TITLES = {
  training: 'Training',
  history: 'Verlauf',
  progress: 'Fortschritt',
  exercises: 'Übungen'
};

function render() {
  $('#header-title').textContent = TAB_TITLES[ui.tab];
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === ui.tab));
  const view = $('#view');
  view.scrollTop = 0;
  if (ui.tab === 'training') view.innerHTML = viewTraining();
  else if (ui.tab === 'history') view.innerHTML = viewHistory();
  else if (ui.tab === 'progress') view.innerHTML = viewProgress();
  else if (ui.tab === 'exercises') view.innerHTML = viewExercises();
  document.documentElement.scrollTop = 0;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

/* ============================================================
   VIEW: Training
   ============================================================ */
function viewTraining() {
  const a = store.db.active;
  if (!a) {
    const last = [...store.db.sessions].sort((x, y) => y.dateISO.localeCompare(x.dateISO))[0];
    return `
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6.5 6.5l11 11M21 21l-1-1M3 3l1 1M18 22l4-4M2 6l4-4M7 17l-5 5M17 7l5-5"/></svg>
        <h3>Bereit fürs Training?</h3>
        <p class="muted small">Starte eine neue Einheit${store.db.exercises.some((e) => e.favorite) ? ' – deine Favoriten werden automatisch geladen' : ' und trage Sätze, Wiederholungen und Gewicht ein'}.</p>
      </div>
      <button class="btn btn-primary" data-action="start-session">Neues Training starten</button>
      ${last ? `<p class="muted small" style="text-align:center;margin-top:18px">Letztes Training: ${esc(fmtDateShort(last.dateISO))} · ${last.entries.length} Übung(en)</p>` : ''}
    `;
  }

  const blocks = a.entries.map((entry, ei) => exerciseBlock(entry, ei)).join('');
  return `
    <div class="row-between" style="margin-bottom:12px">
      <div>
        <div style="font-weight:800;font-size:18px">Aktuelles Training</div>
        <div class="muted small">${esc(fmtDateLong(a.dateISO))}</div>
      </div>
      <button class="btn btn-sm btn-ghost" data-action="discard-session">Verwerfen</button>
    </div>
    ${blocks}
    <button class="fab-add" data-action="add-exercise">＋ Übung hinzufügen</button>
    <div class="sticky-actions">
      <button class="btn btn-success" data-action="finish-session">Training abschließen</button>
    </div>
  `;
}

function exerciseBlock(entry, ei) {
  const ex = exById(entry.exerciseId);
  if (!ex) return '';
  const withBand = ex.usesBands ? ' with-band' : '';
  const sug = entry._sug; // an Eintrag gehängt beim Hinzufügen
  const hint = sug && sug.bumped
    ? `<div class="ex-hint up">↑ Ziel +${fmtWeight(ex.progression.stepKg)} kg — beim letzten Mal ${sug.prevReps} WH im 1. Satz</div>`
    : (sug && sug.prevReps ? `<div class="ex-hint">Letztes Mal ${sug.prevReps} WH im 1. Satz · Gewicht halten</div>` : '');

  const pr = prsForExercise(ex.id);
  const entryWeight = entry.sets.length ? (entry.sets[0].weight ?? '') : '';
  const expanded = ui.expanded.has(ex.id);
  const total = entry.sets.length;
  const doneCount = entry.sets.filter((s) => s.done).length;
  const allDone = total > 0 && doneCount === total;
  const weightLabel = (entryWeight !== '' && entryWeight != null && num(entryWeight) > 0)
    ? `${fmtWeight(entryWeight)} kg` : 'Körpergewicht';

  const rows = entry.sets.map((set, si) => {
    const done = set.done ? ' done' : '';
    const r = num(set.reps), w = num(set.weight);
    const isPR = set.done && r > 0 && (w > pr.maxWeight || r > pr.maxReps || est1RM(w, r) > pr.e1rm + 0.01);
    const bandCell = ex.usesBands ? `
      <select class="set-input${done}" data-ei="${ei}" data-si="${si}" data-field="band" aria-label="Band-Stufe">
        <option value="">–</option>
        ${[1,2,3,4,5].map((n) => `<option value="${n}" ${String(set.band) === String(n) ? 'selected' : ''}>${n}</option>`).join('')}
      </select>` : '';
    return `
      <div class="set-row">
        <div class="set-idx">${si + 1}</div>
        <input class="set-input${done}" type="number" inputmode="numeric" min="0" placeholder="0"
               value="${set.reps ?? ''}" data-ei="${ei}" data-si="${si}" data-field="reps" aria-label="Wiederholungen">
        ${bandCell}
        <button class="set-check${done}" data-action="toggle-set" data-ei="${ei}" data-si="${si}" aria-label="Satz erledigt">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        </button>
      </div>
      ${isPR ? `<div style="padding:0 16px 4px 60px"><span class="pr-flag">★ Neuer Rekord</span></div>` : ''}
    `;
  }).join('');

  const detail = expanded ? `
    <div class="ex-detail">
      ${hint}
      <div class="ex-weight-bar">
        <span class="ewb-label">Gewicht (alle Sätze)</span>
        <div class="ewb-input">
          <input class="set-input" type="number" inputmode="decimal" min="0" step="0.5" placeholder="0"
                 value="${entryWeight}" data-entry-weight data-ei="${ei}" aria-label="Gewicht in kg für alle Sätze">
          <span class="ewb-unit">kg</span>
        </div>
      </div>
      <div class="set-head">
        <div>#</div><div>WDH</div>${ex.usesBands ? '<div>BAND</div>' : ''}<div></div>
      </div>
      ${rows}
      <div class="ex-actions">
        <button class="link-btn" data-action="add-set" data-ei="${ei}">＋ Satz</button>
        <button class="link-btn danger" data-action="remove-exercise" data-ei="${ei}">Entfernen</button>
      </div>
    </div>` : '';

  return `
    <div class="ex-block${withBand}${expanded ? ' expanded' : ''}" data-exid="${ex.id}" data-ei="${ei}">
      <div class="ex-summary">
        <div class="ex-sum-tap" data-action="toggle-expand" data-exid="${ex.id}">
          <div class="ex-sum-main">
            <div class="ex-name">${esc(ex.name)}${allDone ? ' <span class="ex-done-badge">✓</span>' : ''}</div>
            <div class="ex-sum-sub">${weightLabel}${total ? ` · <span class="${allDone ? 'sub-done' : ''}">${doneCount}/${total} Sätze</span>` : ''}</div>
          </div>
          <svg class="ex-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <button class="drag-handle" data-drag data-ei="${ei}" aria-label="Zum Verschieben gedrückt halten und ziehen">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
        </button>
      </div>
      ${detail}
    </div>
  `;
}

/* ============================================================
   VIEW: Verlauf
   ============================================================ */
function sessionVolume(s) {
  let v = 0;
  for (const e of s.entries) for (const set of e.sets) v += num(set.reps) * num(set.weight);
  return v;
}

function viewHistory() {
  // Trainings nach Datum gruppieren
  const byDate = {};
  store.db.sessions.forEach((s) => { (byDate[s.dateISO] = byDate[s.dateISO] || []).push(s); });

  if (!ui.calMonth) ui.calMonth = new Date();
  const view = ui.calMonth;
  const year = view.getFullYear(), month = view.getMonth();
  const monthTitle = view.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // Leerzellen bis Montag
  const dim = new Date(year, month + 1, 0).getDate();
  const tIso = todayISO();

  const wd = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
    .map((d) => `<div class="cal-wd">${d}</div>`).join('');

  let cells = '';
  for (let i = 0; i < lead; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let n = 1; n <= dim; n++) {
    const iso = localISO(new Date(year, month, n));
    const has = !!byDate[iso];
    const today = iso === tIso ? ' today' : '';
    if (has) {
      cells += `<button class="cal-cell has${today}" data-action="open-day" data-date="${iso}">
        <span class="cal-num">${n}</span><span class="cal-dot"></span></button>`;
    } else {
      cells += `<div class="cal-cell${today}"><span class="cal-num">${n}</span></div>`;
    }
  }

  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthCount = Object.keys(byDate).filter((iso) => iso.startsWith(monthPrefix)).length;

  // Wochenziel (immer aktuelle reale Woche, Mo–So)
  const goal = store.db.settings.weeklyGoal || 2;
  const ws = startOfWeekMon(new Date()), we = addDays(ws, 7);
  const weekDays = new Set();
  store.db.sessions.forEach((s) => {
    const d = new Date(s.dateISO + 'T00:00:00');
    if (d >= ws && d < we) weekDays.add(s.dateISO);
  });
  const done = weekDays.size;
  const reached = done >= goal;
  const remaining = Math.max(0, goal - done);
  const dotCount = Math.max(goal, done);

  return `
    <div class="card week-goal">
      <div class="row-between">
        <div><div class="wg-title">Diese Woche</div><div class="wg-sub">Ziel: ${goal}× pro Woche</div></div>
        <div class="wg-count">${done}<span>/${goal}</span></div>
      </div>
      <div class="wg-dots">
        ${[...Array(dotCount)].map((_, i) => `<span class="wg-dot ${i < done ? 'on' : ''}"></span>`).join('')}
      </div>
      <div class="wg-msg ${reached ? 'ok' : ''}">${reached ? 'Wochenziel erreicht ✅' : `Noch ${remaining} Training${remaining === 1 ? '' : 's'} bis zum Ziel`}</div>
    </div>

    <div class="card cal-card">
      <div class="cal-head">
        <button class="cal-nav" data-action="cal-prev" aria-label="Vorheriger Monat">‹</button>
        <div class="cal-title">${esc(monthTitle)}</div>
        <button class="cal-nav" data-action="cal-next" aria-label="Nächster Monat">›</button>
      </div>
      <div class="cal-grid">${wd}</div>
      <div class="cal-grid cal-days">${cells}</div>
      <div class="cal-legend"><span class="cal-dot"></span> Trainingstag · ${monthCount} in diesem Monat</div>
    </div>
  `;
}

function openDay(iso) {
  const list = store.db.sessions.filter((s) => s.dateISO === iso);
  if (!list.length) return;
  if (list.length === 1) { openSessionDetail(list[0].id); return; }
  const items = list.map((s) => {
    const names = s.entries.map((e) => (exById(e.exerciseId) || {}).name).filter(Boolean).join(' · ');
    return `<div class="list-item" data-action="open-session" data-id="${s.id}">
      <div class="li-body"><div class="li-title">${s.entries.length} Übung(en)</div>
      <div class="li-sub">${esc(names || 'Keine Übungen')}</div></div>
      <svg class="li-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
    </div>`;
  }).join('');
  openModal(`<h2>${esc(fmtDateLong(iso))}</h2><p class="muted small" style="margin-bottom:12px">${list.length} Trainings an diesem Tag</p>${items}`);
}

/* ============================================================
   VIEW: Fortschritt
   ============================================================ */
const METRICS = [
  { key: 'maxWeight', label: 'Gewicht', unit: 'kg' },
  { key: 'maxReps', label: 'Wdh', unit: '' },
  { key: 'e1rm', label: '1RM', unit: 'kg' },
  { key: 'volume', label: 'Volumen', unit: 'kg' }
];

function viewProgress() {
  const withData = store.db.exercises.filter((e) => seriesForExercise(e.id).length > 0);
  if (!withData.length) {
    return `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3v18h18"/><path d="M7 15l4-5 4 3 5-7"/></svg>
      <h3>Noch keine Daten</h3>
      <p class="muted small">Schließe ein Training ab, um deine Entwicklung zu sehen.</p>
    </div>`;
  }
  if (!ui.progressExId || !withData.some((e) => e.id === ui.progressExId)) {
    ui.progressExId = withData[0].id;
  }
  const ex = exById(ui.progressExId);
  const ser = seriesForExercise(ex.id);
  const pr = prsForExercise(ex.id);
  const metric = METRICS.find((m) => m.key === ui.progressMetric) || METRICS[0];

  const options = withData.map((e) =>
    `<option value="${e.id}" ${e.id === ui.progressExId ? 'selected' : ''}>${esc(e.name)}</option>`).join('');

  return `
    <div class="field">
      <select class="input" data-action="select-progress-ex">${options}</select>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="stat-val">${fmtWeight(pr.maxWeight)}<small> kg</small></div><div class="stat-label">Bestes Gewicht</div></div>
      <div class="stat"><div class="stat-val">${pr.maxReps}<small> WH</small></div><div class="stat-label">Meiste Wdh</div></div>
      <div class="stat"><div class="stat-val">${fmtWeight(pr.e1rm)}<small> kg</small></div><div class="stat-label">Geschätztes 1RM</div></div>
      <div class="stat"><div class="stat-val">${ser.length}<small> ×</small></div><div class="stat-label">Trainings</div></div>
    </div>

    <div class="segment">
      ${METRICS.map((m) => `<button data-action="select-metric" data-metric="${m.key}" class="${m.key === ui.progressMetric ? 'active' : ''}">${m.label}</button>`).join('')}
    </div>

    <div class="chart-wrap">
      ${lineChart(ser.map((p) => ({ x: p.dateISO, y: p[metric.key] })), metric.unit)}
    </div>
    <p class="muted small" style="text-align:center">${esc(ex.name)} · ${metric.label}${metric.unit ? ' (' + metric.unit + ')' : ''} über die Zeit</p>
  `;
}

// Erzeugt ein SVG-Liniendiagramm aus Punkten [{x:iso, y:number}].
function lineChart(points, unit) {
  const W = 320, H = 170, padL = 34, padR = 10, padT = 14, padB = 24;
  if (!points.length) return '<p class="muted small">Keine Daten.</p>';
  if (points.length === 1) {
    const p = points[0];
    return `<div style="text-align:center;padding:30px 0"><div style="font-size:30px;font-weight:800">${fmtWeight(p.y)} ${esc(unit)}</div><div class="muted small">${esc(fmtDateShort(p.x))} · mehr Daten für den Trend nötig</div></div>`;
  }
  const ys = points.map((p) => p.y);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minY === maxY) { minY = Math.max(0, minY - 1); maxY = maxY + 1; }
  const range = maxY - minY;
  minY = Math.max(0, minY - range * 0.12);
  maxY = maxY + range * 0.12;

  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xAt = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v) => padT + plotH - ((v - minY) / (maxY - minY)) * plotH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(p.y).toFixed(1)}`).join(' ');
  const area = `M${xAt(0).toFixed(1)} ${yAt(points[0].y).toFixed(1)} ` +
    points.map((p, i) => `L${xAt(i).toFixed(1)} ${yAt(p.y).toFixed(1)}`).join(' ') +
    ` L${xAt(points.length - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} L${xAt(0).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  // Y-Gitter (3 Linien)
  const gridVals = [minY, (minY + maxY) / 2, maxY];
  const grid = gridVals.map((v) => {
    const y = yAt(v).toFixed(1);
    return `<line class="chart-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/><text class="chart-axis" x="4" y="${(+y + 3).toFixed(1)}">${fmtWeight(v)}</text>`;
  }).join('');

  const dots = points.map((p, i) => `<circle class="chart-dot" cx="${xAt(i).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="3.5"/>`).join('');

  // X-Beschriftung: erstes, mittleres, letztes
  const xIdx = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const xLabels = xIdx.map((i) => `<text class="chart-axis" x="${xAt(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(fmtDateShort(points[i].x))}</text>`).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
      <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path class="chart-area" d="${area}"/>
      <path class="chart-line" d="${line}"/>
      ${dots}
      ${xLabels}
    </svg>
  `;
}

/* ============================================================
   VIEW: Übungen
   ============================================================ */
function viewExercises() {
  const list = store.db.exercises;
  const items = list.map((ex) => {
    const tags = [];
    if (ex.category) tags.push(`<span class="li-tag">${esc(ex.category)}</span>`);
    tags.push(`<span class="li-tag">${ex.defaultSets ?? 3} Sätze</span>`);
    if (ex.usesBands) tags.push(`<span class="li-tag band">Bänder</span>`);
    if (ex.progression && ex.progression.enabled)
      tags.push(`<span class="li-tag">+${fmtWeight(ex.progression.stepKg)}kg @ ${ex.progression.triggerReps}WH</span>`);
    return `
      <div class="list-item">
        <button class="star-btn${ex.favorite ? ' on' : ''}" data-action="toggle-fav" data-id="${ex.id}" aria-label="Favorit">${ex.favorite ? '★' : '☆'}</button>
        <div class="li-body" data-action="edit-exercise" data-id="${ex.id}">
          <div class="li-title">${esc(ex.name)}</div>
          <div class="li-sub">${tags.join('') || '<span class="muted">Keine Optionen</span>'}</div>
        </div>
        <svg class="li-chevron" data-action="edit-exercise" data-id="${ex.id}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>`;
  }).join('');

  const favCount = list.filter((e) => e.favorite).length;
  return `
    ${list.length ? `<div class="section-title">${list.length} Übung(en)${favCount ? ` · ${favCount} Favorit${favCount === 1 ? '' : 'en'}` : ''}</div>${favCount ? '' : '<p class="muted small" style="margin:-4px 2px 12px">Tipp: Tippe den Stern, um Übungen als Favorit zu setzen – sie werden dann bei jedem neuen Training automatisch geladen.</p>'}${items}` : `
      <div class="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/><line x1="7" y1="12" x2="17" y2="12"/></svg>
        <h3>Noch keine Übungen</h3>
        <p class="muted small">Lege deine eigenen Übungen an – Name frei wählbar.</p>
      </div>`}
    <button class="fab-add mt" data-action="new-exercise">＋ Neue Übung</button>
  `;
}

/* ============================================================
   Modals
   ============================================================ */
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-action="close-modal-bg"><div class="modal"><div class="modal-grip"></div>${html}</div></div>`;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function exerciseEditor(exId) {
  const ex = exId ? exById(exId) : null;
  const p = ex ? ex.progression : { enabled: true, triggerReps: 7, stepKg: 1 };
  const ds = ex ? (ex.defaultSets ?? 3) : 3;
  openModal(`
    <h2>${ex ? 'Übung bearbeiten' : 'Neue Übung'}</h2>
    <form id="ex-form">
      <input type="hidden" name="exId" value="${ex ? ex.id : ''}">
      <div class="field">
        <label>Name</label>
        <input class="input" name="name" placeholder="z. B. Klimmzüge" value="${ex ? esc(ex.name) : ''}" required autofocus>
      </div>
      <div class="field">
        <label>Kategorie (optional)</label>
        <input class="input" name="category" placeholder="z. B. Ziehen, Push, Beine" value="${ex ? esc(ex.category || '') : ''}">
      </div>
      <div class="field">
        <label>Standard-Sätze (werden automatisch angelegt)</label>
        <input class="input" type="number" inputmode="numeric" name="defaultSets" min="1" max="12" value="${ds}">
      </div>
      <div class="card" style="margin:4px 0 14px">
        <div class="switch-row">
          <div><div class="sw-label">★ Favorit</div><div class="sw-sub">Automatisch bei jedem neuen Training laden</div></div>
          <label class="switch"><input type="checkbox" name="favorite" ${ex && ex.favorite ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="switch-row">
          <div><div class="sw-label">Widerstandsbänder</div><div class="sw-sub">Band-Stufe 1–5 pro Satz erfassen</div></div>
          <label class="switch"><input type="checkbox" name="usesBands" ${ex && ex.usesBands ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="switch-row">
          <div><div class="sw-label">Auto-Progression</div><div class="sw-sub">Gewicht automatisch vorschlagen</div></div>
          <label class="switch"><input type="checkbox" name="progEnabled" ${p.enabled ? 'checked' : ''}><span class="slider"></span></label>
        </div>
      </div>
      <div class="btn-row">
        <div class="field" style="flex:1">
          <label>Ab X Wiederholungen</label>
          <input class="input" type="number" inputmode="numeric" name="triggerReps" min="1" value="${p.triggerReps}">
        </div>
        <div class="field" style="flex:1">
          <label>Steigerung (kg)</label>
          <input class="input" type="number" inputmode="decimal" step="0.5" name="stepKg" min="0" value="${p.stepKg}">
        </div>
      </div>
      <button type="submit" class="btn btn-primary mt">${ex ? 'Speichern' : 'Übung anlegen'}</button>
      ${ex ? `<button type="button" class="btn btn-danger mt" data-action="delete-exercise" data-id="${ex.id}">Übung löschen</button>` : ''}
    </form>
  `);
}

function saveExerciseFromForm(exId) {
  const f = $('#ex-form');
  const name = f.name.value.trim();
  if (!name) { toast('Bitte einen Namen eingeben'); return false; }
  const data = {
    name,
    category: f.category.value.trim(),
    defaultSets: Math.min(12, Math.max(1, Math.round(num(f.defaultSets.value) || 3))),
    favorite: f.favorite.checked,
    usesBands: f.usesBands.checked,
    progression: {
      enabled: f.progEnabled.checked,
      triggerReps: Math.max(1, Math.round(num(f.triggerReps.value) || 7)),
      stepKg: Math.max(0, num(f.stepKg.value) || 1)
    }
  };
  if (exId) {
    Object.assign(exById(exId), data);
  } else {
    store.db.exercises.push({ id: uid(), type: 'reps_weight', createdAt: todayISO(), ...data });
  }
  store.save();
  closeModal();
  render();
  toast(exId ? 'Gespeichert' : 'Übung angelegt');
  return true;
}

function addExercisePicker() {
  const list = store.db.exercises;
  if (!list.length) {
    openModal(`<h2>Übung hinzufügen</h2>
      <p class="muted small">Du hast noch keine Übungen angelegt.</p>
      <button class="btn btn-primary mt" data-action="new-exercise">＋ Erste Übung anlegen</button>`);
    return;
  }
  const activeIds = new Set((store.db.active.entries || []).map((e) => e.exerciseId));
  const items = list.map((ex) => `
    <div class="list-item" data-action="pick-exercise" data-id="${ex.id}" style="${activeIds.has(ex.id) ? 'opacity:.45' : ''}">
      <div class="li-body"><div class="li-title">${esc(ex.name)}</div>
      ${ex.category ? `<div class="li-sub"><span class="li-tag">${esc(ex.category)}</span></div>` : ''}</div>
      ${activeIds.has(ex.id) ? '<span class="muted small">dabei</span>' : '<span class="pr-flag">＋</span>'}
    </div>`).join('');
  openModal(`<h2>Übung hinzufügen</h2>${items}
    <button class="fab-add mt" data-action="new-exercise">＋ Neue Übung anlegen</button>`);
}

function openSessionDetail(id) {
  const s = store.db.sessions.find((x) => x.id === id);
  if (!s) return;
  const blocks = s.entries.map((e) => {
    const ex = exById(e.exerciseId);
    const sets = e.sets.filter((st) => num(st.reps) > 0).map((st, i) =>
      `<div class="set-row" style="grid-template-columns:26px 1fr 1fr${ex && ex.usesBands ? ' 1fr' : ''}">
        <div class="set-idx">${i + 1}</div>
        <div class="muted">${num(st.reps)} WH</div>
        <div class="muted">${st.weight ? fmtWeight(st.weight) + ' kg' : 'Körpergew.'}</div>
        ${ex && ex.usesBands ? `<div class="muted">${st.band ? 'Band ' + st.band : '–'}</div>` : ''}
      </div>`).join('');
    return `<div class="ex-block" style="margin-bottom:10px"><div class="ex-head"><div class="ex-name">${esc((ex || {}).name || 'Übung')}</div></div>${sets || '<p class="muted small" style="padding:0 16px 12px">Keine Sätze</p>'}</div>`;
  }).join('');
  openModal(`
    <h2>${esc(fmtDateLong(s.dateISO))}</h2>
    ${blocks || '<p class="muted">Keine Übungen.</p>'}
    <button class="btn btn-danger mt" data-action="delete-session" data-id="${s.id}">Training löschen</button>
  `);
}

function openSettings() {
  const st = store.db.settings;
  openModal(`
    <h2>Einstellungen</h2>
    <div class="card">
      <div class="switch-row">
        <div><div class="sw-label">Helles Design</div><div class="sw-sub">Zwischen Dunkel und Hell wechseln</div></div>
        <label class="switch"><input type="checkbox" data-action="toggle-theme" ${st.theme === 'light' ? 'checked' : ''}><span class="slider"></span></label>
      </div>
    </div>
    <div class="field">
      <label>Standard-Pausendauer</label>
      <select class="input" data-action="set-rest">
        ${[60, 90, 120, 150, 180, 240, 300].map((s) => `<option value="${s}" ${st.restDefaultSec === s ? 'selected' : ''}>${s < 60 ? s + ' Sek' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' Min'}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Wochenziel (Trainings pro Woche)</label>
      <select class="input" data-action="set-goal">
        ${[1, 2, 3, 4, 5, 6].map((g) => `<option value="${g}" ${st.weeklyGoal === g ? 'selected' : ''}>${g}× pro Woche</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Einheit</label>
      <input class="input" value="Kilogramm (kg)" disabled>
    </div>
    <div class="section-title mt">Datensicherung</div>
    <div class="btn-row">
      <button class="btn btn-ghost btn-sm" data-action="export-data">Backup exportieren</button>
      <button class="btn btn-ghost btn-sm" data-action="import-data">Backup importieren</button>
    </div>
    <input type="file" id="import-file" accept="application/json,.json" class="hidden">
    <button class="btn btn-danger mt" data-action="reset-data">Alle Daten löschen</button>
    <p class="muted small mt" style="text-align:center">Daten liegen nur lokal auf diesem Gerät.</p>
  `);
}

/* ============================================================
   Rest-Timer (iOS-taugliches Beep-Pattern)
   ============================================================ */
const restTimer = {
  remaining: 0, iv: null, audioReady: false,
  unlock() {
    if (this.audioReady) return;
    const a = $('#beep');
    if (!a) return;
    a.muted = true;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; this.audioReady = true; }).catch(() => {});
  },
  start(seconds) {
    this.stop(true);
    this.remaining = seconds;
    const el = $('#rest-timer');
    el.classList.remove('hidden');
    this.tickUI();
    this.iv = setInterval(() => {
      this.remaining--;
      if (this.remaining <= 0) { this.finish(); }
      else this.tickUI();
    }, 1000);
  },
  tickUI() {
    const m = Math.floor(this.remaining / 60), s = this.remaining % 60;
    $('#rest-count').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    $('#rest-timer').classList.toggle('ending', this.remaining <= 5);
  },
  adjust(delta) {
    this.remaining = Math.max(1, this.remaining + delta);
    this.tickUI();
  },
  finish() {
    this.beep();
    if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    this.stop();
  },
  beep() {
    const a = $('#beep');
    if (!a) return;
    try { a.currentTime = 0; a.play().catch(() => {}); } catch (e) {}
  },
  stop(silent) {
    if (this.iv) clearInterval(this.iv);
    this.iv = null;
    const el = $('#rest-timer');
    if (el) { el.classList.add('hidden'); el.classList.remove('ending'); }
  }
};

/* ============================================================
   Aktionen / Event-Delegation
   ============================================================ */
function buildEntry(exId) {
  const ex = exById(exId);
  const sug = suggestWeight(exId);
  const entry = { exerciseId: exId, sets: [], _sug: sug };
  const nSets = Math.max(1, (ex.defaultSets ?? 3));
  for (let k = 0; k < nSets; k++) {
    entry.sets.push({ reps: '', weight: sug.weight || '', band: '', done: false });
  }
  return entry;
}

function newActiveSession() {
  // Favoriten automatisch vorbereiten – in gespeicherter Reihenfolge (db.exercises).
  const favs = store.db.exercises.filter((ex) => ex.favorite);
  store.db.active = { id: uid(), dateISO: todayISO(), entries: favs.map((ex) => buildEntry(ex.id)), notes: '' };
  store.save();
}

// Übungs-Reihenfolge aus der aktuellen Session in db.exercises übernehmen
// (nur die beteiligten Übungen, deren Positionen untereinander getauscht werden).
function persistOrderFromEntries() {
  const ids = store.db.active.entries.map((e) => e.exerciseId).filter((id) => exById(id));
  const slots = [];
  store.db.exercises.forEach((ex, i) => { if (ids.includes(ex.id)) slots.push(i); });
  const ordered = ids.map((id) => exById(id));
  slots.forEach((slot, k) => { store.db.exercises[slot] = ordered[k]; });
}
function addSetToEntry(entry, copyFrom) {
  const prev = copyFrom || entry.sets[entry.sets.length - 1] || {};
  entry.sets.push({ reps: '', weight: prev.weight ?? '', band: prev.band ?? '', done: false });
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  restTimer.unlock(); // erste Nutzergeste entsperrt Audio
  if (!t) return;
  const action = t.dataset.action;
  const a = store.db.active;

  switch (action) {
    case 'start-session':
      newActiveSession(); render(); break;

    case 'discard-session':
      if (confirm('Aktuelles Training verwerfen?')) { store.db.active = null; store.save(); render(); }
      break;

    case 'finish-session': {
      if (!a) break;
      // Leere Sätze entfernen; Übungen ohne gültige Sätze verwerfen.
      a.entries.forEach((en) => { en.sets = en.sets.filter((s) => num(s.reps) > 0); delete en._sug; });
      a.entries = a.entries.filter((en) => en.sets.length > 0);
      if (!a.entries.length) { toast('Keine gültigen Sätze eingetragen'); break; }
      store.db.sessions.push(a);
      store.db.active = null;
      store.save();
      toast('Training gespeichert 💪');
      ui.tab = 'history';
      render();
      break;
    }

    case 'add-exercise':
      addExercisePicker(); break;

    case 'new-exercise':
      exerciseEditor(null); break;

    case 'pick-exercise': {
      const id = t.dataset.id;
      if (!a.entries.some((en) => en.exerciseId === id)) {
        a.entries.push(buildEntry(id));
        ui.expanded.add(id); // frisch hinzugefügte Übung direkt aufgeklappt
        store.save();
      }
      closeModal(); render();
      break;
    }

    case 'toggle-expand': {
      const id = t.dataset.exid;
      if (ui.expanded.has(id)) ui.expanded.delete(id); else ui.expanded.add(id);
      render();
      break;
    }

    case 'toggle-fav': {
      const ex = exById(t.dataset.id);
      if (ex) { ex.favorite = !ex.favorite; store.save(); render(); }
      break;
    }

    case 'add-set': {
      const en = a.entries[+t.dataset.ei];
      addSetToEntry(en);
      store.save(); render();
      break;
    }

    case 'remove-exercise': {
      a.entries.splice(+t.dataset.ei, 1);
      store.save(); render();
      break;
    }

    case 'toggle-set': {
      const en = a.entries[+t.dataset.ei];
      const set = en.sets[+t.dataset.si];
      set.done = !set.done;
      store.save();
      render();
      if (set.done && num(set.reps) > 0) restTimer.start(store.db.settings.restDefaultSec);
      break;
    }

    case 'edit-exercise':
      exerciseEditor(t.dataset.id); break;

    case 'delete-exercise': {
      const id = t.dataset.id;
      if (confirm('Übung löschen? Vergangene Trainings bleiben erhalten.')) {
        store.db.exercises = store.db.exercises.filter((x) => x.id !== id);
        store.save(); closeModal(); render();
      }
      break;
    }

    case 'select-metric':
      ui.progressMetric = t.dataset.metric; render(); break;

    case 'open-session':
      openSessionDetail(t.dataset.id); break;

    case 'open-day':
      openDay(t.dataset.date); break;

    case 'cal-prev':
      ui.calMonth = new Date((ui.calMonth || new Date()).getFullYear(), (ui.calMonth || new Date()).getMonth() - 1, 1);
      render(); break;

    case 'cal-next':
      ui.calMonth = new Date((ui.calMonth || new Date()).getFullYear(), (ui.calMonth || new Date()).getMonth() + 1, 1);
      render(); break;

    case 'delete-session': {
      const id = t.dataset.id;
      store.db.sessions = store.db.sessions.filter((x) => x.id !== id);
      store.save(); closeModal(); render();
      break;
    }

    case 'close-modal-bg':
      if (e.target === t) closeModal(); break;

    // Settings
    case 'export-data': exportData(); break;
    case 'import-data': $('#import-file').click(); break;
    case 'reset-data':
      if (confirm('Wirklich ALLE Daten löschen? Nicht umkehrbar.')) {
        store.db = structuredClone(DEFAULTS); store.save(); closeModal(); applyTheme(); render();
      }
      break;

    // Rest timer buttons
    case undefined: break;
  }
});

// Rest-Timer-Buttons (feste IDs)
$('#rest-add').addEventListener('click', () => restTimer.adjust(15));
$('#rest-sub').addEventListener('click', () => restTimer.adjust(-15));
$('#rest-skip').addEventListener('click', () => restTimer.stop());

// Tabbar
$('#tabbar').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  restTimer.unlock();
  ui.tab = tab.dataset.tab;
  render();
});

// Header settings
$('#settings-btn').addEventListener('click', () => { restTimer.unlock(); openSettings(); });

/* ============================================================
   Drag & Drop: Übungen im Training per Griff verschieben
   ============================================================ */
let dnd = null;

document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-drag]');
  if (!handle || !store.db.active) return;
  const block = handle.closest('.ex-block');
  const container = block.parentElement;
  const items = [...container.querySelectorAll('.ex-block')];
  const index = items.indexOf(block);
  if (index < 0) return;
  e.preventDefault();
  const rects = items.map((el) => el.getBoundingClientRect());
  dnd = {
    pointerId: e.pointerId, block, container, items, rects, index,
    startY: e.clientY, unit: rects[index].height + 14, targetK: index, moved: false
  };
  try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  block.classList.add('dragging');
});

document.addEventListener('pointermove', (e) => {
  if (!dnd || e.pointerId !== dnd.pointerId) return;
  e.preventDefault();
  dnd.moved = true;
  const dy = e.clientY - dnd.startY;
  dnd.block.style.transform = `translateY(${dy}px)`;

  // Einfügeposition = Anzahl anderer Karten, deren Mitte oberhalb des Zeigers liegt
  let k = 0;
  dnd.rects.forEach((r, i) => {
    if (i === dnd.index) return;
    if (e.clientY > r.top + r.height / 2) k++;
  });
  dnd.targetK = k;

  // Lücke visualisieren
  dnd.items.forEach((el, i) => {
    if (i === dnd.index) return;
    let shift = 0;
    if (k <= dnd.index) { if (i >= k && i < dnd.index) shift = dnd.unit; }
    else { if (i > dnd.index && i <= k) shift = -dnd.unit; }
    el.style.transform = shift ? `translateY(${shift}px)` : '';
    el.style.transition = 'transform .15s';
  });
});

function endDrag(e) {
  if (!dnd || e.pointerId !== dnd.pointerId) return;
  const { index, targetK, moved } = dnd;
  dnd.block.classList.remove('dragging');
  dnd = null;
  if (moved && targetK !== index) {
    const arr = store.db.active.entries;
    const [it] = arr.splice(index, 1);
    arr.splice(targetK, 0, it);
    persistOrderFromEntries();
    store.save();
  }
  render();
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

// Eingaben in Sätze (Delegation über change/input)
document.addEventListener('input', (e) => {
  if (!store.db.active) return;
  // Gewicht gilt für alle Sätze der Übung
  const ew = e.target.closest('[data-entry-weight]');
  if (ew) {
    const en = store.db.active.entries[+ew.dataset.ei];
    if (en) { en.sets.forEach((s) => { s.weight = ew.value; }); store.save(); }
    return;
  }
  const inp = e.target.closest('[data-field]');
  if (!inp) return;
  const en = store.db.active.entries[+inp.dataset.ei];
  if (!en) return;
  const set = en.sets[+inp.dataset.si];
  if (!set) return;
  set[inp.dataset.field] = inp.value;
  store.save();
});

// Formular Übung
document.addEventListener('submit', (e) => {
  if (e.target.id === 'ex-form') {
    e.preventDefault();
    const exId = e.target.exId.value || null;
    saveExerciseFromForm(exId);
  }
});

// Settings-Änderungen
document.addEventListener('change', (e) => {
  const act = e.target.closest('[data-action]');
  if (act) {
    if (act.dataset.action === 'toggle-theme') {
      store.db.settings.theme = e.target.checked ? 'light' : 'dark';
      store.save(); applyTheme();
    } else if (act.dataset.action === 'set-rest') {
      store.db.settings.restDefaultSec = +e.target.value; store.save();
    } else if (act.dataset.action === 'set-goal') {
      store.db.settings.weeklyGoal = +e.target.value; store.save();
    } else if (act.dataset.action === 'select-progress-ex') {
      ui.progressExId = e.target.value; render();
    }
  }
  if (e.target.id === 'import-file') importData(e.target.files[0]);
});

/* ---------- Export / Import ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(store.db, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `krafttraining-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Backup exportiert');
}
function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object' || !Array.isArray(data.exercises)) throw new Error('Ungültig');
      if (!confirm('Backup importieren? Aktuelle Daten werden ersetzt.')) return;
      store.db = data;
      for (const k of Object.keys(DEFAULTS)) if (!(k in store.db)) store.db[k] = structuredClone(DEFAULTS[k]);
      for (const k of Object.keys(DEFAULTS.settings)) if (!(k in store.db.settings)) store.db.settings[k] = DEFAULTS.settings[k];
      store.save();
      closeModal(); applyTheme(); render();
      toast('Backup importiert');
    } catch (err) {
      toast('Import fehlgeschlagen – Datei ungültig');
    }
  };
  reader.readAsText(file);
}

/* ---------- Theme + Init ---------- */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', store.db.settings.theme || 'dark');
  const tc = store.db.settings.theme === 'light' ? '#f4f5f8' : '#0f1115';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', tc);
}

function init() {
  store.load();
  applyTheme();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
