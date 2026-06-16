import { buildCategoryTree } from './render-groups.js';

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (v == null || v === false) continue;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

function bracketLabel(kb) {
  const parts = [];
  if (kb.category) parts.push(kb.category);
  if (kb.classes && kb.classes.length) parts.push(kb.classes.join('/'));
  return parts.join(' · ');
}

function bracketProgress(kb) {
  let total = 0, done = 0;
  for (const r of kb.rounds || []) {
    for (const s of r.slots) {
      if (s.p1 === 'BYE' || s.p2 === 'BYE') continue;
      total++;
      if (s.status === 'done') done++;
    }
  }
  return { total, done };
}

function maxSetCount(rounds) {
  let max = 0;
  for (const r of rounds) {
    for (const s of r.slots) {
      if (s.score && s.score.length > max) max = s.score.length;
    }
  }
  return Math.max(2, max);
}

function renderMatch(slot, setColumns) {
  const sets = slot.score || [];
  const p1Won = !!slot.winner && slot.p1 && slot.winner === slot.p1;
  const p2Won = !!slot.winner && slot.p2 && slot.winner === slot.p2;
  const isWalkover = !!slot.walkover;

  // Show the better (lower) seed in the match as the left badge — mirrors how
  // bracket sheets badge the top-seeded entrant.
  const seeds = [slot.p1Seed, slot.p2Seed].filter(n => typeof n === 'number' && n > 0);
  const seedBadge = seeds.length ? Math.min(...seeds) : '';

  function row(name, won, sideIdx) {
    const cells = [];
    cells.push(el('div', { class: 'bm-name' + (won ? ' winner' : '') }, name || '—'));
    if (isWalkover) {
      cells.push(el('div', { class: 'bm-walkover', style: `grid-column: span ${setColumns}` },
        won ? 'walkover' : '',
      ));
    } else {
      for (let i = 0; i < setColumns; i++) {
        const set = sets[i];
        const mine = set ? set[sideIdx] : null;
        const other = set ? set[1 - sideIdx] : null;
        const winSet = set && mine > other;
        cells.push(el('div', { class: 'bm-set' + (winSet ? ' set-won' : '') },
          mine == null ? '' : String(mine),
        ));
      }
    }
    return el('div', { class: 'bm-row' + (won ? ' winner' : '') }, ...cells);
  }

  const classes = ['bracket-match', slot.status || 'pending', isWalkover ? 'walkover' : ''].filter(Boolean).join(' ');
  return el('div', { class: classes },
    el('div', { class: 'bm-seed' }, seedBadge === '' ? '' : String(seedBadge)),
    el('div', { class: 'bm-rows' },
      row(slot.p1, p1Won, 0),
      row(slot.p2, p2Won, 1),
    ),
  );
}

function roundLabel(round) {
  const name = round && typeof round.name === 'string' ? round.name.trim() : '';
  return name || `Round ${round.roundNo}`;
}

function renderRoundGroup(rounds, setColumns) {
  const cols = el('div', { class: 'bracket-cols' });
  for (const round of rounds) {
    const col = el('div', { class: 'bracket-round' },
      el('h3', {}, roundLabel(round)),
    );
    // Pair consecutive slots so we can draw a connector line between each pair.
    const pairs = el('div', { class: 'bracket-pairs' });
    const slots = round.slots;
    for (let i = 0; i < slots.length; i += 2) {
      const pair = el('div', { class: 'bracket-pair' });
      pair.append(renderMatch(slots[i], setColumns));
      if (slots[i + 1]) pair.append(renderMatch(slots[i + 1], setColumns));
      pairs.append(pair);
    }
    col.append(pairs);
    cols.append(col);
  }
  return cols;
}

function renderOneBracket(kb) {
  const rounds = kb.rounds || [];
  const setColumns = maxSetCount(rounds);
  const body = el('div', { class: 'bracket-body' });

  // Tournament sheets get unwieldy at 5 rounds (32-slot brackets) on one row.
  // Split it: rounds 1-2 on top, 3-5 below. Sub-5-round brackets fit fine inline.
  if (rounds.length === 5) {
    body.classList.add('split');
    body.append(renderRoundGroup(rounds.slice(0, 2), setColumns));
    body.append(renderRoundGroup(rounds.slice(2), setColumns));
  } else {
    body.append(renderRoundGroup(rounds, setColumns));
  }

  const label = bracketLabel(kb);
  return el('section', { class: 'bracket', id: `bracket-${kb.id}` },
    el('h2', {}, kb.name, label ? el('span', { class: 'muted' }, ` (${label})`) : null),
    body,
  );
}

function renderOverview(brackets) {
  const tree = buildCategoryTree(brackets, b => b.classes || []);
  const treeEl = el('div', { class: 'category-tree' });
  for (const col of tree) {
    const colEl = el('div', { class: 'category-col' },
      el('h3', { class: 'category-head' }, col.category || '—'),
    );
    if (col.classes.length === 0) {
      colEl.append(el('p', { class: 'muted empty' }, '—'));
    } else {
      for (const block of col.classes) {
        const blockEl = el('div', { class: 'class-block' });
        if (block.class) blockEl.append(el('h4', { class: 'class-head' }, block.class));
        const list = el('ul', { class: 'class-list' });
        for (const b of block.items) {
          const { total, done } = bracketProgress(b);
          list.append(el('li', {},
            el('a', { href: `#bracket-${b.id}` },
              el('span', { class: 'item-name' }, b.name),
              el('span', { class: 'item-meta muted' }, `${done}/${total}`),
            ),
          ));
        }
        blockEl.append(list);
        colEl.append(blockEl);
      }
    }
    treeEl.append(colEl);
  }
  const section = el('section', { class: 'overview' },
    el('div', { class: 'overview-header' }, el('h2', {}, 'Brackets')),
    treeEl,
  );
  treeEl.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#bracket-"]');
    if (!link) return;
    e.preventDefault();
    const id = link.getAttribute('href').slice(1);
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', `#${id}`);
  });
  return section;
}

export function renderKnockout(root, data) {
  root.replaceChildren();
  // Tolerate the legacy `{ size, rounds }` shape published by older admin
  // versions: render it as a single nameless bracket.
  const brackets = data && Array.isArray(data.brackets)
    ? data.brackets
    : data && data.rounds
      ? [{ id: 'legacy', name: 'Knockout', category: '', classes: [], size: data.size, rounds: data.rounds }]
      : [];
  if (brackets.length === 0) {
    root.append(el('p', { class: 'muted' }, 'Knockout bracket not yet posted.'));
    return;
  }
  root.append(renderOverview(brackets));
  for (const kb of brackets) root.append(renderOneBracket(kb));

  // Honour an incoming URL fragment on first paint after data loads.
  const frag = window.location.hash.slice(1);
  if (frag.startsWith('bracket-')) {
    const target = document.getElementById(frag);
    if (target) target.scrollIntoView({ block: 'start' });
  }
}
