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

async function refresh() {
  state = await get('/api/state');
  $('#tournament-name').textContent = state.tournament.name;
  const renamerInput = $('#rename input[name="name"]');
  if (renamerInput && document.activeElement !== renamerInput) renamerInput.value = state.tournament.name;
  renderParticipants();
  renderGroups();
  renderPairings();
  renderScoring();
  renderBracket();
  const nameInput = $('#add-group')?.elements.name;
  if (nameInput && document.activeElement !== nameInput) syncDefaultGroupName();
}

// -- Tabs ---------------------------------------------------------------------
$$('nav#tabs a').forEach(a => {
  a.addEventListener('click', () => {
    const name = a.dataset.tab;
    $$('nav#tabs a').forEach(x => x.classList.toggle('active', x === a));
    $$('section[data-tab]').forEach(s => s.classList.toggle('active', s.dataset.tab === name));
  });
});

// -- Publish status -----------------------------------------------------------
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
    alert('Force publish failed: ' + err.message);
  }
});

$('#push-backup').addEventListener('click', async () => {
  try { await post('/api/publish/backup'); alert('Backup snapshot pushed.'); }
  catch (err) { alert('Backup failed: ' + err.message); }
});

// -- Participants -------------------------------------------------------------
function renderParticipants() {
  const tbody = $('#participants-table tbody');
  tbody.replaceChildren(...state.participants.map(p => el('tr', {},
    el('td', {}, p.name),
    el('td', {}, p.club),
    el('td', {}, p.category),
    el('td', {}, p.class),
    el('td', {}, String(p.seed || '')),
    el('td', {},
      el('button', { class: 'ghost', on: { click: async () => {
        if (!confirm(`Remove ${p.name}?`)) return;
        await del(`/api/participants/${p.id}`); await refresh();
      } } }, 'Remove')),
  )));
}

$('#add-participant').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await post('/api/participants', {
    name: fd.get('name'),
    club: fd.get('club') || '',
    category: fd.get('category') || '',
    class: fd.get('class') || '',
    seed: Number(fd.get('seed') || 0),
  });
  e.target.reset();
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

// Preserve which group cards have their "Add/remove members" panel open
// across re-renders (every checkbox tick triggers a full refresh()).
const groupDetailsOpen = new Set();

function renderGroups() {
  const root = $('#groups-list');
  // Members already assigned to any *other* group are not offered for this one.
  const claimedByOther = new Map(); // participantId -> other group name
  for (const grp of state.groups) {
    for (const m of grp.members) {
      if (!claimedByOther.has(m)) claimedByOther.set(m, grp.name);
    }
  }

  root.replaceChildren(...state.groups.map(g => {
    const memberIds = new Set(g.members);
    // Members of *this* group always show up (so ticking never makes a row
    // disappear). Plus any other participant who fits the filter and isn't
    // claimed by another group.
    const shown = state.participants.filter(p => {
      if (memberIds.has(p.id)) return true;
      if (!eligibleForGroup(g, p)) return false;
      const owner = claimedByOther.get(p.id);
      return !owner || owner === g.name;
    });
    const restricted = !!(g.category || classList(g).length);
    const tag = [g.category, classList(g).join('/')].filter(Boolean).join('-');

    return el('div', { class: 'card' },
      el('h3', {}, `${g.name} `, el('span', { class: 'muted' }, `(${groupLabel(g)})`)),
      el('div', { class: 'row' },
        el('strong', {}, 'Members:'),
        el('span', {}, g.members.map(nameOf).join(', ') || '(none)'),
      ),
      el('details', {
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
      ),
      el('div', { class: 'row' },
        el('button', { class: 'danger', on: { click: async () => {
          if (!confirm(`Delete group ${g.name}?`)) return;
          groupDetailsOpen.delete(g.id);
          await del(`/api/groups/${g.id}`); await refresh();
        } } }, 'Delete group'),
      ),
    );
  }));
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

$('#add-group').addEventListener('change', (e) => {
  if (e.target.name === 'category' || e.target.name === 'classes') {
    syncDefaultGroupName();
  }
});

$('#add-group').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const classes = [...fd.getAll('classes')].map(String);
  await post('/api/groups', {
    name: fd.get('name'),
    mode: fd.get('mode'),
    category: fd.get('category') || '',
    classes,
    members: [],
  });
  e.target.reset();
  await refresh();
  syncDefaultGroupName();
});

// -- Pairings -----------------------------------------------------------------
function renderPairings() {
  const root = $('#pairings-list');
  root.replaceChildren(...state.groups.map(g => el('div', { class: 'card' },
    el('h3', {}, `${g.name} `, el('span', { class: 'muted' }, `(${groupLabel(g)})`)),
    el('p', { class: 'muted' }, `${g.rounds.length} round(s) generated`),
    g.mode === 'round_robin' || g.mode === 'swiss'
      ? el('button', { on: { click: async () => {
          try { await post(`/api/groups/${g.id}/next-round`); await refresh(); }
          catch (err) { alert(err.message); }
        } } }, 'Generate next round')
      : el('p', { class: 'muted' }, 'Add matches in Scoring tab.'),
  )));
}

// -- Scoring ------------------------------------------------------------------
function renderScoring() {
  const root = $('#scoring-list');
  root.replaceChildren(...state.groups.map(g => el('div', { class: 'card' },
    el('h3', {}, g.name),
    ...g.rounds.map(r => el('div', {},
      el('h4', {}, `Round ${r.roundNo}`),
      ...r.matches.map(m => renderMatchRow(g, m)),
    )),
    g.mode === 'manual' ? renderAddManualMatch(g) : null,
  )));
}

function renderMatchRow(g, m) {
  if (m.p2 === '__bye__') {
    return el('div', { class: 'match' },
      el('span', { class: 'court' }, ''),
      el('span', {}, nameOf(m.p1)),
      el('span', {}, '—'),
      el('span', { class: 'muted' }, 'BYE'),
      el('span', {}, ''),
      el('span', { class: 'status' }, 'bye'),
    );
  }
  const sets = m.score.length ? m.score : [[null, null], [null, null], [null, null]];
  const scoreInputs = el('span', { class: 'row' },
    ...sets.map(([a, b], idx) => el('span', { class: 'row' },
      el('input', { class: 'score', type: 'number', min: 0, value: a ?? '', 'data-idx': idx, 'data-side': 'a' }),
      el('span', {}, '-'),
      el('input', { class: 'score', type: 'number', min: 0, value: b ?? '', 'data-idx': idx, 'data-side': 'b' }),
    )),
  );
  const courtInput = el('input', { class: 'court-input', value: m.court ?? '', placeholder: 'Court' });

  async function save(status) {
    const score = [];
    for (let i = 0; i < 3; i++) {
      const aIn = scoreInputs.querySelector(`input[data-idx="${i}"][data-side="a"]`);
      const bIn = scoreInputs.querySelector(`input[data-idx="${i}"][data-side="b"]`);
      const a = aIn.value === '' ? null : Number(aIn.value);
      const b = bIn.value === '' ? null : Number(bIn.value);
      if (a == null || b == null) continue;
      score.push([a, b]);
    }
    await patch(`/api/groups/${g.id}/matches/${m.id}`, { score, status, court: courtInput.value });
    await refresh();
  }

  return el('div', { class: 'match' },
    el('span', { class: 'court' }, courtInput),
    el('span', {}, nameOf(m.p1)),
    el('span', { class: 'muted' }, 'vs'),
    el('span', {}, nameOf(m.p2)),
    scoreInputs,
    el('span', { class: 'row' },
      el('button', { class: 'ghost', on: { click: () => save('live') } }, '▶'),
      el('button', { on: { click: () => save('done') } }, '✓'),
      el('span', { class: 'status ' + m.status }, m.status),
    ),
  );
}

function renderAddManualMatch(g) {
  const opts = g.members.map(id => el('option', { value: id }, nameOf(id)));
  const p1Sel = el('select', {}, ...opts.map(o => o.cloneNode(true)));
  const p2Sel = el('select', {}, ...opts.map(o => o.cloneNode(true)));
  const roundIn = el('input', { type: 'number', min: 1, value: (g.rounds.at(-1)?.roundNo ?? 0) + 1, style: 'width:5rem' });
  return el('div', { class: 'row', style: 'margin-top:0.5rem' },
    el('em', {}, 'Add match: '), p1Sel, el('span', {}, ' vs '), p2Sel,
    el('span', {}, ' round '), roundIn,
    el('button', { on: { click: async () => {
      if (p1Sel.value === p2Sel.value) return alert('Pick two different players');
      await post(`/api/groups/${g.id}/matches`, {
        p1: p1Sel.value, p2: p2Sel.value, roundNo: Number(roundIn.value),
      });
      await refresh();
    } } }, 'Add'),
  );
}

// -- Bracket ------------------------------------------------------------------
$('#create-bracket').addEventListener('submit', async (e) => {
  e.preventDefault();
  const size = Number(new FormData(e.target).get('size'));
  const sortedBySeed = [...state.participants]
    .filter(p => !p.withdrawn)
    .sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
  const seeds = sortedBySeed.slice(0, size).map(p => p.id);
  await post('/api/knockout', { size, seeds });
  await refresh();
});

$('#delete-bracket').addEventListener('click', async () => {
  if (!confirm('Delete bracket?')) return;
  await del('/api/knockout'); await refresh();
});

function renderBracket() {
  const root = $('#bracket-view');
  root.replaceChildren();
  if (!state.knockout) {
    root.append(el('p', { class: 'muted' }, 'No bracket yet.'));
    return;
  }
  for (const round of state.knockout.rounds) {
    const col = el('div', { class: 'bracket-round' },
      el('h4', {}, `Round ${round.roundNo}`),
    );
    for (const slot of round.slots) {
      col.append(renderBracketSlot(round.roundNo, slot));
    }
    root.append(col);
  }
}

function renderBracketSlot(roundNo, slot) {
  const a = slot.p1 ? nameOf(slot.p1) : '—';
  const b = slot.p2 ? nameOf(slot.p2) : '—';
  const winnerClass = (id) => slot.winner === id ? 'winner' : '';

  const sets = slot.score.length ? slot.score : [[null, null], [null, null], [null, null]];
  const scoreInputs = el('div', { class: 'row' },
    ...sets.map(([sa, sb], idx) => el('span', { class: 'row' },
      el('input', { class: 'score', type: 'number', min: 0, value: sa ?? '', 'data-idx': idx, 'data-side': 'a' }),
      el('span', {}, '-'),
      el('input', { class: 'score', type: 'number', min: 0, value: sb ?? '', 'data-idx': idx, 'data-side': 'b' }),
    )),
  );

  async function save(winnerId) {
    const score = [];
    for (let i = 0; i < 3; i++) {
      const aIn = scoreInputs.querySelector(`input[data-idx="${i}"][data-side="a"]`);
      const bIn = scoreInputs.querySelector(`input[data-idx="${i}"][data-side="b"]`);
      const av = aIn.value === '' ? null : Number(aIn.value);
      const bv = bIn.value === '' ? null : Number(bIn.value);
      if (av == null || bv == null) continue;
      score.push([av, bv]);
    }
    await patch(`/api/knockout/round/${roundNo}/slot/${slot.slot}`, { score, winner: winnerId });
    await refresh();
  }

  return el('div', { class: 'bracket-slot' },
    el('div', { class: 'player' },
      el('span', { class: winnerClass(slot.p1) }, a),
      slot.p1 && slot.p2 ? el('button', { class: 'ghost', on: { click: () => save(slot.p1) } }, 'Win') : null,
    ),
    el('div', { class: 'player' },
      el('span', { class: winnerClass(slot.p2) }, b),
      slot.p1 && slot.p2 ? el('button', { class: 'ghost', on: { click: () => save(slot.p2) } }, 'Win') : null,
    ),
    slot.p1 && slot.p2 ? scoreInputs : null,
  );
}

// -- Settings -----------------------------------------------------------------
$('#rename').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = new FormData(e.target).get('name');
  await put('/api/state/name', { name });
  await refresh();
});

// -- Boot ---------------------------------------------------------------------
await refresh();
await refreshPublishStatus();
