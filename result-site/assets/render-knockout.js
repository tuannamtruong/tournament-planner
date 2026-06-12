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

function bracketLabel(kb) {
  const parts = [];
  if (kb.category) parts.push(kb.category);
  if (kb.classes && kb.classes.length) parts.push(kb.classes.join('/'));
  return parts.join(' · ');
}

function renderOneBracket(kb) {
  const cols = el('div', { class: 'bracket-cols' });
  for (const round of kb.rounds) {
    const col = el('div', { class: 'bracket-round' },
      el('h3', {}, `Round ${round.roundNo}`),
    );
    for (const slot of round.slots) {
      col.append(el('div', { class: 'bracket-slot' },
        el('div', { class: 'player ' + (slot.winner === slot.p1 ? 'winner' : '') }, slot.p1 || '—'),
        el('div', { class: 'player ' + (slot.winner === slot.p2 ? 'winner' : '') }, slot.p2 || '—'),
        slot.score && slot.score.length
          ? el('div', { class: 'score muted' }, scoreText(slot.score))
          : null,
      ));
    }
    cols.append(col);
  }
  const label = bracketLabel(kb);
  return el('section', { class: 'bracket' },
    el('h2', {}, kb.name, label ? el('span', { class: 'muted' }, ` (${label})`) : null),
    cols,
  );
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
  for (const kb of brackets) root.append(renderOneBracket(kb));
}
