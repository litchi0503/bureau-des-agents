// Les préréglages de l'équipe et le repli quand un modèle n'a plus de quota.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloneTeam, defaultSettings, mergeSettings, PRESET_TEAMS, presetOf } from '../shared/settings.ts';
import { agentsJson, chefPrompt, poleModel } from '../server/team.ts';

test('Équilibré par défaut, et les valeurs demandées', () => {
  const s = defaultSettings();
  assert.equal(presetOf(s.team), 'equilibre');
  assert.deepEqual(s.team.chef, { model: 'fable', effort: 'high', places: 1, fallback: 'opus' });
  assert.deepEqual(s.team.recherche, { model: 'sonnet', effort: 'medium', places: 2, fallback: 'haiku' });
  assert.deepEqual(s.team.code, { model: 'fable', effort: 'xhigh', places: 1, fallback: 'opus' });
  assert.equal(s.guard.max5h, 80);
  assert.equal(s.guard.liftDay, 6);
  assert.equal(s.follow.blockedMin, 10);
});

test('Économe et Maximum', () => {
  assert.equal(PRESET_TEAMS.econome.chef.model, 'opus');
  assert.equal(PRESET_TEAMS.econome.code.model, 'sonnet');
  assert.equal(PRESET_TEAMS.econome.code.effort, 'xhigh');
  assert.equal(PRESET_TEAMS.econome.recherche.places, 1);
  for (const p of Object.values(PRESET_TEAMS.maximum)) { assert.equal(p.model, 'fable'); assert.equal(p.fallback, 'opus'); }
  assert.equal(PRESET_TEAMS.maximum.code.effort, 'max');
  assert.equal(PRESET_TEAMS.maximum.relecture.effort, 'max');
  assert.equal(PRESET_TEAMS.maximum.design.effort, 'xhigh');
  assert.equal(PRESET_TEAMS.maximum.recherche.places, 3);
});

test('Une ligne modifiée = Personnalisé', () => {
  const t = cloneTeam(PRESET_TEAMS.equilibre);
  t.design.places = 2;
  assert.equal(presetOf(t), null);
  assert.equal(presetOf(cloneTeam(PRESET_TEAMS.maximum)), 'maximum');
});

test('Réglages venus du navigateur : rien hors des bornes', () => {
  const s = mergeSettings(defaultSettings(), { team: { chef: { places: 3, model: 'gpt' }, code: { places: 9, effort: 'max' } }, guard: { max5h: 83, maxWeek: 95 }, follow: { blockedMin: 7 } });
  assert.equal(s.team.chef.places, 1);
  assert.equal(s.team.chef.model, 'fable');
  assert.equal(s.team.code.places, 1);
  assert.equal(s.team.code.effort, 'max');
  assert.equal(s.guard.max5h, 80);
  assert.equal(s.guard.maxWeek, 95);
  assert.equal(s.follow.blockedMin, 10);
});

test('Repli quand le quota d’un modèle est plein', () => {
  const s = defaultSettings();
  assert.equal(poleModel(s, 'code', new Set()), 'fable');
  assert.equal(poleModel(s, 'code', new Set(['fable'])), 'opus');
  assert.equal(poleModel(s, 'code', new Set(['fable', 'opus'])), null);
  s.team.redaction.fallback = 'none';
  assert.equal(poleModel(s, 'redaction', new Set(['sonnet'])), null);
  const agents = JSON.parse(agentsJson(s, new Set(['fable'])));
  assert.equal(agents.developpeur.model, 'opus');
  assert.equal(agents.developpeur.effort, 'xhigh');
  assert.deepEqual(agents.relecteur.tools, ['Read', 'Grep', 'Glob', 'Bash', 'Write']);
});

test('Consignes de Max : le fixe d’abord, identique d’une demande à l’autre', () => {
  const a = chefPrompt('', defaultSettings());
  const s2 = defaultSettings(); s2.team.recherche.places = 3;
  const b = chefPrompt('Je suis coach.', s2);
  const fixed = a.slice(0, a.indexOf('## Les réglages de cette demande'));
  assert.ok(fixed.length > 1500);
  assert.ok(b.startsWith(fixed));
  assert.match(a, /relu par le pôle Relecture/);
  assert.match(b, /Recherche \(chercheur\) : 3 places/);
});
