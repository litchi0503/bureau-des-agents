// Le hook du bureau, commande par commande : lecture seule (permise sans question), permission à demander, refus.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReviewBash, classifyBash, gitVerdict, redirectTargets, withHint, type GitContext, type ShellContext } from '../server/policy.ts';

const sh: ShellContext = { cwd: '/p/erp', dirs: ['/p/erp', '/b/Projets/erp/demandes/D-001', '/b/Projets/erp'], home: '/h', strictRedirects: true, known: new Set(['react']) };
const kind = (cmd: string, c: Partial<ShellContext> = {}) => classifyBash(cmd, { ...sh, ...c }).kind;
const git: GitContext = { access: 'push', base: 'dev', work: 'bureau/d-001', forbidden: ['main'], current: 'bureau/d-001', branches: ['dev', 'main', 'bureau/d-001', 'feature/x', 'old'], tags: ['v1.0'], mergedRemote: ['old'] };
const gv = (cmd: string, c: Partial<GitContext> = {}) => gitVerdict(cmd, { ...git, ...c });

test('lecture seule : permise sans question', () => {
  for (const c of [
    'git status', 'git log --oneline -5', 'git show HEAD:package.json', 'git diff dev...HEAD', 'git branch -l', 'git branch', 'git branch -a -vv',
    'git tag -l', 'git tag', 'git ls-tree -r HEAD', 'git ls-files', 'git grep -n foo', 'git rev-parse HEAD', 'git merge-base dev HEAD',
    'git check-ignore -v x', 'git remote -v', 'git fetch origin', 'ls -la', 'cat a.txt', 'head -20 a', 'tail -n 5 b', 'wc -l *.ts',
    'grep -rn foo src', 'rg foo', 'find . -name "*.ts"', 'sed -n 1,20p a.ts', 'cut -d, -f1 a.csv', 'sort a', 'uniq a', 'diff a b',
    'file x', 'stat x', 'node -e "console.log(1+1)"',
  ]) assert.equal(kind(c), 'read', c);
});

test('lecture seule : pipes, commandes composées, redirections dans le projet', () => {
  assert.equal(kind('git log --oneline | head -5'), 'read');
  assert.equal(kind('git status && git diff --stat; ls'), 'read');
  assert.equal(kind('grep -rn TODO src | sort | uniq | wc -l'), 'read');
  assert.equal(kind('find . -name "*.md" | xargs wc -l'), 'read');
  assert.equal(kind('git diff > /b/Projets/erp/demandes/D-001/diff.txt'), 'read');
  assert.equal(kind('git log > notes.txt 2>&1'), 'read');
  assert.equal(kind('cat a 2>/dev/null'), 'read');
  assert.deepEqual(redirectTargets('git log > a.txt 2>&1 | tee x; echo b >> c'), ['a.txt', 'c']);
});

test('pas en lecture seule : le reste passe par Claude Code', () => {
  for (const c of [
    'git branch -d old', 'git tag v2', 'git commit -m x', 'find . -name x -delete', 'find . -exec rm {} ;', 'sed -i s/a/b/ f', 'sed -n "w out" f',
    'sort -o out a', 'uniq a out', 'node -e "require(\'fs\').writeFileSync(\'x\', 1)"', 'node script.js', 'npm test', 'git diff --output=x',
    'grep foo a | tee out.txt', 'rm src/a.ts', 'mv a b',
  ]) assert.equal(kind(c), 'pass', c);
});

test('redirection hors du projet : refusée (dans un projet), et l’alternative est donnée', () => {
  const v = classifyBash('git log > /tmp/log.txt', sh);
  assert.equal(v.kind, 'deny');
  assert.match(withHint(v.kind === 'deny' ? v.why : '', 'shell'), /lecture seule/);
  assert.equal(kind('git log > /tmp/log.txt', { strictRedirects: false }), 'pass');
  assert.equal(kind('echo x > ~/.bashrc'), 'deny');
});

test('permission demandée : docker, bases, sudo, ssh, réseau, suppression hors du projet, nouveau paquet', () => {
  const asks = (cmd: string) => { const v = classifyBash(cmd, sh); return v.kind === 'ask' ? v.asks.map((a) => a.key) : v.kind; };
  assert.deepEqual(asks('docker compose up -d'), ['docker']);
  assert.deepEqual(asks('docker run --rm alpine'), ['docker']);
  assert.deepEqual(asks('psql -c "select 1"'), ['psql']);
  assert.deepEqual(asks('mysql -e "show tables"'), ['mysql']);
  assert.deepEqual(asks('redis-cli flushall'), ['redis-cli']);
  assert.deepEqual(asks('sudo apt install x'), ['sudo']);
  assert.deepEqual(asks('ssh prod uptime'), ['ssh']);
  assert.deepEqual(asks('scp a prod:/tmp'), ['scp']);
  assert.deepEqual(asks('rsync -a . prod:/srv'), ['rsync']);
  assert.deepEqual(asks('curl -s https://api.github.com/repos'), ['web:api.github.com']);
  assert.deepEqual(asks('wget example.com/x'), ['web:example.com']);
  assert.equal(asks('curl -s http://localhost:3000/health'), 'pass');
  assert.equal(asks('curl -s 127.0.0.1:8080'), 'pass');
  assert.deepEqual(asks('rm -rf /h/autre'), ['rm-dehors']);
  assert.deepEqual(asks('rm -rf ../voisin'), ['rm-dehors']);
  assert.equal(asks('rm -rf build'), 'pass');
  assert.equal(asks('rm /b/Projets/erp/demandes/D-001/brouillon.md'), 'pass');
  assert.deepEqual(asks('npm install left-pad'), ['npm:left-pad']);
  assert.deepEqual(asks('pnpm add -D vitest@2'), ['npm:vitest@2']);
  assert.equal(asks('npm install react'), 'pass');
  assert.equal(asks('npm install'), 'pass');
  // composées : chaque geste compte, une seule fois
  assert.deepEqual(asks('git status && docker ps -a && docker logs x'), ['docker']);
  assert.deepEqual(asks('cd /p/erp && sudo rm -rf /h/x'), ['sudo', 'rm-dehors']);
  // vérifications de santé : lecture seule
  assert.equal(asks('docker compose ps'), 'read');
  assert.equal(asks('redis-cli ping'), 'read');
  assert.equal(asks('pg_isready -h localhost'), 'read');
});

test('git : pousser une autre branche existante ou un tag = permission ; supprimer une branche fusionnée = permission', () => {
  assert.deepEqual(gv('git push origin feature/x'), { why: null, asks: [{ key: 'push:feature/x', label: 'Pousser la branche feature/x' }] });
  assert.equal(gv('git push origin v1.0').asks[0]?.key, 'tag:v1.0');
  assert.equal(gv('git push --tags').asks[0]?.key, 'push-tags');
  assert.equal(gv('git push origin --delete old').asks[0]?.key, 'delete:old');
  assert.equal(gv('git push origin :old').asks[0]?.key, 'delete:old');
  assert.match(gv('git push origin --delete feature/x').why ?? '', /pas fusionnée/);
  assert.match(gv('git push origin nouvelle').why ?? '', /n’existe pas/);
  assert.deepEqual(gv('git push -u origin bureau/d-001'), { why: null, asks: [] });
  assert.deepEqual(gv('git status | head -3 && git push origin feature/x 2>&1 | tail -2').asks.map((a) => a.key), ['push:feature/x']);
});

test('git : toujours refusé (inchangé)', () => {
  for (const c of [
    'git push origin main', 'git push origin dev', 'git push --force origin bureau/d-001', 'git push -f', 'git push origin +feature/x',
    'git push --delete origin main', 'git push origin :dev', 'git reset --hard', 'git rebase dev', 'git commit --amend -m x',
    'git commit --author="X <x@y>" -m x', 'git -c user.name=X commit -m x', 'git branch -D old', 'git push --all',
    'echo ok && git push origin main', 'bash -c "git push --force"',
  ]) assert.ok(gv(c).why, c);
  assert.equal(gv('git push origin dev', { baseOpen: true }).why, null);
});

test('Relecture : les vérifications de santé avant la suite de tests', () => {
  assert.equal(checkReviewBash('pg_isready -h localhost && npm test'), null);
  assert.equal(checkReviewBash('redis-cli ping'), null);
  assert.equal(checkReviewBash('docker compose ps'), null);
  assert.equal(checkReviewBash('curl -s -o /dev/null http://localhost:3000/health'), null);
  assert.ok(checkReviewBash('curl -X POST http://localhost:3000/x'));
  assert.ok(checkReviewBash('curl https://example.com'));
  assert.ok(checkReviewBash('docker compose up'));
  assert.match(withHint('Refusé.', 'review'), /vérification équivalente/);
});
