// Max sur Telegram : le bureau envoie ses alertes (planté, questions, pause café, demande terminée…) et lit tes
// réponses (« 1A 2B », « OK », « KO 3 : … ») et tes commandes (/demande, /status, /stop, /aide).
//
// Sécurité : le jeton du bot et ton chat ne quittent jamais ce fichier, rangé sur ton PC hors des projets et des
// missions (~/.config/bureau-des-agents/telegram.json, droits 600). Ils ne sont jamais renvoyés au navigateur,
// jamais écrits dans un journal, jamais transmis à Claude. Le bot n'écoute que ton chat : les autres sont ignorés.
// Un seul lecteur (long polling) ; si le bot est déjà lu ailleurs (erreur 409), on s'arrête proprement.
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TelegramStatus } from '../shared/protocol.ts';

export const TELEGRAM_FILE = process.env.BUREAU_TELEGRAM_FILE ?? path.join(os.homedir(), '.config', 'bureau-des-agents', 'telegram.json');
const API = (process.env.BUREAU_TELEGRAM_API ?? 'https://api.telegram.org').replace(/\/$/, '');

interface Secret { token: string; chatId?: number; botName?: string; tested?: boolean }

/** Le HTML simple de Telegram : on échappe tout ce qui vient de l'équipe. */
export const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type Reply =
  | { kind: 'ok' }
  | { kind: 'ko'; n: number | null; text: string }
  | { kind: 'answers'; list: { n: number; choice: string }[] }
  | { kind: 'command'; name: 'demande' | 'status' | 'stop' | 'aide' | 'start'; arg: string }
  | { kind: 'text'; text: string };

/** Ce que tu as écrit au bot : une réponse à Max, une commande, ou un message libre. */
export function parseReply(raw: string): Reply {
  const t = raw.trim();
  const cmd = /^\/(demande|status|stop|aide|help|start)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t);
  if (cmd) { const n = cmd[1].toLowerCase(); return { kind: 'command', name: (n === 'help' ? 'aide' : n) as 'demande', arg: (cmd[2] ?? '').trim() }; }
  if (/^ok[.!]?$/i.test(t)) return { kind: 'ok' };
  const ko = /^ko\b\s*(\d+)?\s*[:.,-]?\s*([\s\S]*)$/i.exec(t);
  if (ko) return { kind: 'ko', n: ko[1] ? Number(ko[1]) : null, text: ko[2].trim() };
  if (/^(\s*\d+\s*\)?\s*[A-Za-z]\b[\s,;]*)+$/.test(t)) {
    const list = [...t.matchAll(/(\d+)\s*\)?\s*([A-Za-z])\b/g)].map((m) => ({ n: Number(m[1]), choice: m[2].toUpperCase() }));
    return { kind: 'answers', list };
  }
  return { kind: 'text', text: t };
}

/** La réponse telle qu'on la transmet à Max. */
export function replyForMax(r: Reply): string | null {
  switch (r.kind) {
    case 'ok': return 'OK : je suis tes recommandations. (réponse envoyée par Telegram)';
    case 'ko': return `KO${r.n ? ` sur la question ${r.n}` : ''} : ${r.text || 'je ne suis pas d’accord'}. (réponse envoyée par Telegram)`;
    case 'answers': return `Mes réponses : ${r.list.map((a) => `${a.n}) ${a.choice}`).join(', ')}. (réponse envoyée par Telegram)`;
    case 'text': return `${r.text} (message envoyé par Telegram)`;
    default: return null;
  }
}

export interface TelegramHooks {
  /** une réponse ou un message pour Max */
  onMessage: (text: string) => Promise<string | void> | string | void;
  /** /demande <projet> <texte> */
  onDemande: (project: string, text: string) => Promise<string>;
  onStatus: () => string;
  onStop: () => string;
  onStatusChange: (s: TelegramStatus) => void;
  log: (msg: string) => void;
}

export class Telegram {
  private secret: Secret | null = null;
  private polling = false;
  private offset = 0;
  private abort: AbortController | null = null;
  private error = '';
  private hooks: TelegramHooks;
  private file: string;
  private api: string;

  constructor(hooks: TelegramHooks, file = TELEGRAM_FILE, api = API) {
    this.hooks = hooks;
    this.file = file;
    this.api = api;
    try { if (existsSync(file)) this.secret = JSON.parse(readFileSync(file, 'utf8')); } catch { this.secret = null; }
  }

  status(): TelegramStatus {
    const s = this.secret;
    const step = !s ? 'token' : !s.chatId ? 'start' : !s.tested ? 'test' : 'linked';
    return { linked: step === 'linked', step, botName: s?.botName, ...(this.error ? { error: this.error } : {}) };
  }

  /** Démarre la lecture si un bot est enregistré. */
  start() { if (this.secret) void this.poll(); }

  private changed() { this.hooks.onStatusChange(this.status()); }

  private async save() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify(this.secret), { mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  /** Un appel à l'API du bot. Le jeton n'apparaît jamais dans une erreur. */
  private async call(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<{ ok: boolean; status: number; result?: any; description?: string }> {
    const token = this.secret?.token ?? '';
    try {
      const r = await fetch(`${this.api}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
      const j = await r.json().catch(() => ({})) as { ok?: boolean; result?: unknown; description?: string };
      return { ok: !!j.ok, status: r.status, result: j.result, description: String(j.description ?? '').split(token).join('…') };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return { ok: false, status: 0, description: 'arrêt' };
      return { ok: false, status: 0, description: 'Telegram ne répond pas (pas de réseau ?).' };
    }
  }

  /** Étape 2 : le jeton du bot. On le vérifie (getMe) avant de le garder. */
  async setToken(token: string): Promise<void> {
    const t = token.trim();
    if (!/^\d{5,}:[\w-]{20,}$/.test(t)) throw new Error('Ce n’est pas un token de bot (il ressemble à 123456789:ABC-…).');
    this.stop();
    const prev = this.secret;
    this.secret = { token: t };
    const me = await this.call('getMe');
    if (!me.ok) { this.secret = prev; throw new Error(me.status === 401 ? 'Telegram refuse ce token : vérifie-le dans @BotFather.' : `Telegram : ${me.description || 'erreur'}`); }
    this.secret.botName = me.result?.username ? `@${me.result.username}` : undefined;
    this.error = '';
    await this.save();
    this.changed();
    void this.poll();
  }

  /** Étape 4 : le message de test. */
  async test(): Promise<void> {
    if (!this.secret?.chatId) throw new Error('Envoie d’abord /start à ton bot.');
    const r = await this.send('✅ <b>Max est relié au Bureau des agents.</b>\nJe t’écrirai ici quand l’équipe aura besoin de toi. Tape /aide pour voir ce que je sais faire.');
    if (!r) throw new Error('Le message de test n’est pas parti.');
    this.secret.tested = true;
    await this.save();
    this.changed();
  }

  async unlink() {
    this.stop();
    this.secret = null;
    this.error = '';
    await rm(this.file, { force: true });
    this.changed();
  }

  stop() {
    this.polling = false;
    this.abort?.abort();
    this.abort = null;
  }

  /** Envoie un message (HTML simple) à ton chat. */
  async send(text: string): Promise<boolean> {
    if (!this.secret?.chatId) return false;
    const r = await this.call('sendMessage', { chat_id: this.secret.chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true });
    return r.ok;
  }

  /** La boucle de lecture (long polling), un seul lecteur. */
  private async poll() {
    if (this.polling || !this.secret) return;
    this.polling = true;
    while (this.polling && this.secret) {
      this.abort = new AbortController();
      const r = await this.call('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] }, this.abort.signal);
      if (!this.polling) break;
      if (r.status === 409) {
        this.error = 'Ce bot est utilisé par un autre programme. Arrête l’autre programme (ou crée un nouveau bot), puis relie-le à nouveau.';
        this.hooks.log('Telegram : le bot est déjà lu par un autre programme (409), lecture arrêtée.');
        this.polling = false;
        this.changed();
        break;
      }
      if (r.status === 401) { this.error = 'Telegram refuse le token : relie le bot à nouveau.'; this.polling = false; this.changed(); break; }
      if (!r.ok) { await new Promise((res) => setTimeout(res, 5000)); continue; }
      for (const u of (r.result ?? []) as any[]) {
        this.offset = Math.max(this.offset, Number(u.update_id) + 1);
        await this.onUpdate(u).catch(() => {});
      }
    }
  }

  private async onUpdate(u: any) {
    const msg = u.message;
    if (!msg?.chat?.id || typeof msg.text !== 'string') return;
    const s = this.secret!;
    const chat = Number(msg.chat.id);
    // étape 3 : le premier /start, depuis une conversation privée, désigne ton chat
    if (!s.chatId) {
      if (msg.chat.type === 'private' && /^\/start\b/.test(msg.text)) {
        s.chatId = chat;
        await this.save();
        this.changed();
        await this.send('👋 C’est noté. Reviens dans le bureau pour envoyer le message de test.');
      }
      return;
    }
    if (chat !== s.chatId) { this.hooks.log('Telegram : message ignoré (il vient d’un autre chat que le tien).'); return; }
    const r = parseReply(msg.text);
    let answer: string | void = '';
    if (r.kind === 'command') {
      if (r.name === 'aide' || r.name === 'start') answer = AIDE;
      else if (r.name === 'status') answer = this.hooks.onStatus();
      else if (r.name === 'stop') answer = this.hooks.onStop();
      else {
        const [project, ...rest] = r.arg.split(/\s+/);
        answer = !project || !rest.length ? 'Écris : /demande &lt;projet&gt; &lt;ce que tu veux&gt;' : await this.hooks.onDemande(project, rest.join(' ')).catch((e) => html(e instanceof Error ? e.message : String(e)));
      }
    } else {
      const text = replyForMax(r);
      if (text) answer = await Promise.resolve(this.hooks.onMessage(text)).catch((e) => html(e instanceof Error ? e.message : String(e)));
    }
    if (answer) await this.send(answer);
  }
}

const AIDE = `<b>Ce que je sais faire</b>
/demande &lt;projet&gt; &lt;texte&gt; : une nouvelle demande (ajoutée au carnet, lancée si le projet est libre)
/status : où en est l'équipe
/stop : tout arrêter
Pour répondre à mes questions : <code>1A 2B</code>, <code>OK</code> (je suis mes conseils) ou <code>KO 3 : …</code>`;
