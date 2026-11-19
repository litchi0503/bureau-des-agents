// L'historique des agents, sur le disque, dans le dossier du bureau :
//   .bureau/historique/<demande>/<agent>.jsonl   une ligne par fait (heure, type, détail, modèle)
//   .bureau/historique/index.jsonl               une ligne par passage d'agent (mise à jour à chaque étape)
// La fenêtre 👥 cherche dans l'index et ne reçoit qu'une page à la fois. Les anciennes missions (avant
// l'historique) sont reprises depuis leur enregistrement. Les vieux historiques sont purgés au démarrage.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cut, normRole, ROLES } from '../shared/activity.ts';
import { effortLabel, modelLabel } from '../shared/settings.ts';
import type { HistEntry, HistLine, Logged, MissionInfo, OfficeEvent } from '../shared/protocol.ts';

const STATE_TEXT: Record<string, string> = {
  working: 'Travaille', waiting: 'Attend ta réponse', queued: 'Attend une place', pause: 'Pause café', blocked: 'Bloqué', crashed: 'Planté', done: 'Terminé', interrupted: 'Interrompu',
};

/** Ce qu'un événement ajoute à l'historique de chaque agent concerné (fonction pure). */
export function linesOf(ev: OfficeEvent, at: number, model: (who: string) => string | undefined): { who: string; line: HistLine }[] {
  const L = (who: string, type: HistLine['type'], detail: string) => ({ who, line: { at, type, detail: cut(detail, 400), ...(model(who) ? { model: model(who) } : {}) } });
  switch (ev.k) {
    case 'start': return [L('chef', 'mission', `Ta demande : ${ev.text}`)];
    case 'hire': return [L(ev.id, 'mission', `Reçoit sa mission de Max : ${ev.task}`), L('chef', 'action', `Appelle ${ev.name} (${ROLES[normRole(ev.role)].label}) : ${ev.task}`)];
    case 'act': return [L(ev.who, 'action', ev.detail && ev.detail !== ev.label ? `${ev.label} · ${ev.detail}` : ev.label)];
    case 'act_done': return ev.ok ? [] : [L(ev.who, 'erreur', 'Une action a échoué')];
    case 'report': return [L(ev.who, 'rapport', `Rend son rapport : ${ev.text}`)];
    case 'leave': return [L(ev.who, 'état', ev.ok ? 'Terminé : a rendu son travail' : 'Planté : n’a pas pu finir')];
    case 'state': return [L(ev.who, ev.state === 'crashed' ? 'erreur' : 'état', `${STATE_TEXT[ev.state] ?? ev.state}${ev.reason ? ` : ${ev.reason}` : ''}`)];
    case 'model': {
      const eff = effortLabel(ev.effort).toLowerCase();
      return [L(ev.who, 'modèle', ev.from ? `Bascule ${modelLabel(ev.from)} → ${modelLabel(ev.model)}${ev.reason ? ` (${ev.reason})` : ''} · puissance ${eff}` : `Modèle ${modelLabel(ev.model)} · puissance ${eff}`)];
    }
    case 'note': return [L(ev.who, ev.level === 'error' ? 'erreur' : 'note', ev.text)];
    case 'ask': return [L(ev.who, 'état', `Attend ta réponse : ${ev.label}`)];
    case 'ask_done': return [];
    case 'say': return ev.who === 'chef' ? [L('chef', 'message', ev.text)] : [];
    case 'error': return [L('chef', 'erreur', ev.message)];
    case 'end': return [L('chef', 'état', ev.ok ? 'Demande terminée' : ev.stopped ? 'Demande arrêtée' : 'Demande terminée en erreur')];
    case 'file': return [L(ev.file.by || 'chef', 'action', `${ev.isNew ? 'Range' : 'Met à jour'} ${ev.file.name}`)];
    default: return [];
  }
}

/** Met à jour le passage d'un agent (index) avec un événement. */
export function updateEntry(e: HistEntry, ev: OfficeEvent, at: number) {
  if (ev.k === 'report' && ev.who === e.id) e.report = cut(ev.text, 600);
  if (ev.k === 'leave' && ev.who === e.id) { e.status = ev.ok ? 'done' : 'crashed'; e.endAt = at; if (ev.tokens) e.tokens = ev.tokens; e.ms = ev.ms || at - e.at; }
  if (ev.k === 'state' && ev.who === e.id && ev.state === 'crashed') e.status = 'crashed';
  if (ev.k === 'model' && ev.who === e.id) { e.model = ev.model; e.effort = ev.effort; if (ev.from) e.switched = `${ev.from} → ${ev.model}`; }
}

const safe = (s: string) => s.replace(/[^\w-]/g, '').slice(0, 80) || 'x';

export class History {
  private root: string;
  private indexFile: string;
  /** l'index en mémoire (clé : demande|agent) */
  private entries = new Map<string, HistEntry>();

  constructor(bureauDir: string) {
    this.root = path.join(bureauDir, '.bureau', 'historique');
    this.indexFile = path.join(this.root, 'index.jsonl');
  }

  async init(keepMonths: number, missions: MissionInfo[], recDir: string) {
    await mkdir(this.root, { recursive: true });
    const raw = await readFile(this.indexFile, 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line) as HistEntry; this.entries.set(`${e.missionId}|${e.id}`, e); } catch { /* ligne abîmée */ }
    }
    await this.purge(keepMonths);
    // les missions d'avant l'historique : on le reconstruit depuis leur enregistrement
    const known = new Set([...this.entries.values()].map((e) => e.missionId));
    for (const m of missions) {
      if (known.has(m.id) || existsSync(path.join(this.root, safe(m.id)))) continue;
      const rec = await readFile(path.join(recDir, `${m.id}.jsonl`), 'utf8').catch(() => '');
      if (!rec) continue;
      const log: Logged[] = [];
      for (const line of rec.split('\n')) { if (line.trim()) { try { log.push(JSON.parse(line)); } catch { /* */ } } }
      for (const l of log) await this.add(m, l.ev, l.at, () => undefined);
    }
    await this.compact();
  }

  /** Range un événement de la demande dans l'historique de chaque agent concerné. */
  async add(m: MissionInfo, ev: OfficeEvent, at: number, model: (who: string) => string | undefined) {
    if (ev.k === 'typing' || ev.k === 'think' || ev.k === 'plan' || ev.k === 'init') return;
    if (ev.k === 'hire') {
      this.entries.set(`${m.id}|${ev.id}`, {
        missionId: m.id, missionTitle: m.title, projectId: m.projectId, id: ev.id, name: ev.name, role: normRole(ev.role), task: ev.task,
        prompt: cut(ev.prompt, 2000), at, status: 'working',
      });
    }
    if (!this.entries.has(`${m.id}|chef`) && (ev.k === 'start' || (ev.k === 'model' && ev.who === 'chef'))) {
      this.entries.set(`${m.id}|chef`, { missionId: m.id, missionTitle: m.title, projectId: m.projectId, id: 'chef', name: 'Max', role: 'chef', task: m.title, prompt: cut(m.prompt, 2000), at, status: 'working' });
    }
    const touched = new Set<string>();
    for (const e of this.entries.values()) {
      if (e.missionId !== m.id) continue;
      const before = JSON.stringify(e);
      updateEntry(e, ev, at);
      if (e.id === 'chef' && ev.k === 'end') { e.status = ev.ok ? 'done' : ev.stopped ? 'done' : 'crashed'; e.endAt = at; e.ms = at - e.at; }
      if (JSON.stringify(e) !== before || ev.k === 'hire') touched.add(e.id);
    }
    const lines = linesOf(ev, at, model);
    const dir = path.join(this.root, safe(m.id));
    if (lines.length) await mkdir(dir, { recursive: true });
    for (const { who, line } of lines) await appendFile(path.join(dir, `${safe(who)}.jsonl`), JSON.stringify(line) + '\n').catch(() => {});
    for (const id of touched) await appendFile(this.indexFile, JSON.stringify(this.entries.get(`${m.id}|${id}`)) + '\n').catch(() => {});
  }

  /**
   * Au démarrage du bureau : tout passage encore « en cours » vient d'une demande coupée (bureau arrêté).
   * Il passe à « interrompu », et son journal reçoit une ligne de plus (les anciennes lignes ne sont pas réécrites).
   */
  async interruptStale(at = Date.now()): Promise<{ missionId: string; id: string }[]> {
    const out: { missionId: string; id: string }[] = [];
    for (const e of this.entries.values()) {
      if (e.status !== 'working') continue;
      e.status = 'interrupted';
      e.endAt = at;
      out.push({ missionId: e.missionId, id: e.id });
      const dir = path.join(this.root, safe(e.missionId));
      await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, `${safe(e.id)}.jsonl`), JSON.stringify({ at, type: 'état', detail: 'interrompu (bureau redémarré)' } satisfies HistLine) + '\n').catch(() => {});
    }
    if (out.length) await this.compact();
    return out;
  }

  /** Le journal d'un agent (le plus récent d'abord). */
  async agentLog(missionId: string, who: string): Promise<{ entry: HistEntry | null; lines: HistLine[] }> {
    const raw = await readFile(path.join(this.root, safe(missionId), `${safe(who)}.jsonl`), 'utf8').catch(() => '');
    const lines: HistLine[] = [];
    for (const l of raw.split('\n')) { if (l.trim()) { try { lines.push(JSON.parse(l)); } catch { /* */ } } }
    return { entry: this.entries.get(`${missionId}|${who}`) ?? null, lines: lines.reverse().slice(0, 2000) };
  }

  /** Une page de l'historique de l'équipe (toutes demandes confondues), avec une recherche. */
  search(q: string, page: number, size = 25): { total: number; entries: HistEntry[] } {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = [...this.entries.values()]
      .filter((e) => !words.length || words.every((w) => `${e.name} ${ROLES[e.role]?.label ?? ''} ${e.task} ${e.missionTitle} ${e.model ?? ''} ${e.status === 'crashed' ? 'planté' : ''}`.toLowerCase().includes(w)))
      .sort((a, b) => b.at - a.at);
    const p = Math.max(0, page);
    return { total: all.length, entries: all.slice(p * size, p * size + size) };
  }

  /** Purge au démarrage : l'historique plus vieux que la durée réglée (0 = on garde tout). */
  async purge(keepMonths: number) {
    if (!keepMonths) return;
    const limit = Date.now() - keepMonths * 30.44 * 86_400_000;
    const old = new Set<string>();
    for (const e of this.entries.values()) if ((e.endAt ?? e.at) < limit) old.add(e.missionId);
    for (const e of this.entries.values()) if (old.has(e.missionId) && (e.endAt ?? e.at) >= limit) old.delete(e.missionId);
    for (const id of old) {
      await rm(path.join(this.root, safe(id)), { recursive: true, force: true });
      for (const k of [...this.entries.keys()]) if (k.startsWith(`${id}|`)) this.entries.delete(k);
    }
    // des dossiers sans index (très vieux, ou index perdu) : on regarde leur date
    for (const d of await readdir(this.root).catch(() => [] as string[])) {
      if (d === 'index.jsonl') continue;
      const st = await stat(path.join(this.root, d)).catch(() => null);
      if (st?.isDirectory() && st.mtimeMs < limit) await rm(path.join(this.root, d), { recursive: true, force: true });
    }
  }

  /** Réécrit l'index d'un coup (une ligne par passage). */
  private async compact() {
    await writeFile(this.indexFile, [...this.entries.values()].map((e) => JSON.stringify(e)).join('\n') + (this.entries.size ? '\n' : ''));
  }
}
