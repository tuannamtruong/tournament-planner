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
  renderBulkDelete();
  renderGroupstage();
  renderMatches();
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
    alert('Publish failed: ' + err.message);
  }
});

$('#push-backup').addEventListener('click', async () => {
  try { await post('/api/publish/backup'); alert('Backup snapshot pushed.'); }
  catch (err) { alert('Backup failed: ' + err.message); }
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
  return el('tr', { class: opts.error ? 'p-error' : '' },
    el('td', {}, p.name),
    el('td', {}, p.club),
    el('td', { class: 'mono' }, p.category),
    el('td', { class: 'mono' }, p.class),
    el('td', { class: 'num' }, String(p.seed || '')),
    el('td', { class: 'p-note' },
      opts.error ? el('span', { class: 'badge badge-error', title: 'Doubles entry without a partner — pair them up before drawing groups.' }, 'no partner') : null,
    ),
    el('td', {},
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

  if (!category) return alert('Pick a category first.');
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
// Key: `${groupId}:pending` or `${groupId}:done`. Default: pending open, done closed.
const matchesSectionsClosed = new Set(); // keys explicitly closed by the user
const matchesSectionsOpen = new Set();   // keys explicitly opened by the user

function isSectionOpen(groupId, kind) {
  const key = `${groupId}:${kind}`;
  if (matchesSectionsOpen.has(key)) return true;
  if (matchesSectionsClosed.has(key)) return false;
  return kind === 'pending';
}

function renderMatches() {
  renderMatchesOverview();
  renderLiveOverview();
  const root = $('#matches-list');
  root.replaceChildren(...state.groups.map(g => {
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
  }));
}

function renderMatchesOverview() {
  const root = $('#matches-overview');
  if (state.groups.length === 0) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No groups yet.'));
    return;
  }
  root.replaceChildren(el('ul', { class: 'overview-list' },
    ...state.groups.map(g => {
      const { done, total } = matchProgress(g);
      return el('li', {},
        el('a', { href: `#matches-group-${g.id}`, on: { click: (e) => {
          e.preventDefault();
          const card = document.getElementById(`matches-group-${g.id}`);
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } } }, g.name),
        total > 0
          ? el('span', { class: 'muted' }, ` · ${done}/${total} matches`)
          : el('span', { class: 'muted' }, ' · no matches yet'),
      );
    }),
  ));
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
        if (m.status === 'live') live.push({ g, r, m });
      }
    }
  }
  if (live.length === 0) {
    root.replaceChildren(el('p', { class: 'muted' }, 'No live matches.'));
    return;
  }
  live.sort((a, b) => compareCourts(a.m.court, b.m.court));
  root.replaceChildren(el('ul', { class: 'overview-list' },
    ...live.map(({ g, r, m }) => el('li', {},
      el('span', { class: 'live-court' }, m.court ? `Court ${m.court}` : 'No court'),
      el('span', {}, ` · ${nameOf(m.p1)} vs ${nameOf(m.p2)} `),
      el('a', { class: 'muted', href: `#matches-group-${g.id}`, on: { click: (e) => {
        e.preventDefault();
        const card = document.getElementById(`matches-group-${g.id}`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } } }, `${g.name} · R${r.roundNo}`),
    )),
  ));
}

function renderMatchesSection(g, kind, count, rounds) {
  const key = `${g.id}:${kind}`;
  const open = isSectionOpen(g.id, kind);
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

function renderMatchRow(g, m) {
  if (m.p2 === '__bye__') {
    return el('div', { class: 'match match-bye' },
      el('div', { class: 'match-players' },
        el('span', {}, nameOf(m.p1)),
        el('span', { class: 'muted' }, '— BYE'),
      ),
    );
  }
  const sets = m.score.length ? m.score : [[null, null], [null, null], [null, null]];
  const scoreInputs = el('div', { class: 'match-scores' },
    ...sets.map(([a, b], idx) => el('span', { class: 'score-pair' },
      el('input', { class: 'score', type: 'number', min: 0, value: a ?? '', 'data-idx': idx, 'data-side': 'a' }),
      el('span', { class: 'muted' }, '-'),
      el('input', { class: 'score', type: 'number', min: 0, value: b ?? '', 'data-idx': idx, 'data-side': 'b' }),
    )),
  );
  attachScoreValidation(scoreInputs);
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

  async function remove() {
    if (!confirm(`Remove ${nameOf(m.p1)} vs ${nameOf(m.p2)}?`)) return;
    await del(`/api/groups/${g.id}/matches/${m.id}`);
    await refresh();
  }

  return el('div', { class: 'match' },
    el('div', { class: 'match-court' }, courtInput),
    el('div', { class: 'match-players' },
      el('span', {}, nameOf(m.p1)),
      el('span', { class: 'muted' }, 'vs'),
      el('span', {}, nameOf(m.p2)),
    ),
    el('div', { class: 'match-actions' },
      scoreInputs,
      el('div', { class: 'match-buttons' },
        el('button', { class: 'ghost', title: 'Mark live', on: { click: () => save('live') } }, '▶'),
        el('button', { title: 'Mark done', on: { click: () => save('done') } }, '✓'),
        el('span', { class: 'status ' + m.status }, m.status),
        el('button', { class: 'ghost remove-match', title: 'Remove match', on: { click: remove } }, '✕'),
      ),
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
  attachScoreValidation(scoreInputs);

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
