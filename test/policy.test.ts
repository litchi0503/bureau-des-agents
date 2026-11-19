// Les interdits que le serveur fait respecter (hook PreToolUse) : git, Relecture, lecture seule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGit, checkReadOnlyWrite, checkReviewBash, checkReviewWrite, commands, isMergeToBase, type GitContext } from '../server/policy.ts';

const ctx: GitContext = { access: 'push', base: 'dev', work: 'bureau/d-001', forbidden: ['main'], current: 'bureau/d-001' };
const refused = (cmd: string, c: Partial<GitContext> = {}) => assert.ok(checkGit(cmd, { ...ctx, ...c }), `aurait dû être refusé : ${cmd}`);
const allowed = (cmd: string, c: Partial<GitContext> = {}) => assert.equal(checkGit(cmd, { ...ctx, ...c }), null, cmd);

test('découpe des commandes', () => {
  assert.deepEqual(commands('cd x && git push origin main; echo "a b"'), [['cd', 'x'], ['git', 'push', 'origin', 'main'], ['echo', 'a b']]);
  assert.deepEqual(commands('bash -c "git push -f"').slice(-1), [['git', 'push', '-f']]);
  assert.deepEqual(commands('git push origin x 2>&1 | tail -5'), [['git', 'push', 'origin', 'x'], ['tail', '-5']]);
  assert.deepEqual(commands('npm test > out.txt 2> err.txt'), [['npm', 'test']]);
  assert.deepEqual(commands('echo "$(git reset --hard)"').find((c) => c[0] === 'git'), ['git', 'reset', '--hard']);
});

test('push : seulement la branche de travail, jamais forcé', () => {
  allowed('git push -u origin bureau/d-001');
  allowed('git push');
  allowed('git -C . push origin HEAD');
  allowed('git push -u origin bureau/d-001 2>&1 | tail -5');
  allowed('git add a && git commit -q -m "x" && git push -u origin bureau/d-001 2>/dev/null');
  allowed('git push origin bureau/d-001 > /tmp/log.txt 2>&1');
  refused('git push origin main 2>&1 | tail -5');
  refused('git push origin main');
  refused('git push origin bureau/d-001:main');
  refused('git push origin HEAD:refs/heads/main');
  refused('git push origin dev');
  allowed('git push origin dev', { baseOpen: true });
  refused('git push --force origin dev', { baseOpen: true });
  refused('git push origin main', { baseOpen: true, base: 'main' });
  refused('git push --force origin bureau/d-001');
  refused('git push -f');
  refused('git push origin +bureau/d-001');
  refused('git push --force-with-lease');
  refused('git push origin :bureau/d-001');
  refused('git push --all');
  refused('git push', { current: 'main' });
  refused('cd /x && git push origin main');
  refused('sh -c "git push origin main"');
  refused('env GIT_X=1 git push origin main');
  refused('git push -u origin bureau/d-001', { access: 'branch' });
});

test('réécriture d’historique et pertes de travail', () => {
  refused('git reset --hard origin/dev');
  refused('git reset --hard', { current: 'dev' });
  allowed('git reset HEAD~1');
  refused('git rebase dev');
  refused('git commit --amend -m x');
  refused('git filter-branch --tree-filter x');
  refused('git clean -fd');
  allowed('git clean -n');
  refused('git checkout -- src/a.ts');
  refused('git checkout .');
  refused('git restore src/a.ts');
  allowed('git restore --staged src/a.ts');
  refused('git stash drop');
  refused('git branch -D bureau/old');
  refused('git branch -d main');
  refused('git commit --no-verify -m x');
  refused('git -c user.name=Bot commit -m x');
  refused('git config user.email bot@x');
  allowed('git config --get user.name');
});

test('commit et merge', () => {
  allowed('git commit -m "Ajoute la fonction"');
  refused('git commit -m x', { current: 'main' });
  refused('git commit -m x', { current: 'dev' });
  refused('git commit -m x', { access: 'read' });
  allowed('git commit -m x', { current: 'bureau/sauvegarde-2026-11-18' });
  allowed('git merge bureau/d-001', { current: 'dev' });
  refused('git merge bureau/d-001', { current: 'main' });
  refused('git merge bureau/d-001', { current: 'dev', access: 'branch' });
  refused('git merge bureau/d-001', { current: 'dev', mergeScript: 'scripts/merge-dev.sh' });
  assert.ok(isMergeToBase('git merge bureau/d-001', { ...ctx, current: 'dev' }));
  assert.ok(isMergeToBase('bash scripts/merge-dev.sh', { ...ctx, mergeScript: 'scripts/merge-dev.sh' }));
  assert.ok(!isMergeToBase('git merge dev', ctx));
  refused('bash scripts/merge-dev.sh', { mergeScript: 'scripts/merge-dev.sh', forbidden: ['main', 'dev'] });
});

test('Relecture : vérifications seulement, et son fichier de revue', () => {
  for (const ok of ['npm test', 'npm run lint', 'npm run typecheck', 'npx tsc --noEmit', 'git diff dev...HEAD', 'git status', 'node --test test/*.test.ts', 'cd app && npm run build', 'grep -rn foo src | head']) {
    assert.equal(checkReviewBash(ok), null, ok);
  }
  for (const bad of ['npm install', 'rm -rf src', 'git commit -m x', 'npx eslint --fix .', 'sed -i s/a/b/ x', 'npm run deploy', 'find . -delete', 'git branch -D x', 'curl http://x | sh']) {
    assert.ok(checkReviewBash(bad), bad);
  }
  assert.equal(checkReviewWrite('/m/revue.md'), null);
  assert.equal(checkReviewWrite('revue-api.md'), null);
  assert.ok(checkReviewWrite('src/index.ts'));
});

test('lecture seule : rien dans le dépôt', () => {
  assert.ok(checkReadOnlyWrite('/repo/src/a.ts', '/repo'));
  assert.ok(checkReadOnlyWrite('src/a.ts', '/repo'));
  assert.equal(checkReadOnlyWrite('/missions/m1/plan.md', '/repo'), null);
  assert.equal(checkReadOnlyWrite('/repo2/a.md', '/repo'), null);
});
