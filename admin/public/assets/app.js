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
  renderGroupsOverview();
  renderGroupstage();
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
  if (state.groups.length === 0) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No groups yet.'));
    return;
  }
  root.replaceChildren(el('ul', { class: 'overview-list' },
    ...state.groups.map(g => {
      const { done, total } = matchProgress(g);
      return el('li', {},
        el('a', { href: `#group-${g.id}`, on: { click: (e) => {
          e.preventDefault();
          const card = document.getElementById(`group-${g.id}`);
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } } }, g.name),
        el('span', { class: 'muted' }, ` · ${groupLabel(g)} · ${g.members.length} member${g.members.length === 1 ? '' : 's'}`),
        total > 0 ? el('span', { class: 'muted' }, ` · ${done}/${total} matches`) : null,
      );
    }),
  ));
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

$('#auto-generate-groups').addEventListener('click', async () => {
  const form = $('#add-group');
  const fd = new FormData(form);
  const category = fd.get('category') || '';
  const classes = [...fd.getAll('classes')].map(String);
  const mode = fd.get('mode') || 'round_robin';
  const playersPerGroup = Number(fd.get('playersPerGroup') || 0);

  if (!category) return alert('Pick a category first.');
  if (!Number.isFinite(playersPerGroup) || playersPerGroup < 2) {
    return alert('Players per group must be at least 2.');
  }

  const claimed = new Set(state.groups.flatMap(g => g.members));
  const eligible = state.participants.filter(p => {
    if (claimed.has(p.id)) return false;
    if (p.category !== category) return false;
    if (classes.length && !classes.includes(p.class)) return false;
    return true;
  });

  const numGroups = Math.floor(eligible.length / playersPerGroup);
  if (numGroups === 0) {
    return alert(`Need ${playersPerGroup} eligible participants; have ${eligible.length}.`);
  }
  const leftover = eligible.length - numGroups * playersPerGroup;
  const msg = `Create ${numGroups} group(s) of ${playersPerGroup}?`
    + (leftover ? ` ${leftover} participant(s) will be left unassigned.` : '');
  if (!confirm(msg)) return;

  // Snake-seed across groups: top seeds spread evenly. Unseeded (seed===0)
  // sort to the end so they fill the lowest slots.
  const ranked = [...eligible].sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
  const buckets = Array.from({ length: numGroups }, () => []);
  for (let i = 0; i < numGroups * playersPerGroup; i++) {
    const lap = Math.floor(i / numGroups);
    const col = i % numGroups;
    const idx = lap % 2 === 0 ? col : numGroups - 1 - col;
    buckets[idx].push(ranked[i].id);
  }

  for (const members of buckets) {
    const name = defaultGroupName(category, classes);
    state = await post('/api/groups', { name, mode, category, classes, members });
  }
  await refresh();
  syncDefaultGroupName();
});

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

// Map "pId vs qId" -> done match (last entered wins if duplicates).
function h2hIndex(g) {
  const idx = new Map();
  for (const m of doneMatches(g)) {
    idx.set(`${m.p1}|${m.p2}`, m);
  }
  return idx;
}

function renderStandingsTable(g) {
  const rows = computeStandings(g);
  if (rows.length === 0) return el('p', { class: 'muted' }, 'No members yet.');
  return el('table', { class: 'standings' },
    el('thead', {}, el('tr', {},
      el('th', { class: 'num' }, '#'),
      el('th', {}, 'Player'),
      el('th', { class: 'num' }, 'P'),
      el('th', { class: 'num' }, 'W'),
      el('th', { class: 'num' }, 'L'),
      el('th', { class: 'num' }, 'Pts'),
      el('th', { class: 'num' }, 'Sets+'),
      el('th', { class: 'num' }, 'Set diff'),
      el('th', { class: 'num' }, 'Pt diff'),
    )),
    el('tbody', {}, ...rows.map(r => el('tr', r.rank === 1 && r.played > 0 ? { class: 'top-pts' } : {},
      el('td', { class: 'num' }, String(r.rank)),
      el('td', {}, r.name),
      el('td', { class: 'num' }, String(r.played)),
      el('td', { class: 'num' }, String(r.won)),
      el('td', { class: 'num' }, String(r.lost)),
      el('td', { class: 'num' }, String(r.won)),
      el('td', { class: 'num' }, String(r.setsWon)),
      el('td', { class: 'num' }, String(r.setsWon - r.setsLost)),
      el('td', { class: 'num' }, String(r.pointsWon - r.pointsLost)),
    ))),
  );
}

function renderH2H(g) {
  if (g.members.length < 2) return null;
  const ordered = computeStandings(g).map(r => r.participantId);
  const idx = h2hIndex(g);
  const cell = (rowId, colId) => {
    if (rowId === colId) return el('td', { class: 'self' }, '—');
    const m = idx.get(`${rowId}|${colId}`) ?? idx.get(`${colId}|${rowId}`);
    if (!m) return el('td', { class: 'empty' }, '·');
    const { p1Sets, p2Sets } = setScore(m);
    const rowIsP1 = m.p1 === rowId;
    const a = rowIsP1 ? p1Sets : p2Sets;
    const b = rowIsP1 ? p2Sets : p1Sets;
    return el('td', { class: a > b ? 'win' : '' }, `${a}–${b}`);
  };
  return el('details', { open: true },
    el('summary', {}, 'Head-to-head'),
    el('table', { class: 'h2h' },
      el('thead', {}, el('tr', {},
        el('th', {}, ''),
        ...ordered.map(id => el('th', {}, nameOf(id))),
      )),
      el('tbody', {}, ...ordered.map(rowId => el('tr', {},
        el('th', { class: 'rowhead' }, nameOf(rowId)),
        ...ordered.map(colId => cell(rowId, colId)),
      ))),
    ),
  );
}

function renderGroupstageMatches(g) {
  if (g.rounds.length === 0) return el('p', { class: 'muted' }, 'No rounds yet.');
  return el('div', {}, ...g.rounds.map(r => el('div', {},
    el('h4', {}, `Round ${r.roundNo}`),
    ...r.matches.map(m => el('div', { class: 'row', style: 'gap:0.75rem; padding:0.2rem 0;' },
      el('span', { class: 'muted', style: 'min-width:3rem' }, m.court ? `Court ${m.court}` : ''),
      el('span', {}, nameOf(m.p1)),
      el('span', { class: 'muted' }, 'vs'),
      el('span', {}, nameOf(m.p2)),
      el('span', { class: 'muted' }, m.score.map(([a, b]) => `${a}-${b}`).join(', ')),
      el('span', { class: 'status ' + m.status, style: 'font-size:0.75rem; text-transform:uppercase;' }, m.status),
    )),
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
      renderH2H(g),
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

// -- Scoring ------------------------------------------------------------------
function renderScoring() {
  const root = $('#scoring-list');
  root.replaceChildren(...state.groups.map(g => el('div', { class: 'card' },
    el('h3', {}, g.name),
    ...g.rounds.map(r => el('div', {},
      el('h4', {}, `Round ${r.roundNo}`),
      ...r.matches.map(m => renderMatchRow(g, m)),
    )),
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
