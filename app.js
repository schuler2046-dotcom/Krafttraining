'use strict';

/* ============================================================
   Krafttraining Tracker – vanilla PWA
   Datenmodell in localStorage, ein JSON-Objekt.
   ============================================================ */

const STORAGE_KEY = 'kraft_tracker_v1';
const DEFAULTS = {
  settings: { unit: 'kg', restDefaultSec: 120, theme: 'dark' },
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
const todayISO = () => new Date().toISOString().slice(0, 10);
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
  progressMetric: 'maxWeight'
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
        <p class="muted small">Starte eine neue Einheit und trage Sätze, Wiederholungen und Zusatzgewicht ein.</p>
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
        <input class="set-input${done}" type="number" inputmode="decimal" min="0" step="0.5" placeholder="0"
               value="${set.weight ?? ''}" data-ei="${ei}" data-si="${si}" data-field="weight" aria-label="Gewicht kg">
        ${bandCell}
        <button class="set-check${done}" data-action="toggle-set" data-ei="${ei}" data-si="${si}" aria-label="Satz erledigt">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        </button>
      </div>
      ${isPR ? `<div style="padding:0 16px 4px 60px"><span class="pr-flag">★ Neuer Rekord</span></div>` : ''}
    `;
  }).join('');

  return `
    <div class="ex-block${withBand}" style="--x:0">
      <div class="ex-head">
        <div>
          <div class="ex-name">${esc(ex.name)}</div>
          ${hint}
        </div>
      </div>
      <div class="set-head">
        <div>#</div><div>WDH</div><div>KG</div>${ex.usesBands ? '<div>BAND</div>' : ''}<div></div>
      </div>
      ${rows}
      <div class="ex-actions">
        <button class="link-btn" data-action="add-set" data-ei="${ei}">＋ Satz</button>
        <button class="link-btn danger" data-action="remove-exercise" data-ei="${ei}">Entfernen</button>
      </div>
    </div>
  `;
}

/* ============================================================
   VIEW: Verlauf
   ============================================================ */
function computeStreak() {
  const days = new Set(store.db.sessions.map((s) => s.dateISO));
  let streak = 0;
  const d = new Date();
  // Erlaube "heute noch nicht trainiert": starte ggf. bei gestern.
  if (!days.has(d.toISOString().slice(0, 10))) d.setDate(d.getDate() - 1);
  for (;;) {
    const iso = d.toISOString().slice(0, 10);
    if (days.has(iso)) { streak++; d.setDate(d.getDate() - 1); } else break;
  }
  return streak;
}

function sessionVolume(s) {
  let v = 0;
  for (const e of s.entries) for (const set of e.sets) v += num(set.reps) * num(set.weight);
  return v;
}

function viewHistory() {
  const sessions = [...store.db.sessions].sort((a, b) => b.dateISO.localeCompare(a.dateISO));
  if (!sessions.length) {
    return `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
      <h3>Noch kein Verlauf</h3>
      <p class="muted small">Abgeschlossene Trainings erscheinen hier.</p>
    </div>`;
  }
  const streak = computeStreak();
  const last7 = [...Array(7)].map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    const iso = d.toISOString().slice(0, 10);
    return store.db.sessions.some((s) => s.dateISO === iso);
  });
  const items = sessions.map((s) => {
    const names = s.entries.map((e) => (exById(e.exerciseId) || {}).name).filter(Boolean).join(' · ');
    const vol = sessionVolume(s);
    return `
      <div class="session-item" data-action="open-session" data-id="${s.id}">
        <div class="si-top">
          <span class="si-date">${esc(fmtDateLong(s.dateISO))}</span>
          <span class="si-vol">${vol > 0 ? fmtWeight(vol) + ' kg Vol.' : s.entries.reduce((a, e) => a + e.sets.length, 0) + ' Sätze'}</span>
        </div>
        <div class="si-ex">${esc(names || 'Keine Übungen')}</div>
      </div>`;
  }).join('');

  return `
    <div class="streak-row">
      <span class="streak-badge">🔥 ${streak} Tag${streak === 1 ? '' : 'e'} Streak</span>
      <div class="dots" style="margin-left:auto">
        ${last7.map((on) => `<span class="dot ${on ? 'on' : ''}"></span>`).join('')}
      </div>
    </div>
    <div class="section-title">${sessions.length} Training${sessions.length === 1 ? '' : 's'}</div>
    ${items}
  `;
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
    if (ex.usesBands) tags.push(`<span class="li-tag band">Bänder</span>`);
    if (ex.progression && ex.progression.enabled)
      tags.push(`<span class="li-tag">+${fmtWeight(ex.progression.stepKg)}kg @ ${ex.progression.triggerReps}WH</span>`);
    return `
      <div class="list-item" data-action="edit-exercise" data-id="${ex.id}">
        <div class="li-body">
          <div class="li-title">${esc(ex.name)}</div>
          <div class="li-sub">${tags.join('') || '<span class="muted">Keine Optionen</span>'}</div>
        </div>
        <svg class="li-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>`;
  }).join('');

  return `
    ${list.length ? `<div class="section-title">${list.length} Übung(en)</div>${items}` : `
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
      <div class="card" style="margin:4px 0 14px">
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
function newActiveSession() {
  store.db.active = { id: uid(), dateISO: todayISO(), entries: [], notes: '' };
  store.save();
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
        const sug = suggestWeight(id);
        const entry = { exerciseId: id, sets: [], _sug: sug };
        entry.sets.push({ reps: '', weight: sug.weight || '', band: '', done: false });
        a.entries.push(entry);
        store.save();
      }
      closeModal(); render();
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

// Eingaben in Sätze (Delegation über change/input)
document.addEventListener('input', (e) => {
  const inp = e.target.closest('[data-field]');
  if (!inp || !store.db.active) return;
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
