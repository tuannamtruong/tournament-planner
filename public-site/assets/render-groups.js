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

export function renderGroups(root, groups) {
  root.replaceChildren();
  if (groups.length === 0) {
    root.append(el('p', { class: 'muted' }, 'No groups yet.'));
    return;
  }
  for (const g of groups) {
    const card = el('section', { class: 'group' },
      el('h2', {}, g.name, ' ', el('span', { class: 'muted' }, `(${g.mode.replace('_', ' ')})`)),
    );

    // standings table
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

    // match grid
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
}
