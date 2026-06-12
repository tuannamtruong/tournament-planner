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

export function renderGroups(root, groups) {
  root.replaceChildren();
  if (groups.length === 0) {
    root.append(el('p', { class: 'muted' }, 'No groups yet.'));
    return;
  }

  const toggleBtn = el('button', { type: 'button', class: 'toggle-all' }, 'Open all');
  const overviewList = el('ul', { class: 'overview-list' });
  for (const g of groups) {
    const { total, done } = matchCounts(g);
    const memberCount = (g.members && g.members.length)
      || (g.standings && g.standings.length) || 0;
    overviewList.append(el('li', {},
      el('a', { href: `#group-${g.id}` },
        el('span', { class: 'overview-name' }, g.name),
        el('span', { class: 'overview-meta muted' },
          `${g.mode.replace('_', ' ')} · ${memberCount} players · ${done}/${total} matches`),
      ),
    ));
  }
  root.append(el('section', { class: 'overview' },
    el('div', { class: 'overview-header' },
      el('h2', {}, 'Groups'),
      toggleBtn,
    ),
    overviewList,
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
          el('tbody', {}, ...g.standings.map(s => el('tr', {},
            el('td', {}, s.rank),
            el('td', {}, s.name),
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
          matchList.append(el('div', { class: 'match ' + m.status },
            el('span', { class: 'court muted' }, m.court || ''),
            el('span', { class: 'player' }, m.p1),
            el('span', { class: 'vs muted' }, 'vs'),
            el('span', { class: 'player' }, m.p2),
            el('span', { class: 'score' }, scoreText(m.score)),
            el('span', { class: 'status muted' }, m.status),
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

  overviewList.addEventListener('click', (e) => {
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
