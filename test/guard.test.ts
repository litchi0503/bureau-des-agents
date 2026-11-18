// La règle du garde-fou (plafonds, levée du week-end, budget par demande, fenêtre rechargée).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardDecision, parisDayHour } from '../server/guard.ts';
import { DEFAULT_GUARD } from '../shared/settings.ts';
import type { Quota } from '../shared/protocol.ts';

// novembre 2026, heure de Paris = UTC+1
const paris = (d: string, h: number) => Date.UTC(2026, 10, Number(d), h - 1);
const sec = (ms: number) => Math.round(ms / 1000);
const TUE = paris('17', 10), SAT = paris('21', 10), SUN = paris('22', 12), NEXT_TUE = paris('24', 9);
const q = (week: number, weekReset: number, five = 0.1, fiveReset = TUE + 3 * 3600_000): Quota => ({ fiveHour: five, resetsAt: sec(fiveReset), sevenDay: week, sevenDayResetsAt: sec(weekReset) });

test('les jours de test tombent bien', () => {
  assert.deepEqual(parisDayHour(TUE), { day: 2, hour: 10 });
  assert.deepEqual(parisDayHour(SAT), { day: 6, hour: 10 });
  assert.equal(parisDayHour(SUN).day, 0);
});

test('mardi à 85 % de la semaine : pause café jusqu’au reset', () => {
  const r = guardDecision({ now: TUE, quota: q(0.85, SUN), guard: DEFAULT_GUARD });
  assert.equal(r.kind, 'pause');
  assert.equal(r.kind === 'pause' && r.window, 'week');
});

test('mardi à 85 % de la fenêtre de 5 h : pause jusqu’à sa recharge', () => {
  const r = guardDecision({ now: TUE, quota: q(0.2, SUN, 0.85), guard: DEFAULT_GUARD });
  assert.equal(r.kind, 'pause');
  assert.equal(r.kind === 'pause' && r.resumeAt, TUE + 3 * 3600_000);
});

test('samedi 10:00, reset dimanche, à 90 % : autorisé (plafond levé)', () => {
  assert.equal(guardDecision({ now: SAT, quota: q(0.9, SUN, 0.9, SAT + 3600_000), guard: DEFAULT_GUARD }).kind, 'ok');
});

test('samedi, reset mardi, case « week-end » cochée, à 85 % : pause', () => {
  assert.equal(guardDecision({ now: SAT, quota: q(0.85, NEXT_TUE), guard: DEFAULT_GUARD }).kind, 'pause');
});

test('samedi, reset mardi, case décochée, à 85 % : autorisé', () => {
  assert.equal(guardDecision({ now: SAT, quota: q(0.85, NEXT_TUE), guard: { ...DEFAULT_GUARD, liftOnlyWeekend: false } }).kind, 'ok');
});

test('à 100 %, même le samedi : pause (c’est l’abonnement qui s’arrête)', () => {
  assert.equal(guardDecision({ now: SAT, quota: q(1, SUN), guard: DEFAULT_GUARD }).kind, 'pause');
});

test('budget de la demande dépassé : arrêt et question', () => {
  const g = { ...DEFAULT_GUARD, budget: 10 };
  const r = guardDecision({ now: TUE, quota: q(0.42, SUN), guard: g, base: 0.3 });
  assert.equal(r.kind, 'budget');
  assert.ok(r.kind === 'budget' && Math.abs(r.used - 0.12) < 1e-9);
  assert.equal(guardDecision({ now: TUE, quota: q(0.35, SUN), guard: g, base: 0.3 }).kind, 'ok');
  assert.equal(guardDecision({ now: TUE, quota: q(0.42, SUN), guard: g, base: 0.3, bypass: true }).kind, 'ok');
});

test('fenêtre déjà rechargée : pas de pause', () => {
  // la mesure date d'avant le reset de la semaine (85 %), mais on est après : la fenêtre est rechargée
  assert.equal(guardDecision({ now: NEXT_TUE, quota: q(0.85, SUN, 0.95, SUN), guard: DEFAULT_GUARD }).kind, 'ok');
});

test('ignorer le garde-fou : plus de plafond sous 100 %', () => {
  assert.equal(guardDecision({ now: TUE, quota: q(0.95, SUN, 0.9), guard: DEFAULT_GUARD, bypass: true }).kind, 'ok');
});
