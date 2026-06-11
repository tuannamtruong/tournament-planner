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

export function renderKnockout(root, data) {
  root.replaceChildren();
  if (!data || !data.rounds) {
    root.append(el('p', { class: 'muted' }, 'Knockout bracket not yet posted.'));
    return;
  }
  for (const round of data.rounds) {
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
    root.append(col);
  }
}
