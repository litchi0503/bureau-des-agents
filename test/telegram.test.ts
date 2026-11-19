// Telegram, contre un faux serveur Telegram local : relier le bot, rejeter un autre chat, lire les réponses.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseReply, replyForMax, Telegram } from '../server/telegram.ts';
import type { TelegramStatus } from '../shared/protocol.ts';

const TOKEN = '123456789:AAFAKE-token-pour-les-tests_xyz';

test('lecture des réponses : 1A 2B, OK, KO 3 : …, commandes', () => {
  assert.deepEqual(parseReply('1A 2B'), { kind: 'answers', list: [{ n: 1, choice: 'A' }, { n: 2, choice: 'B' }] });
  assert.deepEqual(parseReply('1) a, 2) c'), { kind: 'answers', list: [{ n: 1, choice: 'A' }, { n: 2, choice: 'C' }] });
  assert.deepEqual(parseReply('OK'), { kind: 'ok' });
  assert.deepEqual(parseReply('ko 3 : plutôt une liste déroulante'), { kind: 'ko', n: 3, text: 'plutôt une liste déroulante' });
  assert.deepEqual(parseReply('KO : non'), { kind: 'ko', n: null, text: 'non' });
  assert.deepEqual(parseReply('/demande erp ajoute un export'), { kind: 'command', name: 'demande', arg: 'erp ajoute un export' });
  assert.deepEqual(parseReply('/status@MonBot'), { kind: 'command', name: 'status', arg: '' });
  assert.equal(parseReply('Okay pour moi').kind, 'text');
  assert.match(replyForMax(parseReply('1A 2B'))!, /1\) A, 2\) B/);
});

/** Un faux Telegram : getMe, getUpdates (une file de messages), sendMessage (enregistré). */
function fake(opts: { conflict?: boolean } = {}) {
  const sent: { chat_id: number; text: string }[] = [];
  const queue: unknown[] = [];
  let id = 1;
  const waiting: ((v: unknown[]) => void)[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const reply = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!m || m[1] !== TOKEN) return reply(401, { ok: false, description: 'Unauthorized' });
    if (m[2] === 'getMe') return reply(200, { ok: true, result: { id: 1, is_bot: true, username: 'BureauTestBot' } });
    if (m[2] === 'sendMessage') { sent.push({ chat_id: j.chat_id, text: j.text }); return reply(200, { ok: true, result: {} }); }
    if (m[2] === 'getUpdates') {
      if (opts.conflict) return reply(409, { ok: false, description: 'Conflict: terminated by other getUpdates request' });
      const take = () => queue.splice(0).filter((u) => (u as { update_id: number }).update_id >= (j.offset ?? 0));
      const now = take();
      if (now.length) return reply(200, { ok: true, result: now });
      const t = setTimeout(() => reply(200, { ok: true, result: take() }), 300);
      waiting.push(() => { clearTimeout(t); reply(200, { ok: true, result: take() }); });
      return;
    }
    reply(404, { ok: false });
  });
  const push = (chat: number, text: string, type = 'private') => { queue.push({ update_id: id++, message: { chat: { id: chat, type }, text } }); waiting.splice(0).forEach((w) => w([])); };
  return new Promise<{ url: string; sent: typeof sent; push: typeof push; close: () => void }>((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${a.port}`, sent, push, close: () => server.close() });
  }));
}

const until = async (ok: () => boolean, ms = 4000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) throw new Error('trop long'); await new Promise((r) => setTimeout(r, 30)); } };

test('relier le bot, ne répondre qu’à mon chat, transmettre les réponses à Max', async () => {
  const tg = await fake();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bureau-test-tg-'));
  const file = path.join(dir, 'telegram.json');
  const toMax: string[] = [];
  const logs: string[] = [];
  let status: TelegramStatus | null = null;
  const bot = new Telegram({
    onMessage: (t) => { toMax.push(t); return 'Transmis à Max'; },
    onDemande: async (p, t) => `demande ${p} : ${t}`,
    onStatus: () => 'statut', onStop: () => 'arrêt',
    onStatusChange: (s) => { status = s; }, log: (m) => logs.push(m),
  }, file, tg.url);
  try {
    await assert.rejects(bot.setToken('pas-un-token'));
    await bot.setToken(TOKEN);
    assert.equal(bot.status().step, 'start');
    assert.equal(bot.status().botName, '@BureauTestBot');
    // le jeton : seulement dans le fichier (600), jamais dans l'état envoyé au navigateur
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(readFileSync(file, 'utf8').includes(TOKEN));
    assert.ok(!JSON.stringify(bot.status()).includes(TOKEN));
    // étape 3 : /start désigne mon chat
    tg.push(4242, '/start');
    await until(() => bot.status().step === 'test');
    await bot.test();
    assert.equal(bot.status().linked, true);
    assert.equal((status as TelegramStatus | null)?.linked, true);
    // un autre chat est ignoré (et noté sans son contenu)
    tg.push(999, '1A 2B secret');
    tg.push(4242, '1A 2B');
    tg.push(4242, 'KO 3 : pas comme ça');
    tg.push(4242, '/demande erp ajoute un export');
    await until(() => toMax.length === 2 && tg.sent.some((s) => s.text.startsWith('demande')));
    assert.match(toMax[0], /1\) A, 2\) B/);
    assert.match(toMax[1], /question 3 : pas comme ça/);
    assert.ok(logs.some((l) => /autre chat/.test(l)) && !logs.some((l) => l.includes('secret')));
    assert.ok(tg.sent.every((s) => s.chat_id === 4242));
    assert.ok(tg.sent.some((s) => s.text === 'demande erp : ajoute un export'));
    await bot.unlink();
    assert.equal(bot.status().step, 'token');
  } finally { bot.stop(); tg.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('bot déjà lu ailleurs (409) : message clair et arrêt propre', async () => {
  const tg = await fake({ conflict: true });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bureau-test-tg-'));
  const bot = new Telegram({ onMessage: () => '', onDemande: async () => '', onStatus: () => '', onStop: () => '', onStatusChange: () => {}, log: () => {} }, path.join(dir, 't.json'), tg.url);
  try {
    await bot.setToken(TOKEN);
    await until(() => !!bot.status().error);
    assert.match(bot.status().error ?? '', /utilisé par un autre programme/);
  } finally { bot.stop(); tg.close(); rmSync(dir, { recursive: true, force: true }); }
});
