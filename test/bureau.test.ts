// Le bureau de bout en bout, avec un faux « claude » (test/fake/claude.mjs) : rien n'est dépensé.
// Reprendre une mission, séance effacée, dossiers des demandes d'un projet, état Interrompu, enchaînement,
// réponses Telegram, permissions demandées par le hook.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { OfficeEvent, ServerMsg } from '../shared/protocol.ts';

const root = mkdtempSync(path.join(os.tmpdir(), 'bureau-test-'));
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
const { Bureau } = await import('../server/bureau.ts');
const fake = { path: path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake', 'claude.mjs'), version: '2.1.327' };
const opened: InstanceType<typeof Bureau>[] = [];
after(() => { for (const b of opened) b.shutdown(); rmSync(root, { recursive: true, force: true }); });

async function until(ok: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function office(name: string) {
  const msgs: ServerMsg[] = [];
  const b = new Bureau(fake, (m) => msgs.push(m), path.join(root, name));
  const alerts: string[] = [];
  b.onNotify = (_k, text) => alerts.push(text);
  await b.init();
  opened.push(b);
  const evs = () => msgs.filter((m): m is Extract<ServerMsg, { t: 'ev' }> => m.t === 'ev').map((m) => m.ev);
  return { b, msgs, alerts, evs };
}

function repo(name: string) {
  const dir = path.join(root, 'depots', name);
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  g('add', '.');
  g('commit', '-q', '-m', 'départ');
  return dir;
}

const done = (b: InstanceType<typeof Bureau>) => () => b.current?.mission.status === 'done';

test('Reprendre : la même séance revient, et Max se souvient de la demande', async () => {
  const { b, msgs } = await office('reprise');
  await b.start('Écris un poème sur les chats');
  await until(done(b));
  const m = b.current!.mission;
  assert.ok(m.sessionId);
  b.close();
  assert.equal(b.current?.mission.id, undefined);
  assert.equal(await b.resume(m.id), true);
  assert.equal(b.current?.mission.id, m.id);
  assert.ok(msgs.some((x) => x.t === 'hello' && x.current?.mission.id === m.id), 'le navigateur reçoit la mission reprise');
  b.say('Tu te souviens de ma demande ?');
  await until(() => b.current?.mission.status === 'done' && /souviens de ta première demande : « Écris un poème sur les chats »/.test(b.current.mission.final ?? '') && /Tu te souviens/.test(b.current.mission.final ?? ''));
  assert.equal(b.current?.mission.sessionId, m.sessionId, 'même séance');

  // la séance n'existe plus : le bureau le dit et propose une nouvelle demande avec le contexte
  b.close();
  unlinkSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'fake', `${m.sessionId}.jsonl`));
  assert.equal(await b.resume(m.id), false);
  const failed = msgs.find((x) => x.t === 'resume_failed');
  assert.ok(failed && failed.t === 'resume_failed' && failed.missionId === m.id);
  await b.start('Continue le poème', { contextFrom: m.id });
  await until(done(b));
  assert.match(b.current!.mission.final ?? '', /prend la suite de « Écris un poème sur les chats »/);
  assert.equal(b.current!.mission.contextFrom, m.id);
});

test('Projet : les demandes sont rangées dans Projets/<projet>/demandes/, et la suivante lit la précédente', async () => {
  const { b } = await office('projet');
  const dir = repo('erp');
  await b.addProject(dir);
  const p = (await b.projectList())[0];
  await b.updateProject(p.id, { chain: false });
  await b.start('Analyse le module factures', { projectId: p.id });
  await until(done(b));
  const first = b.current!.mission;
  const home = path.join(b.dir, 'Projets', 'erp', 'demandes');
  assert.equal(path.dirname(first.folder), home);
  assert.match(path.basename(first.folder), /^D-001 · Analyse le module factures$/);
  assert.equal(first.requestId, 'D-001');
  writeFileSync(path.join(first.folder, 'rapport.md'), 'Fait : analyse.\nDécision demandée : aucune.\n');
  // un rendu interne n'est pas montré comme un rendu
  mkdirSync(path.join(first.folder, 'interne'), { recursive: true });
  writeFileSync(path.join(first.folder, 'interne', 'revue.md'), 'OK');
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(first.files.some((f) => f.name === 'rapport.md'));
  assert.ok(!first.files.some((f) => f.path.startsWith('interne')));
  await b.start('Ajoute un export CSV', { projectId: p.id });
  const second = b.current!;
  assert.match(path.basename(second.mission.folder), /^D-002 /);
  assert.equal(second.brief?.lastRequest?.folder, 'D-001 · Analyse le module factures');
  assert.match(second.brief?.lastRequest?.report ?? '', /Fait : analyse/);
  await until(done(b));
  const carnet = await b.carnet(p.id);
  assert.equal(carnet.missions['D-001']?.missionId, first.id);
  // les missions sans projet gardent le dossier Missions/
  b.close();
  await b.start('Une liste de courses');
  assert.equal(path.dirname(b.current!.mission.folder), b.missionsDir);
  await until(done(b));
});

test('Enchaîner les demandes : la suivante du carnet démarre seule (et pas si c’est désactivé)', async () => {
  const { b, alerts } = await office('chaine');
  await b.addProject(repo('chaine'));
  const p = (await b.projectList())[0];
  assert.notEqual(p.chain, false, 'activé par défaut');
  await b.carnetAdd(b.project(p.id)!, 'Deuxième demande du carnet', 'la première');
  await b.start('Première demande', { projectId: p.id });
  await until(() => b.current?.mission.prompt === 'Deuxième demande du carnet', 10000);
  assert.ok(alerts.some((a) => /^Je passe à D-001 : Deuxième demande du carnet/.test(a)), alerts.join(' | '));
  assert.equal(b.current?.mission.requestId, 'D-001');
  await until(done(b));
  // une question en attente : on n'enchaîne pas ; désactivé : on attend « Lancer »
  await b.carnetAdd(b.project(p.id)!, 'Troisième', 'x');
  await b.start('Une demande avec QUESTION', { projectId: p.id });
  await until(done(b));
  await new Promise((r) => setTimeout(r, 2000));
  assert.match(b.current!.mission.prompt, /QUESTION/);
  await b.updateProject(p.id, { chain: false });
  await b.start('Encore une', { projectId: p.id });
  await until(done(b));
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(b.current!.mission.prompt, 'Encore une');
});

test('Telegram : la réponse va à la mission qui a posé la question, même terminée', async () => {
  const { b } = await office('telegram');
  await b.start('Prépare un menu QUESTION');
  await until(done(b));
  const asker = b.current!.mission;
  b.close();
  await b.start('Autre chose sans question');
  await until(done(b));
  const r = await b.replyFromTelegram('Mes réponses : 1) A. (réponse envoyée par Telegram)', true);
  assert.match(r, /Transmis à Max/);
  assert.equal(b.current?.mission.id, asker.id);
  await until(() => b.current?.mission.status === 'done' && /Mes réponses/.test(b.current.mission.final ?? ''));
  assert.match(b.current!.mission.final ?? '', /première demande : « Prépare un menu QUESTION »/);
});

test('Hook : lecture seule permise, permission demandée (une fois / pour la demande / non), refus expliqué', async () => {
  const { b, evs, alerts } = await office('hook');
  await b.addProject(repo('hook'));
  const p = (await b.projectList())[0];
  await b.updateProject(p.id, { chain: false });
  await b.start('SILENCE', { projectId: p.id });
  await until(() => !!b.current?.live?.norm.started);
  const hook = (command: string) => b.onHook({ tool_name: 'Bash', tool_input: { command } });
  const read = await hook('git status && git log --oneline | head -3');
  assert.equal(read.exit, 0);
  assert.match(read.stdout ?? '', /"permissionDecision":"allow"/);
  // une permission : la main levée, la commande exacte, et la question sur Telegram
  const pending = hook('docker compose up -d');
  await until(() => evs().some((e) => e.k === 'ask' && e.scoped === true));
  const ask = evs().find((e): e is Extract<OfficeEvent, { k: 'ask' }> => e.k === 'ask')!;
  assert.equal(ask.detail, 'docker compose up -d');
  assert.ok(alerts.some((a) => /demande la permission/.test(a) && /docker compose up -d/.test(a)));
  b.answer(ask.requestId, true, 'request');
  assert.equal((await pending).exit, 0);
  // « Oui pour cette demande » : plus de question pour docker
  assert.equal((await hook('docker compose logs')).exit, 0);
  // « Non » par Telegram
  const pending2 = hook('ssh prod uptime');
  await until(() => b.hasPermissionAsk());
  assert.match(b.answerLatestPermission('no'), /Refusé/);
  const no = await pending2;
  assert.equal(no.exit, 2);
  assert.match(no.stderr ?? '', /ne réessaie pas/);
  // toujours refusé, avec l'alternative
  const force = await hook('git push --force origin main');
  assert.equal(force.exit, 2);
  assert.match(force.stderr ?? '', /lecture seule/);
  b.stop();
});

test('Au redémarrage : les agents d’une demande coupée passent à « Interrompu »', async () => {
  const first = await office('coupure');
  await first.b.start('SILENCE pendant que le bureau est coupé');
  await until(() => !!first.b.current?.live?.norm.started);
  const id = first.b.current!.mission.id;
  await new Promise((r) => setTimeout(r, 300));
  first.b.shutdown();
  opened.splice(opened.indexOf(first.b), 1);
  const second = await office('coupure');
  const log = await second.b.history.agentLog(id, 'chef');
  assert.equal(log.entry?.status, 'interrupted');
  assert.equal(log.lines[0]?.detail, 'interrompu (bureau redémarré)');
  const rec = readFileSync(path.join(second.b.dir, '.bureau', 'missions', `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rec.at(-1).ev, { k: 'state', who: 'chef', state: 'interrupted', reason: 'interrompu (bureau redémarré)' });
  // une seule fois : un deuxième redémarrage n'ajoute rien
  second.b.shutdown();
  opened.splice(opened.indexOf(second.b), 1);
  const third = await office('coupure');
  const again = await third.b.history.agentLog(id, 'chef');
  assert.equal(again.lines.filter((l) => /interrompu/.test(l.detail)).length, 1);
  assert.ok(existsSync(path.join(third.b.dir, '.bureau')));
  assert.ok(readdirSync(path.join(third.b.dir, '.bureau', 'historique')).length > 0);
});
