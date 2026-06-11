export type Pairing = { p1: string; p2: string | null };

/**
 * Circle-method round-robin. Returns one entry per round; `p2: null` is a bye.
 * Deterministic given input order.
 */
export function roundRobin(members: string[]): { roundNo: number; pairs: Pairing[] }[] {
  if (members.length < 2) return [];
  const BYE = '__bye__';
  const players = members.length % 2 === 0 ? [...members] : [...members, BYE];
  const n = players.length;
  const rounds = n - 1;
  let arr = [...players];
  const out: { roundNo: number; pairs: Pairing[] }[] = [];

  for (let r = 0; r < rounds; r++) {
    const pairs: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a === BYE) pairs.push({ p1: b, p2: null });
      else if (b === BYE) pairs.push({ p1: a, p2: null });
      else pairs.push({ p1: a, p2: b });
    }
    out.push({ roundNo: r + 1, pairs });
    // Rotate: keep [0] fixed, last → position 1, rest shift right
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }
  return out;
}
