#!/usr/bin/env node
// Un faux « claude » pour les tests : il parle stream-json comme Claude Code, sans rien dépenser.
//   - chaque séance est un fichier ${CLAUDE_CONFIG_DIR}/projects/fake/<séance>.jsonl (comme Claude Code) ;
//   - --resume <séance> : il relit la séance (et s'en souvient), ou s'arrête en erreur si elle n'existe plus ;
//   - à chaque message, il répond « Reçu : … » et rappelle le premier message de la séance ;
//   - « QUESTION » dans le message : il finit par une question (« Chef, j'ai 1 question… ») ;
//   - « SILENCE » : il ne répond pas (une demande qui travaille encore).
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === '--version') { console.log('2.1.327 (Claude Code)'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent', 'projects', 'fake');

// la petite requête du bureau qui mesure l'énergie : une réponse, et c'est fini
if (opt('--input-format') !== 'stream-json') {
  process.stdin.resume();
  process.stdin.on('end', () => { out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1 }); process.exit(0); });
} else {
  const resume = opt('--resume');
  if (resume && !existsSync(path.join(dir, `${resume}.jsonl`))) {
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    process.exit(1);
  }
  const sid = resume ?? randomUUID();
  const file = path.join(dir, `${sid}.jsonl`);
  mkdirSync(dir, { recursive: true });
  const past = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
  out({ type: 'system', subtype: 'init', session_id: sid, model: opt('--model') ?? 'haiku', apiKeySource: 'none', cwd: process.cwd() });
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type !== 'user') return;
    const text = (m.message?.content ?? []).map((c) => c.text ?? '').join('');
    past.push(text);
    appendFileSync(file, JSON.stringify({ text }) + '\n');
    if (text.includes('SILENCE')) return; // il « travaille » sans fin (pour couper le bureau en pleine demande)
    const reply = `Reçu : ${text.slice(-60)}. Je me souviens de ta première demande : « ${past[0].slice(0, 80)} ».${text.includes('QUESTION') ? ' Chef, j’ai 1 question : 1) A) oui B) non (je te conseille A) ?' : ''}`;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, duration_ms: 5 });
  });
  process.stdin.on('end', () => process.exit(0));
}
