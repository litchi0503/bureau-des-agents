// La détection des agents bloqués et plantés.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedFor, crashReason, resultError } from '../server/watchdog.ts';
import { linesOf } from '../server/history.ts';

const MIN = 60_000;

test('Bloqué après le délai réglé, sauf s’il attend', () => {
  const t0 = 1_000_000;
  assert.equal(blockedFor(t0 + 9 * MIN, t0, 10, false), 0);
  assert.equal(blockedFor(t0 + 10 * MIN, t0, 10, false), 10);
  assert.equal(blockedFor(t0 + 12 * MIN, t0, 10, false), 12);
  assert.equal(blockedFor(t0 + 40 * MIN, t0, 30, true), 0);
  assert.equal(blockedFor(t0 + 6 * MIN, t0, 5, false), 6);
});

test('Planté : processus en erreur, mais pas un arrêt demandé', () => {
  assert.equal(crashReason({ code: 0, signal: null, stderr: '', stopping: false }), null);
  assert.equal(crashReason({ code: 1, signal: null, stderr: 'boom', stopping: true }), null);
  assert.equal(crashReason({ code: 1, signal: null, stderr: 'x\nError: API exploded', stopping: false }), 'x Error: API exploded');
  assert.match(crashReason({ code: null, signal: 'SIGKILL', stderr: '', stopping: false }) ?? '', /SIGKILL/);
  assert.match(crashReason({ code: 1, signal: null, stderr: 'Claude AI usage limit reached', stopping: false }) ?? '', /^Limite atteinte/);
  assert.match(crashReason({ code: 1, signal: null, stderr: 'Invalid API key · Please run /login 401', stopping: false }) ?? '', /connecté/);
});

test('Résultat d’erreur et limite', () => {
  assert.equal(resultError('error_during_execution', 'You have hit your limit · resets 5pm').limit, true);
  assert.equal(resultError('error_max_turns', '').limit, false);
  assert.match(resultError('error_max_turns', '').reason, /tours/);
});

test('Historique : une ligne par fait, avec le modèle', () => {
  const lines = linesOf({ k: 'state', who: 'a1', state: 'blocked', reason: 'Bloqué · 12 min' }, 5, () => 'sonnet');
  assert.deepEqual(lines, [{ who: 'a1', line: { at: 5, type: 'état', detail: 'Bloqué : Bloqué · 12 min', model: 'sonnet' } }]);
  const sw = linesOf({ k: 'model', who: 'a1', model: 'opus', effort: 'xhigh', from: 'fable', reason: 'quota de Fable 5.2 plein' }, 6, () => 'opus');
  assert.equal(sw[0].line.type, 'modèle');
  assert.match(sw[0].line.detail, /Fable 5.2 → Opus 5.5/);
  assert.equal(linesOf({ k: 'hire', id: 'a2', role: 'code', type: 'developpeur', name: 'Ada', task: 'Ajoute la fonction', prompt: '…' }, 7, () => undefined).length, 2);
});
