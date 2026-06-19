import { get, post, patch, put, del } from './api.js';

let state = null;

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (v === false || v == null) continue;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function nameOf(id) {
  if (id === '__bye__') return 'BYE';
  return state?.participants.find(p => p.id === id)?.name ?? id;
}

// -- Match grid helpers ------------------------------------------------------
// All match rows (group stage + bracket slots) share the same `.bracket-match`
// shape used by the public knockout view: two `.bm-row`s (one per player),
// each with a name cell + N set cells. Editable cells carry an `<input>`.
const MATCH_SET_COLS = 3;

function buildScoreInputs(score, setCols = MATCH_SET_COLS) {
  const p1Cells = [];
  const p2Cells = [];
  for (let i = 0; i < setCols; i++) {
    const a = score[i]?.[0] ?? null;
    const b = score[i]?.[1] ?? null;
    const ia = el('input', { class: 'score', type: 'number', min: 0, value: a ?? '', 'data-idx': i, 'data-side': 'a' });
    const ib = el('input', { class: 'score', type: 'number', min: 0, value: b ?? '', 'data-idx': i, 'data-side': 'b' });
    p1Cells.push(el('div', { class: 'bm-set bm-input' }, ia));
    p2Cells.push(el('div', { class: 'bm-set bm-input' }, ib));
  }
  return { p1Cells, p2Cells };
}

function readScoreFromContainer(container, setCols = MATCH_SET_COLS) {
  const score = [];
  for (let i = 0; i < setCols; i++) {
    const a = container.querySelector(`input[data-idx="${i}"][data-side="a"]`);
    const b = container.querySelector(`input[data-idx="${i}"][data-side="b"]`);
    const av = a?.value === '' ? null : Number(a?.value);
    const bv = b?.value === '' ? null : Number(b?.value);
    if (av == null || bv == null) continue;
    score.push([av, bv]);
  }
  return score;
}

function buildReadOnlySetCells(score, setCols = MATCH_SET_COLS) {
  const p1Cells = [];
  const p2Cells = [];
  for (let i = 0; i < setCols; i++) {
    const set = score[i];
    const a = set ? set[0] : null;
    const b = set ? set[1] : null;
    const aWon = a != null && b != null && a > b;
    const bWon = b != null && a != null && b > a;
    p1Cells.push(el('div', { class: 'bm-set' + (aWon ? ' set-won' : '') }, a == null ? '' : String(a)));
    p2Cells.push(el('div', { class: 'bm-set' + (bWon ? ' set-won' : '') }, b == null ? '' : String(b)));
  }
  return { p1Cells, p2Cells };
}

function buildWalkoverRows(p1Name, p2Name, winnerSide, spanCols) {
  const p1Won = winnerSide === 'p1';
  const p2Won = winnerSide === 'p2';
  return [
    el('div', { class: 'bm-row' + (p1Won ? ' winner' : '') },
      el('div', { class: 'bm-name' + (p1Won ? ' winner' : '') }, p1Name),
      el('div', { class: 'bm-walkover', style: `grid-column: span ${spanCols}` }, p1Won ? 'walkover' : ''),
    ),
    el('div', { class: 'bm-row' + (p2Won ? ' winner' : '') },
      el('div', { class: 'bm-name' + (p2Won ? ' winner' : '') }, p2Name),
      el('div', { class: 'bm-walkover', style: `grid-column: span ${spanCols}` }, p2Won ? 'walkover' : ''),
    ),
  ];
}

// Grid column templates per match-cell shape. Keep these in sync with the
// number of set columns + action columns each renderer adds.
const GRID = {
  groupActions: 'minmax(7rem, max-content) repeat(3, 2.4rem) auto auto',  // name + 3 sets + toggle/status + WO
  koActions:    'minmax(7rem, max-content) repeat(3, 2.4rem) auto auto auto',  // + win-for
  readOnly:     'minmax(7rem, max-content) repeat(3, 2.4rem)',
  walkoverGrp:  'minmax(7rem, max-content) auto',
  walkoverRO:   'minmax(7rem, max-content) auto',
};

function statusToggleCells(currentStatus, allowDone, onAdvance) {
  // Top cell = cycling toggle (▶ pending→live, ✓ live→done, ↺ done→pending).
  // For KO slots (allowDone=false) the toggle only swaps live↔pending; the
  // "done" state is reached by clicking the Win-for buttons in column 2.
  let icon, title;
  if (currentStatus === 'pending') { icon = '▶'; title = 'Mark live'; }
  else if (currentStatus === 'live') {
    icon = allowDone ? '✓' : '↺';
    title = allowDone ? 'Mark done' : 'Revert to pending';
  } else { icon = '↺'; title = 'Revert to pending'; }

  return {
    top: el('div', { class: 'bm-action bm-toggle' },
      el('button', { class: 'ghost', title, on: { click: onAdvance } }, icon),
    ),
    bottom: el('div', { class: 'bm-action bm-status' },
      el('span', { class: 'status ' + currentStatus }, currentStatus),
    ),
  };
}

async function refresh() {
  state = await get('/api/state');
  $('#tournament-name').textContent = state.tournament.name;
  const renamerInput = $('#rename input[name="name"]');
  if (renamerInput && document.activeElement !== renamerInput) renamerInput.value = state.tournament.name;
  renderParticipants();
  renderGroupsOverview();
  renderBulkDelete();
  renderGroupstage();
  renderMatches();
  renderBracket();
  renderBracketWizard();
  const nameInput = $('#add-group')?.elements.name;
  if (nameInput && document.activeElement !== nameInput) syncDefaultGroupName();
}

// -- Tabs ---------------------------------------------------------------------
const TAB_STORAGE_KEY = 'tp.activeTab';
$$('nav#tabs a').forEach(a => {
  a.addEventListener('click', () => activateTab(a.dataset.tab));
});
try {
  const saved = localStorage.getItem(TAB_STORAGE_KEY);
  if (saved && $$(`nav#tabs a[data-tab="${saved}"]`).length) {
    $$('nav#tabs a').forEach(x => x.classList.toggle('active', x.dataset.tab === saved));
    $$('section[data-tab]').forEach(s => s.classList.toggle('active', s.dataset.tab === saved));
  }
} catch {}

// -- Publish status -----------------------------------------------------------
let lastPendingCount = -1;
async function refreshPublishStatus() {
  try {
    const s = await get('/api/publish/status');
    const dot = $('#status-dot');
    const txt = $('#status-text');
    dot.className = 'dot';
    if (!s.configured) {
      dot.classList.add('amber');
      txt.textContent = 'AWS not configured (local only)';
    } else if (s.lastError) {
      dot.classList.add('red');
      txt.textContent = `Push failed — ${s.lastError.slice(0, 60)}`;
    } else if (s.pendingChanges > 0 || s.inFlight) {
      dot.classList.add('amber');
      txt.textContent = s.inFlight ? 'Pushing…' : `${s.pendingChanges} unpushed change(s)`;
    } else if (s.lastSuccess) {
      dot.classList.add('green');
      const ago = Math.round((Date.now() - new Date(s.lastSuccess).getTime()) / 1000);
      txt.textContent = `Synced ${ago}s ago`;
    } else {
      txt.textContent = 'Idle';
    }
    const dbg = $('#publish-debug');
    if (dbg) dbg.textContent = JSON.stringify(s, null, 2);
    // Re-render the Pending tab + badge only when the count actually changes,
    // so we're not rebuilding the DOM every 2 s during idle.
    if (s.pendingChanges !== lastPendingCount) {
      lastPendingCount = s.pendingChanges;
      renderPending();
    }
  } catch (err) {
    $('#status-text').textContent = 'Status unreachable';
  }
}
setInterval(refreshPublishStatus, 2000);

$('#force-publish').addEventListener('click', async () => {
  try {
    await post('/api/publish/force');
    await refreshPublishStatus();
  } catch (err) {
    alert('Publish failed: ' + err.message);
  }
});

$('#push-backup').addEventListener('click', async () => {
  try { await post('/api/publish/backup'); alert('Backup snapshot pushed.'); }
  catch (err) { alert('Backup failed: ' + err.message); }
});

$('#groups-overview-toggle').addEventListener('click', () => {
  toggleAllOverview($('#groups-overview'));
});
$('#matches-overview-toggle').addEventListener('click', () => {
  toggleAllOverview($('#matches-overview'));
});
$('#bracket-overview-toggle').addEventListener('click', () => {
  toggleAllOverview($('#bracket-overview'));
});

$$('.floating-jump').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.jumpTo);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// -- Participants -------------------------------------------------------------
const CATEGORY_ORDER = ['MS', 'WS', 'MD', 'WD', 'MX'];
const CATEGORY_LABEL = { MS: "Men's Singles", WS: "Women's Singles", MD: "Men's Doubles", WD: "Women's Doubles", MX: 'Mixed Doubles' };
const CLASS_ORDER = ['S', 'A', 'B', 'C', 'D'];
const DOUBLES = new Set(['MD', 'WD', 'MX']);

// Persist open/closed state across re-renders. Errors section defaults to open;
// categories default to open the first time they appear, then remember toggles.
const participantsOpen = new Map(); // key -> bool
function defaultOpen(key) {
  if (!participantsOpen.has(key)) participantsOpen.set(key, true);
  return participantsOpen.get(key);
}

function isMissingPartner(p) {
  return DOUBLES.has(p.category) && !p.name.includes(' & ');
}

function participantRow(p, opts = {}) {
  const rowClasses = [opts.error ? 'p-error' : '', p.withdrawn ? 'withdrawn-row' : ''].filter(Boolean).join(' ');
  return el('tr', { class: rowClasses },
    el('td', {}, p.name,
      p.withdrawn ? el('span', { class: 'badge warn', style: 'margin-left:0.4rem' }, 'withdrawn') : null,
    ),
    el('td', {}, p.club),
    el('td', { class: 'mono' }, p.category),
    el('td', { class: 'mono' }, p.class),
    el('td', { class: 'num' }, String(p.seed || '')),
    el('td', { class: 'p-note' },
      opts.error ? el('span', { class: 'badge badge-error', title: 'Doubles entry without a partner — pair them up before drawing groups.' }, 'no partner') : null,
    ),
    el('td', {},
      p.withdrawn
        ? el('button', { class: 'ghost', on: { click: async () => {
            if (!confirm(`Reinstate ${p.name}? They become eligible for future pairings. Existing walkover results stay — undo them per-match in Scoring/Bracket if needed.`)) return;
            await post(`/api/participants/${p.id}/reinstate`); await refresh();
          } } }, 'Reinstate')
        : el('button', { class: 'ghost', on: { click: async () => {
            if (!confirm(`Withdraw ${p.name}? All their unplayed group matches and their active bracket slot will be marked as walkovers for the opponent. Future round-robin pairings will be regenerated.`)) return;
            await post(`/api/participants/${p.id}/withdraw`); await refresh();
          } } }, 'Withdraw'),
      ' ',
      el('button', { class: 'ghost', on: { click: async () => {
        if (!confirm(`Remove ${p.name}?`)) return;
        await del(`/api/participants/${p.id}`); await refresh();
      } } }, 'Remove')),
  );
}

function participantsTable(rows) {
  return el('table', { class: 'participants-table' },
    el('thead', {},
      el('tr', {},
        el('th', {}, 'Name'),
        el('th', {}, 'Club'),
        el('th', {}, 'Cat.'),
        el('th', {}, 'Class'),
        el('th', { class: 'num' }, 'Seed'),
        el('th', {}, ''),
        el('th', {}, ''),
      ),
    ),
    el('tbody', {}, ...rows),
  );
}

async function bulkDelete(ids, label) {
  if (ids.length === 0) return;
  if (!confirm(`Delete ${ids.length} participant(s) — ${label}?\n\nThis also removes them from any group they're in.`)) return;
  await post('/api/participants/bulk-delete', { ids });
  await refresh();
}

function bulkDeleteBtn(label, ids, confirmLabel) {
  return el('button', {
    class: 'danger small',
    title: `Delete ${ids.length} participant(s)`,
    on: { click: (e) => {
      // Stop the click from toggling the <details> when this button lives in a <summary>.
      e.preventDefault();
      e.stopPropagation();
      bulkDelete(ids, confirmLabel);
    } },
  }, label);
}

function classDivider(cls, list) {
  return el('tr', { class: 'class-divider' },
    el('td', { colspan: '6' },
      el('span', { class: 'mono' }, `Class ${cls || '·'}`),
      el('span', { class: 'muted' }, ` · ${list.length}`),
    ),
    el('td', { class: 'class-divider-actions' },
      bulkDeleteBtn(`Delete ${list.length}`, list.map(p => p.id), `class ${cls || '·'}`),
    ),
  );
}

function makeSection(key, summary, body) {
  const open = defaultOpen(key);
  return el('details', {
    class: 'participants-section',
    ...(open ? { open: true } : {}),
    on: { toggle: (e) => participantsOpen.set(key, e.target.open) },
  },
    el('summary', {}, summary),
    body,
  );
}

function renderParticipants() {
  const root = $('#participants-list');
  const toolbar = $('#participants-toolbar');
  const all = state.participants;
  const errors = all.filter(isMissingPartner);
  const sorted = (arr) => [...arr].sort((a, b) => a.name.localeCompare(b.name));

  // Top-level toolbar: total count + "delete all".
  if (toolbar) {
    toolbar.replaceChildren(
      el('div', { class: 'participants-summary' },
        el('span', { class: 'muted' }, `${all.length} participant${all.length === 1 ? '' : 's'}`),
        all.length > 0
          ? bulkDeleteBtn(`Delete all ${all.length}`, all.map(p => p.id), 'every participant in the tournament')
          : null,
      ),
    );
  }

  const sections = [];

  // Errors at the top.
  if (errors.length > 0) {
    const grouped = new Map();
    for (const p of errors) {
      const k = p.category || '·';
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(p);
    }
    const rows = [];
    for (const cat of CATEGORY_ORDER) {
      const list = grouped.get(cat);
      if (!list) continue;
      rows.push(classDivider(`${cat} · missing partner`, list));
      for (const p of sorted(list)) rows.push(participantRow(p, { error: true }));
    }
    sections.push(makeSection(
      '__errors__',
      el('span', { class: 'section-summary' },
        el('span', {},
          el('span', { class: 'badge badge-error' }, 'Errors'),
          ' Doubles entries without a partner',
          el('span', { class: 'muted' }, ` · ${errors.length}`),
        ),
        bulkDeleteBtn(`Delete all ${errors.length}`, errors.map(p => p.id), 'all errors (missing partner)'),
      ),
      participantsTable(rows),
    ));
  }

  // Regular categories.
  const byCat = new Map();
  for (const p of all) {
    if (isMissingPartner(p)) continue;
    const cat = p.category || '·';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(p);
  }

  const seen = new Set();
  for (const cat of CATEGORY_ORDER) {
    const list = byCat.get(cat);
    if (!list) continue;
    seen.add(cat);
    sections.push(renderCategorySection(cat, list, sorted));
  }
  // Any non-standard categories (e.g. legacy empty) at the end.
  for (const [cat, list] of byCat) {
    if (seen.has(cat)) continue;
    sections.push(renderCategorySection(cat, list, sorted));
  }

  if (sections.length === 0) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No participants yet.'));
    return;
  }
  root.replaceChildren(...sections);
}

function renderCategorySection(cat, list, sorted) {
  const byClass = new Map();
  for (const p of list) {
    const c = p.class || '·';
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(p);
  }
  const rows = [];
  const seenCls = new Set();
  for (const cls of CLASS_ORDER) {
    const arr = byClass.get(cls);
    if (!arr) continue;
    seenCls.add(cls);
    rows.push(classDivider(cls, arr));
    for (const p of sorted(arr)) rows.push(participantRow(p));
  }
  for (const [cls, arr] of byClass) {
    if (seenCls.has(cls)) continue;
    rows.push(classDivider(cls, arr));
    for (const p of sorted(arr)) rows.push(participantRow(p));
  }
  const label = CATEGORY_LABEL[cat] ?? cat;
  return makeSection(
    `cat:${cat}`,
    el('span', { class: 'section-summary' },
      el('span', {},
        el('span', { class: 'mono cat-tag' }, cat),
        ' ',
        label,
        el('span', { class: 'muted' }, ` · ${list.length}`),
      ),
      bulkDeleteBtn(`Delete all ${list.length}`, list.map(p => p.id), `${label} (${cat}, all classes)`),
    ),
    participantsTable(rows),
  );
}

function participantFormMissing() {
  const form = $('#add-participant');
  const missing = [];
  if (!form.elements.category.value) missing.push('category');
  if (!form.elements.class.value) missing.push('class');
  return missing;
}

function setParticipantFormErrors(missing) {
  const form = $('#add-participant');
  const errEl = $('#add-participant-error');
  form.elements.category.classList.toggle('invalid', missing.includes('category'));
  form.elements.class.classList.toggle('invalid', missing.includes('class'));
  if (missing.length === 0) {
    errEl.hidden = true;
    errEl.textContent = '';
    return;
  }
  const parts = [];
  if (missing.includes('category')) parts.push('a category');
  if (missing.includes('class')) parts.push('a class');
  errEl.textContent = `Pick ${parts.join(' and ')}.`;
  errEl.hidden = false;
}

$('#add-participant').addEventListener('change', (e) => {
  if (e.target.name === 'category' || e.target.name === 'class') {
    if (!$('#add-participant-error').hidden) setParticipantFormErrors(participantFormMissing());
  }
});

$('#add-participant').addEventListener('submit', async (e) => {
  e.preventDefault();
  const missing = participantFormMissing();
  if (missing.length > 0) { setParticipantFormErrors(missing); return; }
  const fd = new FormData(e.target);
  await post('/api/participants', {
    name: fd.get('name'),
    club: fd.get('club') || '',
    category: fd.get('category'),
    class: fd.get('class'),
    seed: Number(fd.get('seed') || 0),
  });
  e.target.reset();
  setParticipantFormErrors([]);
  await refresh();
});

$('#import-csv').addEventListener('submit', async (e) => {
  e.preventDefault();
  const csv = new FormData(e.target).get('csv');
  if (!csv) return;
  await post('/api/participants/import-csv', { csv });
  e.target.reset();
  await refresh();
});

// -- Groups -------------------------------------------------------------------
function classList(g) {
  return Array.isArray(g.classes) ? g.classes : [];
}

function eligibleForGroup(g, p) {
  if (g.category && p.category !== g.category) return false;
  const cls = classList(g);
  if (cls.length && !cls.includes(p.class)) return false;
  return true;
}

function groupLabel(g) {
  const cls = classList(g).join('/');
  const tag = [g.category, cls].filter(Boolean).join('-');
  return tag ? `${tag} · ${g.mode}` : g.mode;
}

// -- Overview tree -----------------------------------------------------------
// Persisted open/closed state for tree-grouped overviews on Groups and Matches.
// Categories default open, classes default closed.
const overviewOpen = new Map();
function isOverviewOpen(key, defaultOpen) {
  return overviewOpen.has(key) ? overviewOpen.get(key) : defaultOpen;
}

function renderOverviewTree({ rootEl, items, getCat, getCls, prefix, renderItem, flatClasses = false }) {
  if (items.length === 0) {
    rootEl.replaceChildren(el('p', { class: 'muted' }, 'Nothing here yet.'));
    return;
  }
  const byCat = new Map();
  for (const item of items) {
    const cat = getCat(item) || '';
    const cls = getCls(item) || '';
    if (!byCat.has(cat)) byCat.set(cat, new Map());
    const cm = byCat.get(cat);
    if (!cm.has(cls)) cm.set(cls, []);
    cm.get(cls).push(item);
  }

  const orderByPreset = (have, preset) => {
    const seen = new Set();
    const out = [];
    for (const k of preset) if (have.has(k)) { out.push(k); seen.add(k); }
    for (const k of have.keys()) if (!seen.has(k)) out.push(k);
    return out;
  };

  const renderCat = (cat) => {
    const catKey = `${prefix}:cat:${cat}`;
    const clsMap = byCat.get(cat);
    const total = [...clsMap.values()].reduce((s, a) => s + a.length, 0);
    const classKeys = orderByPreset(clsMap, CLASS_ORDER);

    const childNodes = flatClasses
      ? [el('ul', { class: 'overview-list' },
          ...classKeys.flatMap(cls => clsMap.get(cls).map(renderItem)))]
      : classKeys.map(cls => {
          const clsKey = `${prefix}:cls:${cat}:${cls}`;
          const list = clsMap.get(cls);
          return el('details', {
            class: 'overview-class',
            'data-overview-key': clsKey,
            ...(isOverviewOpen(clsKey, false) ? { open: true } : {}),
            on: { toggle: (e) => overviewOpen.set(clsKey, e.target.open) },
          },
            el('summary', {},
              el('span', {}, `Class ${cls || '·'}`),
              el('span', { class: 'muted' }, ` · ${list.length}`),
            ),
            el('ul', { class: 'overview-list' }, ...list.map(renderItem)),
          );
        });

    const label = CATEGORY_LABEL[cat] ?? (cat || '(no category)');
    return el('details', {
      class: 'overview-cat',
      'data-overview-key': catKey,
      ...(isOverviewOpen(catKey, true) ? { open: true } : {}),
      on: { toggle: (e) => overviewOpen.set(catKey, e.target.open) },
    },
      el('summary', {},
        el('span', { class: 'mono cat-tag' }, cat || '·'),
        el('span', {}, label),
        el('span', { class: 'muted' }, ` · ${total}`),
      ),
      ...childNodes,
    );
  };

  const SINGLES = new Set(['MS', 'WS']);
  const allCats = orderByPreset(byCat, CATEGORY_ORDER);
  const singlesCats = allCats.filter(c => SINGLES.has(c));
  const otherCats = allCats.filter(c => !SINGLES.has(c));

  rootEl.replaceChildren(el('div', { class: 'overview-cols' },
    el('div', { class: 'overview-col' },
      el('h4', { class: 'overview-col-title' }, 'Singles'),
      singlesCats.length === 0
        ? el('p', { class: 'muted' }, '—')
        : el('div', {}, ...singlesCats.map(renderCat)),
    ),
    el('div', { class: 'overview-col' },
      el('h4', { class: 'overview-col-title' }, 'Doubles & Mix'),
      otherCats.length === 0
        ? el('p', { class: 'muted' }, '—')
        : el('div', {}, ...otherCats.map(renderCat)),
    ),
  ));
}

function toggleAllOverview(rootEl) {
  const all = [...rootEl.querySelectorAll('details[data-overview-key]')];
  if (all.length === 0) return;
  const target = all.some(d => !d.open);
  for (const d of all) d.open = target;
}

// Preserve which group cards have their "Add/remove members" panel open
// across re-renders (every checkbox tick triggers a full refresh()).
const groupDetailsOpen = new Set();

function renderMembersPanel(g) {
  // Members already assigned to any *other* group are not offered for this one.
  const claimedByOther = new Map();
  for (const grp of state.groups) {
    for (const m of grp.members) {
      if (!claimedByOther.has(m)) claimedByOther.set(m, grp.name);
    }
  }
  const memberIds = new Set(g.members);
  const shown = state.participants.filter(p => {
    if (p.withdrawn) return false;
    if (memberIds.has(p.id)) return true;
    if (!eligibleForGroup(g, p)) return false;
    const owner = claimedByOther.get(p.id);
    return !owner || owner === g.name;
  });
  const restricted = !!(g.category || classList(g).length);
  const tag = [g.category, classList(g).join('/')].filter(Boolean).join('-');

  return el('details', {
    ...(groupDetailsOpen.has(g.id) ? { open: true } : {}),
    on: { toggle: (e) => {
      if (e.target.open) groupDetailsOpen.add(g.id);
      else groupDetailsOpen.delete(g.id);
    } },
  },
    el('summary', {}, `Add/remove members${restricted ? ` — ${shown.length} eligible` : ''}`),
    shown.length === 0
      ? el('p', { class: 'muted' }, restricted
          ? `No participants match ${tag}.`
          : 'No participants yet.')
      : el('div', { class: 'row' },
          ...shown.map(p =>
            el('label', { class: 'row' },
              el('input', {
                type: 'checkbox',
                ...(memberIds.has(p.id) ? { checked: true } : {}),
                on: { change: async (e) => {
                  const checked = e.target.checked;
                  const members = checked
                    ? [...g.members, p.id]
                    : g.members.filter(m => m !== p.id);
                  await patch(`/api/groups/${g.id}`, { members });
                  await refresh();
                } },
              }),
              p.name,
              el('span', { class: 'muted' }, ` ${p.club ? '· ' + p.club : ''}`),
            ),
          ),
        ),
  );
}

function matchProgress(g) {
  let done = 0, total = 0;
  for (const r of g.rounds) for (const m of r.matches) {
    if (m.p1 === '__bye__' || m.p2 === '__bye__') continue;
    total++;
    if (m.status === 'done') done++;
  }
  return { done, total };
}

function renderGroupsOverview() {
  const root = $('#groups-overview');
  const jumpTo = (id) => (e) => {
    e.preventDefault();
    const card = document.getElementById(id);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  renderOverviewTree({
    rootEl: root,
    items: state.groups,
    getCat: g => g.category,
    getCls: g => classList(g).join('/'),
    prefix: 'g',
    renderItem: (g) => {
      const { done, total } = matchProgress(g);
      return el('li', {},
        el('a', { href: `#group-${g.id}`, on: { click: jumpTo(`group-${g.id}`) } }, g.name),
        el('span', { class: 'muted' }, ` · ${g.mode} · ${g.members.length} member${g.members.length === 1 ? '' : 's'}`),
        total > 0 ? el('span', { class: 'muted' }, ` · ${done}/${total} matches`) : null,
      );
    },
  });
}

// Default name format: "<category>-<classes joined by /> <n>", where n is the
// next sequence number among existing groups with the same category+classes.
// Falls back to "Group <n>" when neither is set.
function defaultGroupName(category, classes) {
  const tag = [category, classes.join('/')].filter(Boolean).join('-') || 'Group';
  const prefix = tag + ' ';
  const taken = new Set(
    (state?.groups ?? [])
      .filter(g => (g.category || '') === category
        && classList(g).join('/') === classes.join('/'))
      .map(g => g.name),
  );
  let n = 1;
  while (taken.has(prefix + n)) n++;
  return prefix + n;
}

function readGroupFormSelection(form) {
  const fd = new FormData(form);
  return {
    category: fd.get('category') || '',
    classes: [...fd.getAll('classes')].map(String),
  };
}

function syncDefaultGroupName() {
  const form = $('#add-group');
  if (!form) return;
  const { category, classes } = readGroupFormSelection(form);
  form.elements.name.value = defaultGroupName(category, classes);
}

function groupFormMissing() {
  const { category, classes } = readGroupFormSelection($('#add-group'));
  const missing = [];
  if (!category) missing.push('category');
  if (classes.length === 0) missing.push('classes');
  return missing;
}

// Toggle .invalid styling on the category select / classes fieldset and write a
// single-line hint into #add-group-error. Empty `missing` clears everything.
function setGroupFormErrors(missing) {
  const form = $('#add-group');
  const errEl = $('#add-group-error');
  form.elements.category.classList.toggle('invalid', missing.includes('category'));
  form.querySelector('fieldset[data-name="classes"]')
    .classList.toggle('invalid', missing.includes('classes'));
  if (missing.length === 0) {
    errEl.hidden = true;
    errEl.textContent = '';
    return;
  }
  const parts = [];
  if (missing.includes('category')) parts.push('a category');
  if (missing.includes('classes')) parts.push('at least one class');
  errEl.textContent = `Pick ${parts.join(' and ')}.`;
  errEl.hidden = false;
}

$('#add-group').addEventListener('change', (e) => {
  if (e.target.name === 'category' || e.target.name === 'classes') {
    syncDefaultGroupName();
    // Only re-validate once an error is already showing — avoids marking
    // fields red before the operator has tried to submit.
    if (!$('#add-group-error').hidden) setGroupFormErrors(groupFormMissing());
  }
});

$('#add-group').addEventListener('submit', async (e) => {
  e.preventDefault();
  const missing = groupFormMissing();
  if (missing.length > 0) { setGroupFormErrors(missing); return; }
  const fd = new FormData(e.target);
  await post('/api/groups', {
    name: fd.get('name'),
    mode: fd.get('mode'),
    category: fd.get('category') || '',
    classes: [...fd.getAll('classes')].map(String),
    members: [],
  });
  e.target.reset();
  setGroupFormErrors([]);
  await refresh();
  syncDefaultGroupName();
});

// Snake-seed N members across `numGroups` buckets of `perGroup` each. Top
// seeds spread evenly; unseeded (seed===0) sort to the end.
function snakeSeedIds(members, numGroups, perGroup) {
  const ranked = [...members].sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
  const buckets = Array.from({ length: numGroups }, () => []);
  for (let i = 0; i < numGroups * perGroup; i++) {
    const lap = Math.floor(i / numGroups);
    const col = i % numGroups;
    const idx = lap % 2 === 0 ? col : numGroups - 1 - col;
    buckets[idx].push(ranked[i].id);
  }
  return buckets;
}

// Pre-allocate `count` non-colliding group names for the given (category, classes).
// `extraTaken` lets the caller reserve names already chosen in the same batch.
function reserveGroupNames(category, classes, count, extraTaken = new Set()) {
  const tag = [category, classes.join('/')].filter(Boolean).join('-') || 'Group';
  const prefix = tag + ' ';
  const taken = new Set(extraTaken);
  for (const g of state?.groups ?? []) {
    if ((g.category || '') === category && classList(g).join('/') === classes.join('/')) {
      taken.add(g.name);
    }
  }
  const names = [];
  let n = 1;
  while (names.length < count) {
    const candidate = prefix + n++;
    if (!taken.has(candidate)) { names.push(candidate); taken.add(candidate); }
  }
  return names;
}

$('#auto-generate-groups').addEventListener('click', async () => {
  const form = $('#add-group');
  const fd = new FormData(form);
  const category = fd.get('category') || '';
  const selectedClasses = [...fd.getAll('classes')].map(String);
  const mode = fd.get('mode') || 'round_robin';
  const playersPerGroup = Number(fd.get('playersPerGroup') || 0);

  const missing = groupFormMissing();
  if (missing.length > 0) { setGroupFormErrors(missing); return; }
  if (!Number.isFinite(playersPerGroup) || playersPerGroup < 2) {
    return alert('Players per group must be at least 2.');
  }

  const claimed = new Set(state.groups.flatMap(g => g.members));
  const noClass = selectedClasses.length === 0;

  // Build `plans`: each entry becomes one group { name, classes, memberIds }.
  // When no class is selected we bucket by participant class — each generated
  // group ends up with exactly one class, reflected in its name.
  const plans = [];
  let totalLeftover = 0;
  let skippedNoClass = 0;

  const planBatch = (classesForGroup, eligible) => {
    const n = Math.floor(eligible.length / playersPerGroup);
    totalLeftover += eligible.length - n * playersPerGroup;
    if (n === 0) return;
    const names = reserveGroupNames(category, classesForGroup, n);
    const buckets = snakeSeedIds(eligible, n, playersPerGroup);
    for (let i = 0; i < n; i++) {
      plans.push({ name: names[i], classes: classesForGroup, memberIds: buckets[i] });
    }
  };

  if (noClass) {
    const byClass = new Map();
    for (const p of state.participants) {
      if (claimed.has(p.id)) continue;
      if (p.category !== category) continue;
      if (!p.class) { skippedNoClass++; continue; }
      if (!byClass.has(p.class)) byClass.set(p.class, []);
      byClass.get(p.class).push(p);
    }
    for (const cls of [...byClass.keys()].sort()) {
      planBatch([cls], byClass.get(cls));
    }
  } else {
    const eligible = state.participants.filter(p => {
      if (claimed.has(p.id)) return false;
      if (p.category !== category) return false;
      return selectedClasses.includes(p.class);
    });
    planBatch(selectedClasses, eligible);
  }

  if (plans.length === 0) {
    const detail = noClass
      ? `No class selected, and no class for ${category} has at least ${playersPerGroup} eligible participants.`
      : `Need ${playersPerGroup} eligible participants; have too few.`;
    return alert(detail);
  }
  const leftover = eligible.length - numGroups * playersPerGroup;
  const sizesMsg = leftover
    ? ` (${leftover} group(s) of ${playersPerGroup + 1}, ${numGroups - leftover} of ${playersPerGroup})`
    : '';
  const msg = `Create ${numGroups} group(s) of ${playersPerGroup}${sizesMsg}?`;
  if (!confirm(msg)) return;

  // Snake-seed across all eligible players. Spreads top seeds evenly and
  // distributes any leftover (eligible % playersPerGroup) one per group from
  // the top — e.g. 14 → 5/5/4 rather than 6/4/4 or leaving 2 unassigned.
  const ranked = [...eligible].sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
  const buckets = Array.from({ length: numGroups }, () => []);
  for (let i = 0; i < ranked.length; i++) {
    const lap = Math.floor(i / numGroups);
    const col = i % numGroups;
    const idx = lap % 2 === 0 ? col : numGroups - 1 - col;
    buckets[idx].push(ranked[i].id);
  }
  
  if (!confirm(lines.join('\n'))) return;

  for (const p of plans) {
    await post('/api/groups', { name: p.name, mode, category, classes: p.classes, members: p.memberIds });
  }
  await refresh();
  syncDefaultGroupName();
});

// -- Bulk delete --------------------------------------------------------------
// Persist selection across the re-renders triggered by other tabs/actions.
const bulkDeleteSelected = new Set();

function comboKeyOf(g) { return `${g.category || ''}::${classList(g).join('/')}`; }
function comboLabelOf(g) {
  return [g.category, classList(g).join('/')].filter(Boolean).join('-') || '(no category)';
}

function renderBulkDelete() {
  const root = $('#groups-bulk-list');
  if (!root) return;

  // Drop selections for groups that no longer exist.
  const live = new Set(state.groups.map(g => g.id));
  for (const id of [...bulkDeleteSelected]) if (!live.has(id)) bulkDeleteSelected.delete(id);

  if (state.groups.length === 0) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No groups to delete.'));
    return;
  }

  const combos = new Map();
  for (const g of state.groups) {
    const key = comboKeyOf(g);
    if (!combos.has(key)) combos.set(key, { label: comboLabelOf(g), ids: [] });
    combos.get(key).ids.push(g.id);
  }

  const allIds = state.groups.map(g => g.id);
  const allSelected = allIds.every(id => bulkDeleteSelected.has(id));

  const quickButtons = el('div', { class: 'row', style: 'gap:0.4rem; flex-wrap:wrap; margin:0.5rem 0' },
    el('span', { class: 'muted' }, 'Select:'),
    el('button', { type: 'button', class: 'ghost', on: { click: () => {
      if (allSelected) allIds.forEach(id => bulkDeleteSelected.delete(id));
      else allIds.forEach(id => bulkDeleteSelected.add(id));
      renderBulkDelete();
    } } }, allSelected ? 'Clear all' : 'All groups'),
    ...[...combos.values()].map(c => el('button', { type: 'button', class: 'ghost', on: { click: () => {
      const allInComboSelected = c.ids.every(id => bulkDeleteSelected.has(id));
      if (allInComboSelected) c.ids.forEach(id => bulkDeleteSelected.delete(id));
      else c.ids.forEach(id => bulkDeleteSelected.add(id));
      renderBulkDelete();
    } } }, c.label)),
  );

  const checklist = el('div', { class: 'bulk-delete-list' },
    ...state.groups.map(g => el('label', { class: 'row bulk-delete-row' },
      el('input', {
        type: 'checkbox',
        ...(bulkDeleteSelected.has(g.id) ? { checked: true } : {}),
        on: { change: (e) => {
          if (e.target.checked) bulkDeleteSelected.add(g.id);
          else bulkDeleteSelected.delete(g.id);
          const btn = $('#bulk-delete-action');
          if (btn) btn.textContent = `Delete selected (${bulkDeleteSelected.size})`;
        } },
      }),
      el('span', {}, g.name),
      el('span', { class: 'muted' }, ` · ${groupLabel(g)} · ${g.members.length} member${g.members.length === 1 ? '' : 's'}`),
    )),
  );

  const deleteBtn = el('button', {
    id: 'bulk-delete-action',
    type: 'button',
    class: 'danger',
    style: 'margin-top:0.5rem',
    on: { click: async () => {
      if (bulkDeleteSelected.size === 0) return alert('No groups selected.');
      const toDelete = state.groups.filter(g => bulkDeleteSelected.has(g.id));
      const msg = `Delete ${toDelete.length} group(s)?\n${toDelete.map(g => '  • ' + g.name).join('\n')}`;
      if (!confirm(msg)) return;
      for (const g of toDelete) {
        groupDetailsOpen.delete(g.id);
        try { await del(`/api/groups/${g.id}`); }
        catch (err) { alert(`Failed to delete ${g.name}: ${err.message}`); break; }
      }
      bulkDeleteSelected.clear();
      await refresh();
    } },
  }, `Delete selected (${bulkDeleteSelected.size})`);

  root.replaceChildren(quickButtons, checklist, deleteBtn);
}

// -- Groupstage ---------------------------------------------------------------
// Mirrors admin/src/standings.ts so the admin UI can show standings without
// an extra API call. Keep these in sync.
function setScore(m) {
  let p1Sets = 0, p2Sets = 0, p1Pts = 0, p2Pts = 0;
  for (const [a, b] of m.score) {
    if (a > b) p1Sets++; else if (b > a) p2Sets++;
    p1Pts += a; p2Pts += b;
  }
  return { p1Sets, p2Sets, p1Pts, p2Pts };
}

function doneMatches(g) {
  const out = [];
  for (const r of g.rounds) for (const m of r.matches) {
    if (m.status === 'done' && m.score.length && m.p2 !== '__bye__' && m.p1 !== '__bye__') out.push(m);
  }
  return out;
}

function headToHead(aId, bId, g) {
  let aWon = 0, bWon = 0;
  for (const m of doneMatches(g)) {
    const isAB = (m.p1 === aId && m.p2 === bId) || (m.p1 === bId && m.p2 === aId);
    if (!isAB) continue;
    const { p1Sets, p2Sets } = setScore(m);
    const aIsP1 = m.p1 === aId;
    if ((p1Sets > p2Sets && aIsP1) || (p2Sets > p1Sets && !aIsP1)) aWon++;
    else if (p1Sets !== p2Sets) bWon++;
  }
  return bWon - aWon;
}

function computeStandings(g) {
  const tally = new Map();
  for (const id of g.members) {
    const p = state.participants.find(p => p.id === id);
    if (!p) continue;
    tally.set(id, {
      participantId: id, name: p.name,
      played: 0, won: 0, lost: 0,
      setsWon: 0, setsLost: 0,
      pointsWon: 0, pointsLost: 0,
    });
  }
  for (const m of doneMatches(g)) {
    const a = tally.get(m.p1), b = tally.get(m.p2);
    if (!a || !b) continue;
    const { p1Sets, p2Sets, p1Pts, p2Pts } = setScore(m);
    a.played++; b.played++;
    a.setsWon += p1Sets; a.setsLost += p2Sets;
    b.setsWon += p2Sets; b.setsLost += p1Sets;
    a.pointsWon += p1Pts; a.pointsLost += p2Pts;
    b.pointsWon += p2Pts; b.pointsLost += p1Pts;
    if (p1Sets > p2Sets) { a.won++; b.lost++; }
    else if (p2Sets > p1Sets) { b.won++; a.lost++; }
  }
  const rows = [...tally.values()];
  rows.sort((x, y) => {
    if (y.won !== x.won) return y.won - x.won;
    const xSd = x.setsWon - x.setsLost, ySd = y.setsWon - y.setsLost;
    if (ySd !== xSd) return ySd - xSd;
    const xPd = x.pointsWon - x.pointsLost, yPd = y.pointsWon - y.pointsLost;
    if (yPd !== xPd) return yPd - xPd;
    return headToHead(x.participantId, y.participantId, g);
  });
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

// Switch to the Matches tab and scroll to this group's matches card.
function jumpToGroupMatches(g) {
  activateTab('matches');
  requestAnimationFrame(() => {
    const card = document.getElementById(`matches-group-${g.id}`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.remove('flash');
    void card.offsetWidth; // restart the animation
    card.classList.add('flash');
  });
}

function jumpToGroupMatch(g, m) {
  activateTab('matches');
  // Force the right section open (matches split into pending/done, and the
  // Done section is collapsed by default).
  const key = `${g.id}:${m.status === 'done' ? 'done' : 'pending'}`;
  matchesSectionsOpen.add(key);
  matchesSectionsClosed.delete(key);
  renderMatches();
  // Wait a tick for the DOM to settle, then scroll + flash.
  requestAnimationFrame(() => {
    const row = document.getElementById(`group-match-${m.id}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('flash');
    void row.offsetWidth; // restart the animation
    row.classList.add('flash');
  });
}

function renderStandingsTable(g) {
  const rows = computeStandings(g);
  if (rows.length === 0) return el('p', { class: 'muted' }, 'No members yet.');
  return el('table', {
    class: 'standings standings-clickable',
    title: 'Show matches for this group',
    on: { click: () => jumpToGroupMatches(g) },
  },
    el('thead', {}, el('tr', {},
      el('th', { class: 'num' }, '#'),
      el('th', {}, 'Player'),
      el('th', { class: 'num' }, 'P'),
      el('th', { class: 'num' }, 'W'),
      el('th', { class: 'num' }, 'L'),
      el('th', { class: 'num' }, 'Sets'),
      el('th', { class: 'num' }, 'Pts'),
    )),
    el('tbody', {}, ...rows.map(r => el('tr', r.rank === 1 && r.played > 0 ? { class: 'top-pts' } : {},
      el('td', { class: 'num' }, String(r.rank)),
      el('td', {}, r.name),
      el('td', { class: 'num' }, String(r.played)),
      el('td', { class: 'num' }, String(r.won)),
      el('td', { class: 'num' }, String(r.lost)),
      el('td', { class: 'num' }, `${r.setsWon}-${r.setsLost}`),
      el('td', { class: 'num' }, `${r.pointsWon}-${r.pointsLost}`),
    ))),
  );
}

const editingGroupstageMatches = new Set();

function renderGroupstageMatchRow(g, m) {
  const isBye = m.p1 === '__bye__' || m.p2 === '__bye__';
  const isEditing = editingGroupstageMatches.has(m.id);
  const seedCell = el('div', { class: 'bm-seed' }, m.court ? String(m.court) : '');

  if (isBye) {
    return el('div', { class: 'bracket-match match-bye' },
      seedCell,
      el('div', { class: 'bm-rows', style: `grid-template-columns: ${GRID.readOnly}` },
        el('div', { class: 'bm-row' }, el('div', { class: 'bm-name' }, nameOf(m.p1))),
        el('div', { class: 'bm-row' }, el('div', { class: 'bm-name' }, nameOf(m.p2))),
      ),
    );
  }

  if (m.walkover) {
    const rows = buildWalkoverRows(nameOf(m.p1), nameOf(m.p2), m.walkover, 1);
    return el('div', {
      class: 'bracket-match walkover clickable ' + m.status,
      title: 'Open in Matches tab',
      on: { click: () => jumpToGroupMatch(g, m) },
    },
      seedCell,
      el('div', { class: 'bm-rows', style: `grid-template-columns: ${GRID.walkoverGrp}` }, ...rows),
      el('span', { class: 'status ' + m.status, style: 'padding:0.3rem 0.6rem' }, m.status),
    );
  }

  if (isEditing) {
    const { p1Cells, p2Cells } = buildScoreInputs(m.score);
    const rows = el('div', { class: 'bm-rows', style: `grid-template-columns: ${GRID.readOnly} auto` },
      el('div', { class: 'bm-row' },
        el('div', { class: 'bm-name' }, nameOf(m.p1)),
        ...p1Cells,
        el('div', { class: 'bm-action' }, el('button', { on: { click: save } }, 'Save')),
      ),
      el('div', { class: 'bm-row' },
        el('div', { class: 'bm-name' }, nameOf(m.p2)),
        ...p2Cells,
        el('div', { class: 'bm-action' }, el('button', { class: 'ghost', on: { click: cancel } }, 'Cancel')),
      ),
    );
    attachScoreValidation(rows);

    async function save() {
      const score = readScoreFromContainer(rows);
      await patch(`/api/groups/${g.id}/matches/${m.id}`, { score });
      editingGroupstageMatches.delete(m.id);
      await refresh();
    }
    function cancel() {
      editingGroupstageMatches.delete(m.id);
      renderGroupstage();
    }
    return el('div', { class: 'bracket-match ' + m.status }, seedCell, rows);
  }

  const { p1Cells, p2Cells } = buildReadOnlySetCells(m.score);
  const winnerSide = (() => {
    let p1Sets = 0, p2Sets = 0;
    for (const [a, b] of m.score) {
      if (a > b) p1Sets++;
      else if (b > a) p2Sets++;
    }
    if (m.status !== 'done') return null;
    if (p1Sets > p2Sets) return 'p1';
    if (p2Sets > p1Sets) return 'p2';
    return null;
  })();
  const p1Win = winnerSide === 'p1', p2Win = winnerSide === 'p2';
  const canEdit = m.status === 'done';
  const editCell = canEdit
    ? el('div', { class: 'bm-action' }, el('button', { class: 'ghost', on: { click: () => {
        editingGroupstageMatches.add(m.id);
        renderGroupstage();
      } } }, 'Edit'))
    : el('div', { class: 'bm-action' });

  return el('div', {
    class: 'bracket-match clickable ' + m.status,
    title: 'Open in Matches tab',
    on: { click: (e) => { if (e.target.closest('button, input, select')) return; jumpToGroupMatch(g, m); } },
  },
    seedCell,
    el('div', { class: 'bm-rows', style: `grid-template-columns: ${GRID.readOnly} auto` },
      el('div', { class: 'bm-row' + (p1Win ? ' winner' : '') },
        el('div', { class: 'bm-name' + (p1Win ? ' winner' : '') }, nameOf(m.p1)),
        ...p1Cells,
        editCell,
      ),
      el('div', { class: 'bm-row' + (p2Win ? ' winner' : '') },
        el('div', { class: 'bm-name' + (p2Win ? ' winner' : '') }, nameOf(m.p2)),
        ...p2Cells,
        el('div', { class: 'bm-action bm-status' },
          el('span', { class: 'status ' + m.status }, m.status),
        ),
      ),
    ),
  );
}

function renderGroupstageMatches(g) {
  if (g.rounds.length === 0) return el('p', { class: 'muted' }, 'No rounds yet.');
  return el('div', {}, ...g.rounds.map(r => el('div', {},
    el('h4', {}, `Round ${r.roundNo}`),
    ...r.matches.map(m => renderGroupstageMatchRow(g, m)),
  )));
}

function renderAddMatchForm(g, container) {
  if (g.members.length < 2) {
    return el('p', { class: 'muted' }, 'Add at least two members to create matches.');
  }
  const opts = () => g.members.map(id => el('option', { value: id }, nameOf(id)));
  const p1Sel = el('select', {}, ...opts());
  const p2Sel = el('select', {}, ...opts());
  const nextRound = (g.rounds.at(-1)?.roundNo ?? 0) + 1;
  const roundIn = el('input', { type: 'number', min: 1, value: nextRound, style: 'width:5rem' });
  const courtIn = el('input', { placeholder: 'Court', style: 'width:5rem' });
  const addBtn = el('button', { style: 'width:100%', on: { click: async () => {
    if (p1Sel.value === p2Sel.value) return alert('Pick two different players.');
    try {
      await post(`/api/groups/${g.id}/matches`, {
        p1: p1Sel.value, p2: p2Sel.value,
        roundNo: Number(roundIn.value),
        court: courtIn.value,
      });
      await refresh();
    } catch (err) { alert(err.message); }
  } } }, 'Add');
  return el('div', { style: 'margin-top:0.5rem' },
    el('div', { class: 'row', style: 'gap:0.5rem; flex-wrap:wrap' },
      el('em', {}, 'Add match: '),
      p1Sel, el('span', {}, ' vs '), p2Sel,
      el('span', {}, ' round '), roundIn,
      courtIn,
    ),
    el('div', { class: 'row', style: 'margin-top:0.5rem' }, addBtn),
  );
}

function renderGroupstage() {
  const root = $('#groupstage-list');
  if (state.groups.length === 0) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No groups yet. Create one above.'));
    return;
  }
  root.replaceChildren(...state.groups.map(g => {
    const canGenerate = g.mode === 'round_robin' || g.mode === 'swiss';
    return el('div', { class: 'card', id: `group-${g.id}` },
      el('button', { class: 'danger group-delete-btn', on: { click: async () => {
        if (!confirm(`Delete group ${g.name}?`)) return;
        groupDetailsOpen.delete(g.id);
        await del(`/api/groups/${g.id}`); await refresh();
      } } }, 'Delete group'),
      el('h3', {}, `${g.name} `, el('span', { class: 'muted' }, `(${groupLabel(g)})`)),
      renderMembersPanel(g),
      renderStandingsTable(g),
      el('h4', {}, 'Pairings'),
      renderGroupstageMatches(g),
      el('div', { class: 'row', style: 'gap:0.5rem; margin-top:0.75rem; flex-wrap:wrap' },
        canGenerate
          ? el('button', { on: { click: async () => {
              try { await post(`/api/groups/${g.id}/next-round`); await refresh(); }
              catch (err) { alert(err.message); }
            } } }, 'Generate next round')
          : null,
        el('span', { class: 'muted' }, `${g.rounds.length} round(s) so far`),
      ),
      renderAddMatchForm(g),
    );
  }));
}

// -- Set score validation ----------------------------------------------------
// Badminton: a set is won at 21 with a 2-point lead, capped at 30 (so 30–28
// or 30–29 are the only valid extra-play endings). Pure UI feedback — the
// server accepts any non-negative integers.
function setPairBadness(a, b) {
  const aBad = a != null && (a < 0 || a > 30);
  const bBad = b != null && (b < 0 || b > 30);
  let pairBad = false;
  if (a != null && b != null && !aBad && !bBad) {
    const max = Math.max(a, b), min = Math.min(a, b);
    if (max >= 21) {
      if (max === 21) pairBad = min > 19;
      else if (max < 30) pairBad = min !== max - 2;
      else pairBad = min !== 28 && min !== 29;
    }
  }
  return { aBad, bBad, pairBad };
}

const INVALID_MSG = 'Invalid badminton set: win by 2 at 21, max 30.';

function validateScoreInputs(container) {
  const groups = {};
  container.querySelectorAll('input.score').forEach(inp => {
    const idx = inp.dataset.idx;
    (groups[idx] ??= {})[inp.dataset.side] = inp;
  });
  for (const { a, b } of Object.values(groups)) {
    if (!a || !b) continue;
    const av = a.value === '' ? null : Number(a.value);
    const bv = b.value === '' ? null : Number(b.value);
    const { aBad, bBad, pairBad } = setPairBadness(av, bv);
    const aMark = aBad || pairBad, bMark = bBad || pairBad;
    a.classList.toggle('invalid', aMark);
    b.classList.toggle('invalid', bMark);
    if (aMark) a.title = INVALID_MSG; else a.removeAttribute('title');
    if (bMark) b.title = INVALID_MSG; else b.removeAttribute('title');
  }
}

function attachScoreValidation(container) {
  container.querySelectorAll('input.score').forEach(inp => {
    inp.addEventListener('input', () => validateScoreInputs(container));
  });
  validateScoreInputs(container);
}

// -- Matches ------------------------------------------------------------------
// Preserve which "Pending"/"Done" sections are open across re-renders.
// Keys: groups → `${groupId}:${kind}`, brackets → `b-${bracketId}:${kind}`.
// Default: pending open, done closed.
const matchesSectionsClosed = new Set();
const matchesSectionsOpen = new Set();

function isSectionOpen(key) {
  if (matchesSectionsOpen.has(key)) return true;
  if (matchesSectionsClosed.has(key)) return false;
  return key.endsWith(':pending');
}

// Bracket slot is a "real" match (i.e. plays out, can be scored from the
// Matches tab) iff both p1 and p2 are non-null. BYE slots get one player
// auto-marked done at creation and never reach here.
function bracketSlotMatches(kb) {
  const out = [];
  for (const r of kb.rounds) {
    for (const slot of r.slots) {
      if (slot.p1 && slot.p2) out.push({ roundNo: r.roundNo, slot });
    }
  }
  return out;
}

function bracketProgress(kb) {
  let done = 0, total = 0;
  for (const { slot } of bracketSlotMatches(kb)) {
    total++;
    if (slot.status === 'done') done++;
  }
  return { done, total };
}

function renderMatches() {
  renderMatchesOverview();
  renderLiveOverview();
  const root = $('#matches-list');
  const groupCards = state.groups.map(g => {
    const pendingRounds = [];
    const doneRounds = [];
    let pendingCount = 0, doneCount = 0;
    for (const r of g.rounds) {
      const pending = r.matches.filter(m => m.status !== 'done');
      const done = r.matches.filter(m => m.status === 'done');
      if (pending.length) {
        pendingRounds.push({ roundNo: r.roundNo, matches: pending });
        pendingCount += pending.length;
      }
      if (done.length) {
        doneRounds.push({ roundNo: r.roundNo, matches: done });
        doneCount += done.length;
      }
    }
    return el('div', { class: 'card', id: `matches-group-${g.id}` },
      el('h3', {}, g.name),
      renderMatchesSection(g, 'pending', pendingCount, pendingRounds),
      renderMatchesSection(g, 'done', doneCount, doneRounds),
    );
  });

  const bracketCards = state.knockouts.map(kb => {
    const items = bracketSlotMatches(kb);
    const pendingByRound = new Map(), doneByRound = new Map();
    let pendingCount = 0, doneCount = 0;
    for (const { roundNo, slot } of items) {
      const isDone = slot.status === 'done';
      const bucket = isDone ? doneByRound : pendingByRound;
      if (!bucket.has(roundNo)) bucket.set(roundNo, []);
      bucket.get(roundNo).push(slot);
      if (isDone) doneCount++; else pendingCount++;
    }
    const sorted = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([roundNo, slots]) => ({ roundNo, slots }));
    const label = bracketLabel(kb);
    return el('div', { class: 'card', id: `matches-bracket-${kb.id}` },
      el('h3', {}, kb.name, label ? el('span', { class: 'muted' }, ` (${label})`) : null,
        el('span', { class: 'muted' }, ' · KO')),
      renderKnockoutMatchesSection(kb, 'pending', pendingCount, sorted(pendingByRound)),
      renderKnockoutMatchesSection(kb, 'done', doneCount, sorted(doneByRound)),
    );
  });

  root.replaceChildren(...groupCards, ...bracketCards);
}

function renderMatchesOverview() {
  const root = $('#matches-overview');
  if (state.groups.length === 0 && state.knockouts.length === 0) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No groups or brackets yet.'));
    return;
  }
  const jumpTo = (id) => (e) => {
    e.preventDefault();
    const card = document.getElementById(id);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const items = [
    ...state.groups.map(g => ({ kind: 'group', g, category: g.category || '', classes: classList(g).join('/') })),
    ...state.knockouts.map(kb => ({ kind: 'ko', kb, category: kb.category || '', classes: (kb.classes || []).join('/') })),
  ];
  renderOverviewTree({
    rootEl: root,
    items,
    getCat: it => it.category,
    getCls: it => it.classes,
    prefix: 'm',
    renderItem: (it) => {
      if (it.kind === 'group') {
        const g = it.g;
        const { done, total } = matchProgress(g);
        const anchor = `matches-group-${g.id}`;
        return el('li', {},
          el('a', { href: `#${anchor}`, on: { click: jumpTo(anchor) } }, g.name),
          el('span', { class: 'muted' }, ` · ${g.mode}`),
          total > 0
            ? el('span', { class: 'muted' }, ` · ${done}/${total} matches`)
            : el('span', { class: 'muted' }, ' · no matches yet'),
        );
      }
      const kb = it.kb;
      const { done, total } = bracketProgress(kb);
      const anchor = `matches-bracket-${kb.id}`;
      return el('li', {},
        el('a', { href: `#${anchor}`, on: { click: jumpTo(anchor) } }, kb.name),
        el('span', { class: 'muted' }, ' · KO'),
        total > 0
          ? el('span', { class: 'muted' }, ` · ${done}/${total} matches`)
          : el('span', { class: 'muted' }, ' · waiting on group results'),
      );
    },
  });
}

// "1" < "2" < "10"; non-numeric courts sort lexicographically after numeric;
// empty/missing court sorts last.
function courtSortKey(court) {
  const s = (court ?? '').trim();
  if (!s) return [2, '', 0];
  const n = Number(s);
  if (Number.isFinite(n)) return [0, '', n];
  return [1, s.toLowerCase(), 0];
}

function compareCourts(a, b) {
  const [ka, sa, na] = courtSortKey(a);
  const [kb, sb, nb] = courtSortKey(b);
  if (ka !== kb) return ka - kb;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return na - nb;
}

function renderLiveOverview() {
  const root = $('#matches-live');
  const live = [];
  for (const g of state.groups) {
    for (const r of g.rounds) {
      for (const m of r.matches) {
        if (m.status === 'live') live.push({ kind: 'group', g, roundNo: r.roundNo, m });
      }
    }
  }
  for (const kb of state.knockouts) {
    for (const r of kb.rounds) {
      for (const slot of r.slots) {
        if (slot.status === 'live' && slot.p1 && slot.p2) {
          live.push({ kind: 'ko', kb, round: r, roundNo: r.roundNo, m: slot });
        }
      }
    }
  }
  if (live.length === 0) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No live matches.'));
    return;
  }
  live.sort((a, b) => compareCourts(a.m.court, b.m.court));
  const jumpTo = (id) => (e) => {
    e.preventDefault();
    const card = document.getElementById(id);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  root.replaceChildren(el('ul', { class: 'overview-list' },
    ...live.map(item => {
      const anchor = item.kind === 'group' ? `matches-group-${item.g.id}` : `matches-bracket-${item.kb.id}`;
      const label = item.kind === 'group'
        ? `${item.g.name} · R${item.roundNo}`
        : `${item.kb.name} · ${bracketRoundLabel(item.round)}`;
      return el('li', {},
        el('span', { class: 'live-court' }, item.m.court ? `Court ${item.m.court}` : 'No court'),
        el('span', {}, ` · ${nameOf(item.m.p1)} vs ${nameOf(item.m.p2)} `),
        el('a', { class: 'muted', href: `#${anchor}`, on: { click: jumpTo(anchor) } }, label),
      );
    }),
  ));
}

function renderMatchesSection(g, kind, count, rounds) {
  const key = `${g.id}:${kind}`;
  const open = isSectionOpen(key);
  const label = kind === 'pending' ? 'Pending' : 'Done';
  return el('details', {
    class: 'matches-section',
    ...(open ? { open: true } : {}),
    on: { toggle: (e) => {
      if (e.target.open) { matchesSectionsOpen.add(key); matchesSectionsClosed.delete(key); }
      else { matchesSectionsClosed.add(key); matchesSectionsOpen.delete(key); }
    } },
  },
    el('summary', {}, `${label} (${count})`),
    rounds.length === 0
      ? el('p', { class: 'muted' }, `No ${label.toLowerCase()} matches.`)
      : el('div', {}, ...rounds.map(r => el('div', {},
          el('h4', {}, `Round ${r.roundNo}`),
          ...r.matches.map(m => renderMatchRow(g, m)),
        ))),
  );
}

function renderKnockoutMatchesSection(kb, kind, count, byRound) {
  const key = `b-${kb.id}:${kind}`;
  const open = isSectionOpen(key);
  const label = kind === 'pending' ? 'Pending' : 'Done';
  return el('details', {
    class: 'matches-section',
    ...(open ? { open: true } : {}),
    on: { toggle: (e) => {
      if (e.target.open) { matchesSectionsOpen.add(key); matchesSectionsClosed.delete(key); }
      else { matchesSectionsClosed.add(key); matchesSectionsOpen.delete(key); }
    } },
  },
    el('summary', {}, `${label} (${count})`),
    byRound.length === 0
      ? el('p', { class: 'muted' }, `No ${label.toLowerCase()} matches.`)
      : el('div', {}, ...byRound.map(r => el('div', {},
          el('h4', {}, bracketRoundLabel(kb.rounds.find(rr => rr.roundNo === r.roundNo) ?? r)),
          ...r.slots.map(slot => renderKnockoutMatchRow(kb, r.roundNo, slot)),
        ))),
  );
}

function renderKnockoutMatchRow(kb, roundNo, slot) {
  async function setWalkover(side) {
    await patch(`/api/knockouts/${kb.id}/round/${roundNo}/slot/${slot.slot}`, { walkover: side });
    await refresh();
  }
  async function clearWalkover() {
    await patch(`/api/knockouts/${kb.id}/round/${roundNo}/slot/${slot.slot}`, { walkover: null, status: 'pending' });
    await refresh();
  }

  const id = `ko-match-${kb.id}-${roundNo}-${slot.slot}`;
  const courtInput = el('input', { class: 'court-input', value: slot.court ?? '', placeholder: 'Court' });

  if (slot.walkover) {
    const woRows = buildWalkoverRows(nameOf(slot.p1), nameOf(slot.p2), slot.walkover, 1);
    const winnerName = slot.walkover === 'p1' ? nameOf(slot.p1) : nameOf(slot.p2);
    return el('div', { class: 'bracket-match walkover', id },
      el('div', { class: 'bm-seed bm-court' }, courtInput,
        el('button', { class: 'ghost bm-remove', title: 'Clear walkover', on: { click: clearWalkover } }, '↺'),
      ),
      el('div', { class: 'bm-rows', style: `grid-template-columns: ${GRID.walkoverGrp}` }, ...woRows),
      el('span', { class: 'walkover-note', style: 'padding:0.3rem 0.6rem' }, `walkover — ${winnerName} wins`),
    );
  }

  const { p1Cells, p2Cells } = buildScoreInputs(slot.score);
  const p1Win = slot.winner && slot.winner === slot.p1;
  const p2Win = slot.winner && slot.winner === slot.p2;

  let rows = null;
  async function advance() {
    // KO toggle only swaps pending ↔ live; the "done" state comes from the
    // Win-for buttons in column 2 (a KO must have a winner before completing).
    const next = slot.status === 'pending' ? 'live' : 'pending';
    await patch(`/api/knockouts/${kb.id}/round/${roundNo}/slot/${slot.slot}`, {
      score: readScoreFromContainer(rows), status: next, court: courtInput.value,
    });
    await refresh();
  }
  async function winFor(playerId) {
    if (!playerId) return;
    await patch(`/api/knockouts/${kb.id}/round/${roundNo}/slot/${slot.slot}`, {
      score: readScoreFromContainer(rows), winner: playerId, court: courtInput.value,
    });
    await refresh();
  }

  const toggle = statusToggleCells(slot.status, false, advance);
  const winForCell = (pid) => el('div', { class: 'bm-action bm-winfor' },
    el('button', {
      title: pid ? `Win for ${nameOf(pid)}` : '',
      ...(pid ? {} : { disabled: true }),
      on: { click: () => winFor(pid) },
    }, '✓'),
  );
  const woCell = (side, pid) => el('div', { class: 'bm-action bm-wo' },
    el('button', {
      class: 'ghost',
      title: pid ? `Walkover — ${nameOf(pid)} wins` : '',
      ...(pid ? {} : { disabled: true }),
      on: { click: () => setWalkover(side) },
    }, 'WO'),
  );

  rows = el('div', { class: 'bm-rows', style: `grid-template-columns: ${GRID.koActions}` },
    el('div', { class: 'bm-row' + (p1Win ? ' winner' : '') },
      el('div', { class: 'bm-name' + (p1Win ? ' winner' : '') }, nameOf(slot.p1)),
      ...p1Cells,
      toggle.top,
      winForCell(slot.p1),
      woCell('p1', slot.p1),
    ),
    el('div', { class: 'bm-row' + (p2Win ? ' winner' : '') },
      el('div', { class: 'bm-name' + (p2Win ? ' winner' : '') }, nameOf(slot.p2)),
      ...p2Cells,
      toggle.bottom,
      winForCell(slot.p2),
      woCell('p2', slot.p2),
    ),
  );
  attachScoreValidation(rows);

  return el('div', { class: 'bracket-match ' + slot.status, id },
    el('div', { class: 'bm-seed bm-court' }, courtInput),
    rows,
  );
}

function renderMatchRow(g, m) {
  const rowId = `group-match-${m.id}`;
  if (m.p2 === '__bye__') {
    return el('div', { class: 'bracket-match match-bye', id: rowId },
      el('div', { class: 'bm-seed' }, ''),
      el('div', { class: 'bm-rows', style: `grid-template-columns: ${GRID.readOnly}` },
        el('div', { class: 'bm-row' }, el('div', { class: 'bm-name' }, nameOf(m.p1))),
        el('div', { class: 'bm-row' }, el('div', { class: 'bm-name' }, '— BYE')),
      ),
    );
  }

  async function setWalkover(side) {
    await patch(`/api/groups/${g.id}/matches/${m.id}`, { walkover: side });
    await refresh();
  }
  async function clearWalkover() {
    await patch(`/api/groups/${g.id}/matches/${m.id}`, { walkover: null, status: 'pending' });
    await refresh();
  }

  const courtInput = el('input', { class: 'court-input', value: m.court ?? '', placeholder: 'Court' });

  if (m.walkover) {
    const winnerName = m.walkover === 'p1' ? nameOf(m.p1) : nameOf(m.p2);
    const woRows = buildWalkoverRows(nameOf(m.p1), nameOf(m.p2), m.walkover, 1);
    return el('div', { class: 'bracket-match walkover', id: rowId },
      el('div', { class: 'bm-seed bm-court' }, courtInput,
        el('button', { class: 'ghost bm-remove', title: 'Clear walkover', on: { click: clearWalkover } }, '↺'),
      ),
      el('div', { class: 'bm-rows', style: `grid-template-columns: ${GRID.walkoverGrp}` },
        ...woRows,
      ),
      el('span', { class: 'walkover-note', style: 'padding:0.3rem 0.6rem' }, `walkover — ${winnerName} wins`),
    );
  }

  const { p1Cells, p2Cells } = buildScoreInputs(m.score);

  // Closure refs so the action handlers can read the latest score input
  // values when the operator clicks (rows is assigned below).
  let rows = null;

  async function save(status) {
    const score = readScoreFromContainer(rows);
    await patch(`/api/groups/${g.id}/matches/${m.id}`, { score, status, court: courtInput.value });
    await refresh();
  }
  async function advance() {
    const next = { pending: 'live', live: 'done', done: 'pending' }[m.status] ?? 'live';
    await save(next);
  }
  async function remove() {
    if (!confirm(`Remove ${nameOf(m.p1)} vs ${nameOf(m.p2)}?`)) return;
    await del(`/api/groups/${g.id}/matches/${m.id}`);
    await refresh();
  }

  const toggle = statusToggleCells(m.status, true, advance);
  const p1WO = el('div', { class: 'bm-action bm-wo' },
    el('button', { class: 'ghost', title: `Walkover — ${nameOf(m.p1)} wins`, on: { click: () => setWalkover('p1') } }, 'WO'),
  );
  const p2WO = el('div', { class: 'bm-action bm-wo' },
    el('button', { class: 'ghost', title: `Walkover — ${nameOf(m.p2)} wins`, on: { click: () => setWalkover('p2') } }, 'WO'),
  );

  rows = el('div', { class: 'bm-rows', style: `grid-template-columns: ${GRID.groupActions}` },
    el('div', { class: 'bm-row' },
      el('div', { class: 'bm-name' }, nameOf(m.p1)),
      ...p1Cells,
      toggle.top,
      p1WO,
    ),
    el('div', { class: 'bm-row' },
      el('div', { class: 'bm-name' }, nameOf(m.p2)),
      ...p2Cells,
      toggle.bottom,
      p2WO,
    ),
  );
  attachScoreValidation(rows);

  return el('div', { class: 'bracket-match ' + m.status, id: rowId },
    el('div', { class: 'bm-seed bm-court' },
      courtInput,
      el('button', { class: 'ghost bm-remove', title: 'Remove match', on: { click: remove } }, '✕'),
    ),
    rows,
  );
}

// -- Bracket ------------------------------------------------------------------
// The wizard's transient state lives in module scope so renderBracketWizard()
// can re-render without losing form input. `null` = wizard closed.
let bracketWizard = null;
// Per-candidate-row checkbox selection survives re-renders.
const wizardSelected = new Set();

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return Math.max(2, p);
}

function bracketLabel(kb) {
  const parts = [];
  if (kb.category) parts.push(kb.category);
  if (kb.classes && kb.classes.length) parts.push(kb.classes.join('/'));
  return parts.join(' · ');
}

// Display label for a bracket round. Falls back to "Round N" if the round
// has no custom name (e.g. legacy data persisted before this field existed).
function bracketRoundLabel(round) {
  const name = round && typeof round.name === 'string' ? round.name.trim() : '';
  return name || `Round ${round?.roundNo ?? ''}`.trim();
}

$('#open-bracket-wizard').addEventListener('click', () => {
  if (bracketWizard) { closeBracketWizard(); return; }
  bracketWizard = {
    name: defaultBracketName('', []),
    nameDirty: false,     // until the operator types in the name field, follow category/classes
    category: '',
    classes: [],
    size: 8,
    seeds: [],            // ordered list of participant IDs
    sort: { key: 'rank', dir: 'asc' },
    filter: '',
  };
  wizardSelected.clear();
  renderBracketWizard();
});

function defaultBracketName(category, classes) {
  const tag = [category, classes.join('/')].filter(Boolean).join('-');
  return tag ? `${tag} KO` : 'KO';
}

function syncBracketName() {
  if (bracketWizard && !bracketWizard.nameDirty) {
    bracketWizard.name = defaultBracketName(bracketWizard.category, bracketWizard.classes);
  }
}

function closeBracketWizard() {
  bracketWizard = null;
  wizardSelected.clear();
  renderBracketWizard();
}

function eligibleSourceGroups() {
  if (!bracketWizard) return [];
  const { category, classes } = bracketWizard;
  return state.groups.filter(g => {
    if (category && g.category !== category) return false;
    if (classes.length === 0) return true;
    // group is eligible if any of its classes overlap, or it has no class
    // restriction at all
    if (g.classes.length === 0) return true;
    return g.classes.some(c => classes.includes(c));
  });
}

function bracketMemberships() {
  // map participantId -> array of bracket names they're already in.
  const map = new Map();
  for (const kb of state.knockouts) {
    for (const r of kb.rounds) {
      for (const slot of r.slots) {
        for (const pid of [slot.p1, slot.p2]) {
          if (!pid) continue;
          if (!map.has(pid)) map.set(pid, new Set());
          map.get(pid).add(kb.name);
        }
      }
    }
  }
  return map;
}

function candidateRows() {
  // build per-player rows joining standings rank with group context.
  // Withdrawn participants are omitted — they can't be seeded into a bracket.
  const rows = [];
  const groups = eligibleSourceGroups();
  for (const g of groups) {
    const standings = computeStandings(g);
    for (const r of standings) {
      const p = state.participants.find(x => x.id === r.participantId);
      if (p?.withdrawn) continue;
      rows.push({
        participantId: r.participantId,
        name: r.name,
        groupId: g.id,
        groupName: g.name,
        rank: r.rank,
        played: r.played,
        won: r.won,
        setDiff: r.setsWon - r.setsLost,
        ptDiff: r.pointsWon - r.pointsLost,
      });
    }
  }
  return rows;
}

function sortCandidates(rows) {
  const { key, dir } = bracketWizard.sort;
  const mul = dir === 'asc' ? 1 : -1;
  const cmp = {
    rank: (a, b) => (a.rank - b.rank) * mul,
    name: (a, b) => a.name.localeCompare(b.name) * mul,
    group: (a, b) => a.groupName.localeCompare(b.groupName) * mul,
    won: (a, b) => (a.won - b.won) * mul,
    setDiff: (a, b) => (a.setDiff - b.setDiff) * mul,
    ptDiff: (a, b) => (a.ptDiff - b.ptDiff) * mul,
  }[key] ?? ((a, b) => 0);
  return [...rows].sort(cmp);
}

function renderBracketWizard() {
  const root = $('#bracket-wizard');
  root.replaceChildren();
  if (!bracketWizard) return;

  const w = bracketWizard;
  const seedSet = new Set(w.seeds);
  const memberships = bracketMemberships();

  const nameInput = el('input', { placeholder: 'Bracket name (e.g. MS-A KO)', value: w.name, style: 'min-width:18rem' });
  nameInput.addEventListener('input', () => {
    w.name = nameInput.value;
    w.nameDirty = true;
  });

  function makeCategorySelect() {
    return el('select', { on: { change: (e) => {
      w.category = e.target.value;
      syncBracketName();
      renderBracketWizard();
    } } },
      ...['', 'MS', 'WS', 'MD', 'WD', 'MX'].map(c =>
        el('option', { value: c, ...(c === w.category ? { selected: true } : {}) }, c || 'Any category'),
      ),
    );
  }

  function makeClassChecks() {
    return el('fieldset', { class: 'inline-checks' },
      el('legend', {}, 'Classes'),
      ...['S', 'A', 'B', 'C', 'D'].map(c => el('label', {},
        el('input', { type: 'checkbox', value: c, ...(w.classes.includes(c) ? { checked: true } : {}), on: { change: (e) => {
          if (e.target.checked) w.classes = [...w.classes, c];
          else w.classes = w.classes.filter(x => x !== c);
          syncBracketName();
          renderBracketWizard();
        } } }),
        ' ', c,
      )),
    );
  }

  const sizeInput = el('input', { type: 'number', min: 2, value: w.size, style: 'width:5rem' });
  sizeInput.addEventListener('change', () => {
    const v = Number(sizeInput.value);
    if (!Number.isFinite(v) || v < 2) { sizeInput.value = w.size; return; }
    w.size = v;
    // trim seeds that no longer fit
    if (w.seeds.length > v) w.seeds = w.seeds.slice(0, v);
    renderBracketWizard();
  });

  const filtersRow = el('div', { class: 'row', style: 'gap:0.75rem; flex-wrap:wrap; align-items:center; margin-bottom:0.5rem' },
    makeCategorySelect(),
    makeClassChecks(),
    el('label', {}, 'Players: ', sizeInput),
    el('span', { class: 'muted' }, `(${w.seeds.length}/${w.size} added, bracket size ${nextPow2(w.size)})`),
    el('button', { class: 'ghost', style: 'margin-left:auto', on: { click: closeBracketWizard } }, 'Cancel'),
  );
  const nameRow = el('div', { class: 'row', style: 'gap:0.5rem; align-items:center; margin-bottom:0.5rem' },
    el('label', {}, 'Name: ', nameInput),
  );

  const sources = eligibleSourceGroups();

  // Quick action: add all table leaders
  const addLeadersBtn = el('button', { type: 'button', on: { click: () => {
    const newSeeds = [...w.seeds];
    for (const g of sources) {
      const standings = computeStandings(g);
      const leader = standings.find(r => r.rank === 1 && r.played > 0);
      if (!leader) continue;
      if (newSeeds.includes(leader.participantId)) continue;
      if (newSeeds.length >= w.size) break;
      newSeeds.push(leader.participantId);
    }
    w.seeds = newSeeds;
    renderBracketWizard();
  } } }, 'Add all table leaders');

  // Candidate picker (hides already-seeded and withdrawn; shows other-bracket badges)
  const allRows = candidateRows();
  const visible = sortCandidates(allRows.filter(r => {
    if (seedSet.has(r.participantId)) return false;
    if (w.filter) {
      const needle = w.filter.toLowerCase();
      const p = state.participants.find(x => x.id === r.participantId);
      const hay = `${r.name} ${p?.club ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  }));

  // Drop selections that are no longer visible (e.g. after a filter narrows).
  for (const id of [...wizardSelected]) {
    if (!visible.some(r => r.participantId === id)) wizardSelected.delete(id);
  }

  const filterInput = el('input', { placeholder: 'Filter by name/club…', value: w.filter, style: 'min-width:14rem' });
  filterInput.addEventListener('input', () => {
    w.filter = filterInput.value;
    // re-render but keep focus & caret on filter input
    const start = filterInput.selectionStart;
    renderBracketWizard();
    const fresh = $('#bracket-wizard input[data-role="filter"]');
    if (fresh) { fresh.focus(); fresh.setSelectionRange(start, start); }
  });
  filterInput.setAttribute('data-role', 'filter');

  function sortHeader(label, key) {
    const arrow = w.sort.key === key ? (w.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return el('th', { class: 'num sortable', style: 'cursor:pointer; user-select:none',
      on: { click: () => {
        if (w.sort.key === key) w.sort.dir = w.sort.dir === 'asc' ? 'desc' : 'asc';
        else { w.sort.key = key; w.sort.dir = (key === 'rank' || key === 'name' || key === 'group') ? 'asc' : 'desc'; }
        renderBracketWizard();
      } } }, label + arrow);
  }

  const allSelectable = visible.length > 0 && visible.every(r => wizardSelected.has(r.participantId));
  const selectAllCb = el('input', { type: 'checkbox', ...(allSelectable ? { checked: true } : {}), on: { change: (e) => {
    if (e.target.checked) for (const r of visible) wizardSelected.add(r.participantId);
    else wizardSelected.clear();
    renderBracketWizard();
  } } });

  const table = el('table', { class: 'standings candidate-table' },
    el('thead', {}, el('tr', {},
      el('th', { style: 'width:1.5rem' }, selectAllCb),
      sortHeader('Player', 'name'),
      sortHeader('Group', 'group'),
      sortHeader('Rank', 'rank'),
      sortHeader('W', 'won'),
      sortHeader('Set diff', 'setDiff'),
      sortHeader('Pt diff', 'ptDiff'),
      el('th', {}, ''),
    )),
    el('tbody', {}, ...(visible.length === 0
      ? [el('tr', {}, el('td', { colspan: 8, class: 'muted' }, 'No candidate players.'))]
      : visible.map(r => {
          const p = state.participants.find(x => x.id === r.participantId);
          const inOther = memberships.get(r.participantId);
          return el('tr', { class: p?.withdrawn ? 'withdrawn-row' : '' },
            el('td', {}, el('input', { type: 'checkbox', ...(wizardSelected.has(r.participantId) ? { checked: true } : {}),
              on: { change: (e) => {
                if (e.target.checked) wizardSelected.add(r.participantId);
                else wizardSelected.delete(r.participantId);
                renderBracketWizard();
              } } })),
            el('td', {}, r.name,
              p?.withdrawn ? el('span', { class: 'badge warn', style: 'margin-left:0.4rem' }, 'withdrawn') : null,
              inOther ? el('span', { class: 'badge muted', style: 'margin-left:0.4rem' }, `in ${[...inOther].join(', ')}`) : null,
            ),
            el('td', { class: 'muted' }, r.groupName),
            el('td', { class: 'num' }, String(r.rank)),
            el('td', { class: 'num' }, String(r.won)),
            el('td', { class: 'num' }, String(r.setDiff)),
            el('td', { class: 'num' }, String(r.ptDiff)),
            el('td', {}, el('button', { class: 'ghost', on: { click: () => {
              if (w.seeds.length >= w.size) return alert(`Bracket is full (${w.size}).`);
              if (!w.seeds.includes(r.participantId)) w.seeds.push(r.participantId);
              renderBracketWizard();
            } } }, '+')),
          );
        })
      )),
  );

  const addSelectedBtn = el('button', { type: 'button', on: { click: () => {
    const room = w.size - w.seeds.length;
    if (room <= 0) return alert(`Bracket is full (${w.size}).`);
    const picked = [...wizardSelected].filter(id => !w.seeds.includes(id)).slice(0, room);
    w.seeds.push(...picked);
    wizardSelected.clear();
    renderBracketWizard();
  } } }, `Add selected (${wizardSelected.size})`);

  // Quick action: fill the bracket with the top X of the current sort/filter.
  // X = bracket player count. Disabled when the bracket is already full.
  const roomLeft = w.size - w.seeds.length;
  const addTopBtn = el('button', {
    type: 'button',
    ...(roomLeft <= 0 ? { disabled: true } : {}),
    on: { click: () => {
      if (roomLeft <= 0) return;
      const picked = visible.slice(0, roomLeft).map(r => r.participantId);
      w.seeds.push(...picked);
      renderBracketWizard();
    } },
  }, `Add top ${w.size}`);

  // Seed list (ordered)
  const seedList = el('ol', { class: 'seed-list' },
    ...(w.seeds.length === 0
      ? [el('li', { class: 'muted' }, '(no seeds yet)')]
      : w.seeds.map((id, idx) => el('li', { class: 'seed-row' },
          el('span', {}, nameOf(id)),
          el('span', { class: 'seed-actions' },
            el('button', { class: 'ghost', title: 'Move up', disabled: idx === 0,
              on: { click: () => { if (idx > 0) { [w.seeds[idx - 1], w.seeds[idx]] = [w.seeds[idx], w.seeds[idx - 1]]; renderBracketWizard(); } } } }, '↑'),
            el('button', { class: 'ghost', title: 'Move down', disabled: idx === w.seeds.length - 1,
              on: { click: () => { if (idx < w.seeds.length - 1) { [w.seeds[idx], w.seeds[idx + 1]] = [w.seeds[idx + 1], w.seeds[idx]]; renderBracketWizard(); } } } }, '↓'),
            el('button', { class: 'ghost', title: 'Remove',
              on: { click: () => { w.seeds.splice(idx, 1); renderBracketWizard(); } } }, '✕'),
          ),
        ))),
  );

  const createBtn = el('button', { on: { click: async () => {
    if (!w.name.trim()) return alert('Bracket name is required.');
    if (!w.category) return alert('Pick a category.');
    if (w.classes.length === 0) return alert('Pick at least one class.');
    if (w.seeds.length === 0) return alert('Add at least one seed.');
    try {
      await post('/api/knockouts', {
        name: w.name.trim(),
        category: w.category,
        classes: w.classes,
        size: w.size,
        seeds: w.seeds,
      });
      closeBracketWizard();
      await refresh();
    } catch (err) { alert(err.message); }
  } } }, 'Create bracket');

  root.append(el('div', { class: 'card bracket-wizard' },
    el('h3', {}, 'New bracket'),
    filtersRow,
    nameRow,
    el('div', { class: 'row', style: 'gap:0.5rem; margin:0.5rem 0; flex-wrap:wrap; align-items:center' },
      el('strong', {}, 'Candidates'),
      filterInput,
      addLeadersBtn,
      addTopBtn,
      addSelectedBtn,
    ),
    el('div', { class: 'candidate-wrap' }, table),
    el('div', { class: 'row', style: 'justify-content:space-between; align-items:center; margin-top:1rem' },
      el('h4', { style: 'margin:0' }, 'Seeds (in order = seed #)'),
      el('button', {
        class: 'ghost',
        ...(w.seeds.length === 0 ? { disabled: true } : {}),
        on: { click: () => {
          if (w.seeds.length === 0) return;
          w.seeds = [];
          renderBracketWizard();
        } },
      }, 'Clear all'),
    ),
    seedList,
    el('div', { class: 'row', style: 'gap:0.5rem; margin-top:0.75rem' },
      createBtn,
      el('button', { class: 'ghost', on: { click: closeBracketWizard } }, 'Cancel'),
    ),
  ));
}

function renderBracket() {
  renderBracketOverview();
  const root = $('#bracket-list');
  root.replaceChildren();
  if (state.knockouts.length === 0) {
    root.append(el('p', { class: 'muted' }, 'No brackets yet. Click "+ Create a bracket" above.'));
    return;
  }
  for (const kb of state.knockouts) root.append(renderBracketCard(kb));
}

function renderBracketOverview() {
  const root = $('#bracket-overview');
  if (state.knockouts.length === 0) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No brackets yet.'));
    return;
  }
  const jumpTo = (id) => (e) => {
    e.preventDefault();
    const card = document.getElementById(id);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  renderOverviewTree({
    rootEl: root,
    items: state.knockouts,
    getCat: kb => kb.category || '',
    getCls: kb => (kb.classes || []).join('/'),
    prefix: 'b',
    flatClasses: true,
    renderItem: (kb) => {
      const { done, total } = bracketProgress(kb);
      const anchor = `bracket-${kb.id}`;
      return el('li', {},
        el('a', { href: `#${anchor}`, on: { click: jumpTo(anchor) } }, kb.name),
        el('span', { class: 'muted' }, ` · size ${kb.size}`),
        total > 0
          ? el('span', { class: 'muted' }, ` · ${done}/${total} matches`)
          : el('span', { class: 'muted' }, ' · waiting on group results'),
      );
    },
  });
}

async function renameBracketRound(kb, round) {
  const current = bracketRoundLabel(round);
  const next = window.prompt(`Rename "${current}" to:`, current);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === current) return;
  try {
    await patch(`/api/knockouts/${kb.id}/round/${round.roundNo}`, { name: trimmed });
    await refresh();
  } catch (err) { alert(err.message); }
}

function renderBracketCard(kb) {
  const label = bracketLabel(kb);
  const cols = el('div', { class: 'bracket-cols' });
  for (const round of kb.rounds) {
    const col = el('div', { class: 'bracket-round' },
      el('h4', { class: 'bracket-round-head' },
        el('span', {}, bracketRoundLabel(round)),
        el('button', {
          class: 'ghost small bracket-round-rename',
          title: 'Rename round',
          on: { click: () => renameBracketRound(kb, round) },
        }, '✎'),
      ),
    );
    for (const slot of round.slots) {
      col.append(renderBracketSlot(kb, round.roundNo, slot));
    }
    cols.append(col);
  }
  return el('div', { class: 'card bracket-card', id: `bracket-${kb.id}` },
    el('div', { class: 'row', style: 'justify-content:space-between; align-items:center' },
      el('h3', {}, kb.name, label ? el('span', { class: 'muted' }, ` (${label})`) : null,
        el('span', { class: 'muted' }, ` · size ${kb.size}`)),
      el('button', { class: 'danger', on: { click: async () => {
        if (!confirm(`Delete bracket "${kb.name}"?`)) return;
        await del(`/api/knockouts/${kb.id}`); await refresh();
      } } }, 'Delete bracket'),
    ),
    cols,
  );
}

// Read-only display of a single slot, matching the public bracket grid.
// Click jumps to the Matches tab for scoring. Slots without both players
// aren't clickable (nothing to score yet).
function renderBracketSlot(kb, roundNo, slot) {
  const a = slot.p1 ? nameOf(slot.p1) : '—';
  const b = slot.p2 ? nameOf(slot.p2) : '—';
  const p1Win = !!slot.winner && slot.p1 && slot.winner === slot.p1;
  const p2Win = !!slot.winner && slot.p2 && slot.winner === slot.p2;
  const clickable = !!(slot.p1 && slot.p2);
  const isWalkover = !!slot.walkover;

  const seedFor = (pid) => {
    if (!pid || pid === '__bye__') return null;
    const p = state.participants.find(x => x.id === pid);
    return p && p.seed > 0 ? p.seed : null;
  };
  const seeds = [seedFor(slot.p1), seedFor(slot.p2)].filter(n => typeof n === 'number');
  const seedBadge = seeds.length ? String(Math.min(...seeds)) : '';

  let rows, cols;
  if (isWalkover) {
    rows = buildWalkoverRows(a, b, slot.winner === slot.p1 ? 'p1' : 'p2', 1);
    cols = GRID.walkoverRO;
  } else {
    const { p1Cells, p2Cells } = buildReadOnlySetCells(slot.score);
    rows = [
      el('div', { class: 'bm-row' + (p1Win ? ' winner' : '') },
        el('div', { class: 'bm-name' + (p1Win ? ' winner' : '') }, a),
        ...p1Cells,
      ),
      el('div', { class: 'bm-row' + (p2Win ? ' winner' : '') },
        el('div', { class: 'bm-name' + (p2Win ? ' winner' : '') }, b),
        ...p2Cells,
      ),
    ];
    cols = GRID.readOnly;
  }

  const classes = ['bracket-match', slot.status || 'pending', isWalkover ? 'walkover' : '', clickable ? 'clickable' : '']
    .filter(Boolean).join(' ');
  return el('div', {
    class: classes,
    ...(clickable ? { title: 'Open in Matches tab', on: { click: () => jumpToKoMatch(kb.id, roundNo, slot.slot, slot.status === 'done') } } : {}),
  },
    el('div', { class: 'bm-seed' }, seedBadge),
    el('div', { class: 'bm-rows', style: `grid-template-columns: ${cols}` }, ...rows),
  );
}

function activateTab(name) {
  try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch {}
  $$('nav#tabs a').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  $$('section[data-tab]').forEach(s => s.classList.toggle('active', s.dataset.tab === name));
}

function jumpToKoMatch(kbId, roundNo, slotNo, isDone) {
  activateTab('matches');
  // Force the right section open (done is collapsed by default).
  const key = `b-${kbId}:${isDone ? 'done' : 'pending'}`;
  matchesSectionsOpen.add(key);
  matchesSectionsClosed.delete(key);
  renderMatches();
  // Wait a tick for the DOM to settle, then scroll + flash.
  requestAnimationFrame(() => {
    const row = document.getElementById(`ko-match-${kbId}-${roundNo}-${slotNo}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('flash');
    void row.offsetWidth; // restart the animation
    row.classList.add('flash');
  });
}

// -- Settings -----------------------------------------------------------------
$('#rename').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = new FormData(e.target).get('name');
  await put('/api/state/name', { name });
  await refresh();
});

// -- Pending changes ---------------------------------------------------------
// Server provides `tab` and `summary` per entry, resolved against the
// pre-mutation snapshot (so e.g. a deleted player's name is still rendered).

const TAB_LABEL = {
  participants: 'Participants',
  groups:       'Groups',
  matches:      'Matches',
  bracket:      'Bracket',
  settings:     'Settings',
};

function formatTs(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}

async function renderPending() {
  const list = $('#pending-list');
  const toolbar = $('#pending-toolbar');
  if (!list || !toolbar) return;
  let data;
  try {
    data = await get('/api/pending');
  } catch (err) {
    list.replaceChildren(el('p', { class: 'form-error' }, 'Failed to load pending changes: ' + err.message));
    toolbar.replaceChildren();
    return;
  }
  const entries = data.entries || [];

  if (entries.length === 0) {
    toolbar.replaceChildren();
    list.replaceChildren(
      el('p', { class: 'muted' }, 'No pending changes since the last publish.'),
    );
    return;
  }

  toolbar.replaceChildren(
    el('div', { class: 'pending-summary' },
      el('span', {}, `${entries.length} unpublished change${entries.length === 1 ? '' : 's'}`),
      el('button', {
        class: 'danger',
        on: { click: () => revertPending({ mode: 'all' }, `Revert ALL ${entries.length} pending change(s)? Current state will be replaced by the last-published baseline.`) },
      }, 'Revert all'),
    ),
  );

  // Newest first.
  const rows = [...entries].reverse().map(e => {
    const discardCount = entries.length - e.index;  // this entry + everything after
    return el('div', { class: 'pending-row' },
      el('div', { class: 'pending-meta' },
        el('div', { class: 'pending-line' },
          el('span', { class: `pending-tab-pill tab-${e.tab}` }, TAB_LABEL[e.tab] ?? e.tab),
          el('span', { class: 'pending-action' }, e.summary),
        ),
        el('span', { class: 'pending-ts mono' }, formatTs(e.ts)),
      ),
      el('button', {
        class: 'ghost small',
        title: discardCount === 1
          ? 'Revert this change'
          : `Revert this change and the ${discardCount - 1} newer change(s)`,
        on: { click: () => revertPending({ index: e.index }, discardCount === 1
          ? `Revert "${e.summary}"?`
          : `Revert "${e.summary}" and discard the ${discardCount - 1} newer change(s)?`) },
      }, 'Revert from here'),
    );
  });
  list.replaceChildren(...rows);
}

async function revertPending(body, confirmMsg) {
  if (!confirm(confirmMsg)) return;
  try {
    await post('/api/pending/revert', body);
  } catch (err) {
    alert('Revert failed: ' + err.message);
    return;
  }
  await refresh();
  await renderPending();
  await refreshPublishStatus();
}

// Refresh the pending list when the user opens the Pending tab. The badge
// is kept current by the 2 s publish-status poll, which calls renderPending
// whenever the unpublished count changes.
$$('nav#tabs a[data-tab="pending"]').forEach(a => {
  a.addEventListener('click', () => { renderPending(); });
});

// -- Boot ---------------------------------------------------------------------
await refresh();
await renderPending();
await refreshPublishStatus();
