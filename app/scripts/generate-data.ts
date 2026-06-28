// Generate a realistic demo roster for the admin app: singles + doubles entries
// across categories/classes, reusing the same people so per-person aggregation
// shows multiple disciplines, plus per-person registrants (club, check-in, fee)
// and a few partnerless doubles to demo pairing.
//
// Writes to TP_DATA_FILE (or admin/data/tournament.json) through storage.mutate,
// REPLACING participants/registrants/groups/knockouts. Deterministic per SEED.
//
// Run with:  npx tsx scripts/generate-data.ts     (or: make generate-data)
//            SEED=7 npx tsx scripts/generate-data.ts

import { mutate } from '../admin/src/storage.ts';
import { nanoid } from 'nanoid';
import type { Participant, Registrant } from '../admin/src/schema.ts';

// Deterministic PRNG (mulberry32) so re-runs are stable.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(Number(process.env.SEED ?? 42));
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number): boolean => rand() < p;
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const CLUBS = ['TV Karlsruhe', 'BC Nord', 'SV Süd', 'TG West', 'SV Ost', 'BV Mitte', 'TuS Rhein', 'SC Adler'];
const MALE = ['Lukas', 'Jonas', 'Felix', 'Max', 'Tim', 'Paul', 'Jan', 'Noah', 'Leon', 'Ben', 'Tom', 'David', 'Erik', 'Nico', 'Sven', 'Marc'];
const FEMALE = ['Mia', 'Emma', 'Hanna', 'Lena', 'Sophie', 'Lea', 'Anna', 'Clara', 'Nele', 'Maja', 'Jana', 'Sara', 'Lara', 'Lina', 'Ida', 'Greta'];
const LAST = ['Müller', 'Schmidt', 'Weber', 'Fischer', 'Wagner', 'Becker', 'Koch', 'Richter', 'Klein', 'Wolf', 'Schäfer', 'Neumann', 'Braun', 'Krüger', 'Hofmann', 'Lang'];
const CLASSES = ['A', 'B', 'C', 'D'];

type Person = { name: string; club: string };
const used = new Set<string>();
function makePerson(firsts: string[]): Person {
  let name: string;
  do { name = `${pick(firsts)} ${pick(LAST)}`; } while (used.has(name));
  used.add(name);
  return { name, club: pick(CLUBS) };
}

const men = Array.from({ length: 16 }, () => makePerson(MALE));
const women = Array.from({ length: 16 }, () => makePerson(FEMALE));

const participants: Participant[] = [];
const registrants: Record<string, Registrant> = {};
const key = (n: string) => n.trim().toLowerCase();

// Per-person registrant (club + check-in + fee). Created once per human, so the
// same person across several disciplines shares one club/check-in/fee.
function ensureRegistrant(p: Person): void {
  const k = key(p.name);
  if (registrants[k]) return;
  const present = chance(0.75);
  const paid = present && chance(0.8);
  registrants[k] = { club: p.club, present, paid, paidAmount: paid ? pick([15, 20, 25, 30]) : 0 };
}

function addEntry(category: string, cls: string, people: Person[]): void {
  participants.push({ id: nanoid(8), withdrawn: false, category, class: cls, players: people.map(p => p.name) });
  people.forEach(ensureRegistrant);
}

// Singles: everyone plays their singles discipline.
for (const p of men) addEntry('MS', pick(CLASSES), [p]);
for (const p of women) addEntry('WS', pick(CLASSES), [p]);

// Same-gender doubles: pair up a sample, leaving a couple partnerless to pair later.
function buildDoubles(category: string, pool: Person[], teams: number, solos: number): void {
  const sh = shuffle(pool);
  let i = 0;
  for (let t = 0; t < teams && i + 1 < sh.length; t++, i += 2) addEntry(category, pick(CLASSES), [sh[i], sh[i + 1]]);
  for (let s = 0; s < solos && i < sh.length; s++, i++) addEntry(category, pick(CLASSES), [sh[i]]);
}
buildDoubles('MD', men, 5, 2);
buildDoubles('WD', women, 5, 2);

// Mixed doubles: pair a man with a woman; leave one of each partnerless.
const mxMen = shuffle(men);
const mxWomen = shuffle(women);
for (let i = 0; i < 6; i++) addEntry('MX', pick(CLASSES), [mxMen[i], mxWomen[i]]);
addEntry('MX', pick(CLASSES), [mxMen[6]]);   // partnerless man
addEntry('MX', pick(CLASSES), [mxWomen[6]]); // partnerless woman

const present = Object.values(registrants).filter(r => r.present).length;
const paid = Object.values(registrants).filter(r => r.paid).length;
const collected = Object.values(registrants).reduce((s, r) => s + r.paidAmount, 0);

await mutate(
  { action: 'generate_data', payload: { participants: participants.length, people: Object.keys(registrants).length } },
  (s) => {
    s.participants = participants;
    s.registrants = registrants;
    s.groups = [];
    s.knockouts = [];
    return s;
  },
);

console.log(`Generated ${participants.length} entries / ${Object.keys(registrants).length} people`);
console.log(`  present: ${present}  paid: ${paid}  collected: ${collected}`);
console.log('Groups & knockouts reset. Run `make dev` to view, or `npx tsx scripts/simulate-tournament.ts` to play it out.');
process.exit(0);
