// Projets : verrou, détection, branche de travail, hook commit-msg, signatures ; carnet de Max.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectCommands, dirtyTree, ensureCommitHook, git, newProject, prepareBranch, ProjectLocks, signaturesBeforePush, slug } from '../server/projects.ts';
import { addRow, EMPTY_BACKLOG, nextId, parseBacklog, questionCount, setRow } from '../server/backlog.ts';

test('verrou : une seule demande à la fois par projet', () => {
  const l = new ProjectLocks();
  assert.ok(l.acquire('p1', 'm1'));
  assert.ok(l.acquire('p1', 'm1'));
  assert.ok(!l.acquire('p1', 'm2'));
  assert.ok(l.acquire('p2', 'm2'));
  l.release('p1', 'm2');
  assert.equal(l.holder('p1'), 'm1');
  l.release('p1', 'm1');
  assert.ok(l.acquire('p1', 'm2'));
});

test('nom de branche', () => {
  assert.equal(slug('Ajoute une fonction et son test'), 'ajoute-une-fonction-et-son-test');
  assert.equal(slug('Écris le résumé : « été » !'), 'ecris-le-resume-ete');
});

function repo() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'bureau-test-unit-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Testeur'); g('config', 'user.email', 't@example.com');
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', test: 'node --test', build: 'tsc', typecheck: 'tsc --noEmit' } }));
  writeFileSync(path.join(d, 'README.md'), '# Test\n');
  mkdirSync(path.join(d, 'scripts')); writeFileSync(path.join(d, 'scripts', 'merge-dev.sh'), 'echo merge\n');
  g('add', '.'); g('commit', '-qm', 'Départ');
  g('branch', 'dev');
  return { d, g };
}

test('détection : commandes, base dev, interdites, docs', async () => {
  const { d } = repo();
  try {
    const cmds = detectCommands(d);
    assert.deepEqual(cmds.map((c) => `${c.name}=${c.cmd}`), ['Lint=npm run lint', 'Typage=npm run typecheck', 'Tests=npm test', 'Build=npm run build', 'Merge=bash scripts/merge-dev.sh']);
    const p = await newProject(d);
    assert.equal(p.base, 'dev');
    assert.deepEqual(p.forbidden, ['main']);
    assert.deepEqual(p.readFirst, ['README.md']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('branche de travail depuis la base, hook, signatures avant push', async () => {
  const { d, g } = repo();
  try {
    assert.equal(await ensureCommitHook(d), 'installed');
    assert.equal(await ensureCommitHook(d), 'present');
    const r = await prepareBranch(d, 'dev', 'bureau/d-001-test', false);
    assert.ok(r.ok, r.note);
    assert.equal((await git(d, ['branch', '--show-current'])).out, 'bureau/d-001-test');
    // le hook retire la signature
    writeFileSync(path.join(d, 'a.txt'), 'a');
    g('add', '.');
    writeFileSync(path.join(d, 'msg.txt'), 'Ajoute a\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
    g('commit', '-q', '-F', 'msg.txt');
    assert.equal(g('log', '-1', '--format=%B').trim(), 'Ajoute a');
    assert.equal(await signaturesBeforePush(d, 'dev'), null);
    // sans le hook, la signature est repérée avant le push
    writeFileSync(path.join(d, 'b.txt'), 'b'); g('add', 'b.txt');
    g('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Ajoute b\n\nGenerated with Claude Code');
    assert.ok(await signaturesBeforePush(d, 'dev'));
    // arbre sale : repéré, et on ne change pas de branche
    writeFileSync(path.join(d, 'README.md'), '# Modifié\n');
    assert.match((await dirtyTree(d)) ?? '', /README\.md/);
    const r2 = await prepareBranch(d, 'dev', 'bureau/d-002-x', true);
    assert.equal(r2.ok, false);
    assert.equal((await git(d, ['branch', '--show-current'])).out, 'bureau/d-001-test');
    assert.equal(readFileSync(path.join(d, 'README.md'), 'utf8'), '# Modifié\n');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('carnet : lecture, ajout, numéro, état, questions', () => {
  let t = EMPTY_BACKLOG('Test');
  assert.deepEqual(parseBacklog(t), []);
  t = addRow(t, { id: nextId(parseBacklog(t)), title: 'Ajoute une fonction', step: 'Questions', state: 'En cours', wait: '' });
  t = addRow(t, { id: nextId(parseBacklog(t)), title: 'Pagination | listes', step: 'Questions', state: 'À faire', wait: 'D-001' });
  const rows = parseBacklog(t)!;
  assert.deepEqual(rows.map((r) => r.id), ['D-001', 'D-002']);
  assert.equal(rows[1].title, 'Pagination / listes');
  t = setRow(t, 'D-001', { step: 'Code' });
  assert.equal(parseBacklog(t)![0].step, 'Code');
  // un backlog d'un autre format
  assert.deepEqual(parseBacklog('| ID | Tâche | Statut |\n|--|--|--|\n| T-003 | Cadre | En cours |')!.map((r) => [r.id, r.title, r.state]), [['T-003', 'Cadre', 'En cours']]);
  assert.equal(parseBacklog('# Notes\n- une idée\n'), null);
  assert.equal(questionCount('Chef, j’ai 3 questions : 1) …'), 3);
  assert.equal(questionCount("Chef, j'ai deux questions"), 2);
});
