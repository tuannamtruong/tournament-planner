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

function scoreText(score) {
  if (!score || score.length === 0) return '';
  return score.map(([a, b]) => `${a}-${b}`).join(', ');
}

function matchScoreCell(m) {
  if (m.walkover) {
    const winnerName = m.walkover === 'p1' ? m.p1 : m.p2;
    return el('span', { class: 'score walkover' }, `walkover (${winnerName})`);
  }
  return el('span', { class: 'score' }, scoreText(m.score));
}

function matchCounts(g) {
  let total = 0, done = 0;
  for (const r of g.rounds || []) {
    for (const m of r.matches) {
      total++;
      if (m.status === 'done') done++;
    }
  }
  return { total, done };
}

const CATEGORIES = ['MS', 'WS', 'MD', 'WD', 'MX'];
const CLASSES = ['S', 'A', 'B', 'C', 'D'];

export function buildCategoryTree(items, classesOf) {
  const tree = new Map();
  for (const cat of CATEGORIES) tree.set(cat, new Map());
  const otherCats = new Set();
  for (const item of items) {
    const cat = item.category || '';
    if (!tree.has(cat)) {
      tree.set(cat, new Map());
      if (cat) otherCats.add(cat);
    }
    const classBuckets = tree.get(cat);
    const classes = classesOf(item);
    const keys = classes.length ? classes : [''];
    for (const cls of keys) {
      if (!classBuckets.has(cls)) classBuckets.set(cls, []);
      classBuckets.get(cls).push(item);
    }
  }
  const order = [...CATEGORIES, ...[...otherCats].sort()];
  return order.map(cat => {
    const buckets = tree.get(cat) || new Map();
    const classOrder = [
      ...CLASSES.filter(c => buckets.has(c)),
      ...[...buckets.keys()].filter(c => !CLASSES.includes(c)).sort(),
    ];
    return {
      category: cat,
      classes: classOrder.map(cls => ({ class: cls, items: buckets.get(cls) })),
    };
  });
}

export function renderGroups(root, groups) {
  root.replaceChildren();
  if (groups.length === 0) {
    root.append(el('p', { class: 'muted' }, 'No groups yet.'));
    return;
  }

  const toggleBtn = el('button', { type: 'button', class: 'toggle-all' }, 'Open all');
  const tree = buildCategoryTree(groups, g => g.classes || []);
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
        for (const g of block.items) {
          const { total, done } = matchCounts(g);
          list.append(el('li', {},
            el('a', { href: `#group-${g.id}` },
              el('span', { class: 'item-name' }, g.name),
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
  root.append(el('section', { class: 'overview' },
    el('div', { class: 'overview-header' },
      el('h2', {}, 'Groups'),
      toggleBtn,
    ),
    treeEl,
  ));

  function updateToggleLabel() {
    const all = root.querySelectorAll('details.group');
    const allOpen = all.length > 0 && [...all].every(d => d.open);
    toggleBtn.textContent = allOpen ? 'Close all' : 'Open all';
  }

  for (const g of groups) {
    const id = `group-${g.id}`;
    const card = el('details', { class: 'group', id },
      el('summary', {},
        el('span', { class: 'group-name' }, g.name),
        el('span', { class: 'muted' }, ` (${g.mode.replace('_', ' ')})`),
      ),
    );
    card.addEventListener('toggle', updateToggleLabel);

    if (g.standings && g.standings.length > 0) {
      card.append(
        el('table', { class: 'standings' },
          el('thead', {}, el('tr', {},
            el('th', {}, '#'),
            el('th', {}, 'Player'),
            el('th', {}, 'W'),
            el('th', {}, 'L'),
            el('th', {}, 'Sets'),
            el('th', {}, 'Pts'),
          )),
          el('tbody', {}, ...g.standings.map(s => el('tr', { class: s.withdrawn ? 'withdrawn' : '' },
            el('td', {}, s.rank),
            el('td', {}, s.name,
              s.withdrawn ? el('span', { class: 'badge wd' }, ' WD') : null,
            ),
            el('td', {}, s.won),
            el('td', {}, s.lost),
            el('td', {}, `${s.setsWon}-${s.setsLost}`),
            el('td', {}, `${s.pointsWon}-${s.pointsLost}`),
          ))),
        ),
      );
    }

    if (g.rounds && g.rounds.length > 0) {
      const matchList = el('div', { class: 'matches' });
      for (const r of g.rounds) {
        matchList.append(el('h3', {}, `Round ${r.roundNo}`));
        for (const m of r.matches) {
          const classes = ['match', m.status, m.walkover ? 'walkover' : ''].filter(Boolean).join(' ');
          matchList.append(el('div', { class: classes },
            el('span', { class: 'court muted' }, m.court || ''),
            el('span', { class: 'player' }, m.p1),
            el('span', { class: 'vs muted' }, 'vs'),
            el('span', { class: 'player' }, m.p2),
            matchScoreCell(m),
            el('span', { class: 'status muted' }, m.walkover ? 'walkover' : m.status),
          ));
        }
      }
      card.append(matchList);
    }

    root.append(card);
  }

  toggleBtn.addEventListener('click', () => {
    const all = root.querySelectorAll('details.group');
    const anyClosed = [...all].some(d => !d.open);
    for (const d of all) d.open = anyClosed;
    updateToggleLabel();
  });

  treeEl.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#group-"]');
    if (!link) return;
    e.preventDefault();
    const id = link.getAttribute('href').slice(1);
    const target = document.getElementById(id);
    if (!target) return;
    target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', `#${id}`);
  });

  // Honour an incoming URL fragment on first paint after data loads.
  const frag = window.location.hash.slice(1);
  if (frag.startsWith('group-')) {
    const target = document.getElementById(frag);
    if (target) {
      target.open = true;
      target.scrollIntoView({ block: 'start' });
    }
  }

  updateToggleLabel();
}
