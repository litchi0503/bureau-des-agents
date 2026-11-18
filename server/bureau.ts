// Le bureau, côté serveur. Il vit dans un vrai dossier, ~/Documents/Bureau des agents/ :
//   - « Règlement du bureau.md » : ce que l'équipe doit savoir sur toi (Max le lit avant chaque mission) ;
//   - « Missions/ » : un dossier par mission, où l'équipe range tout ce qu'elle produit ;
//   - « .bureau/ » (caché) : l'état du bureau et l'enregistrement de chaque mission (pour la rejouer).
// Une mission = une séance Claude Code lancée dans le dossier de la mission. On peut lui reparler
// une fois finie (retouches) : la même séance reprend.
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countStats, emptyStats, normRole, roleOfType, ROLES } from '../shared/activity.ts';
import type { AgentState, ClaudeInfo, FileInfo, Logged, MissionInfo, OfficeEvent, Pole, Quota, ServerMsg, Settings, TeamEntry, VersionInfo } from '../shared/protocol.ts';
import { ClaudeProcess, Normalizer, quotaFromEvent, type ClaudeBinary, type TurnResult } from './claude.ts';
import { agentsJson, ALWAYS_ALLOWED, chefPrompt, poleModel, SESSION_TOOLS } from './team.ts';
import { defaultSettings, mergeSettings, modelFamily, modelLabel, type ModelId } from '../shared/settings.ts';
import { checkReviewBash, checkReviewWrite } from './policy.ts';
import { guardDecision } from './guard.ts';
import { History } from './history.ts';
import { openPath } from './opener.ts';
import { dirtyTree, enrich, ensureCommitHook, git, listDirs, mapContext, newProject, prepareBranch, projectHome, ProjectLocks, signaturesBeforePush, slug } from './projects.ts';
import { addRow, EMPTY_BACKLOG, nextId, parseBacklog, questionCount, setRow } from './backlog.ts';
import { checkGit, checkReadOnlyWrite, isMergeToBase, type GitContext } from './policy.ts';
import type { ProjectBrief } from './team.ts';
import type { BacklogRow, CarnetInfo, ProjectInfo } from '../shared/protocol.ts';
import { blockedFor, crashReason, resultError } from './watchdog.ts';

const RULES_FILE = 'Règlement du bureau.md';
const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.ts');
/** au-delà, un appel Agent qui attend une place est refusé (Max pourra le relancer plus tard) */
const SLOT_WAIT_MS = 20 * 60 * 1000;

type Json = Record<string, any>;
/** La réponse au hook PreToolUse (voir server/hook.ts). */
export interface HookReply { exit: 0 | 2; stdout?: string; stderr?: string }
const pass: HookReply = { exit: 0 };
const deny = (stderr: string): HookReply => ({ exit: 2, stderr });

const RULES_TEMPLATE = `# Le règlement du bureau

Max, le chef de projet, lit ce fichier avant chaque mission. Écris-y ce que l'équipe doit savoir
sur toi, avec tes mots, comme si tu briefais de nouveaux collègues.

## Qui je suis
<!-- Par exemple : « Je m'appelle Alex, je suis coach sportif à Lyon. Je vends des programmes en ligne à des femmes de 30 à 45 ans. » -->

## Comment travailler pour moi
- Réponds-moi en français, simplement.
- Va droit au but : je veux des livrables prêts à servir.
- Range tout dans le dossier de la mission, avec des noms de fichiers clairs.
`;

const README = `# Le Bureau des agents

Ici travaille ton équipe d'agents IA (des agents Claude Code).

- « Règlement du bureau.md » : ce que l'équipe doit savoir sur toi. Max, le chef, le lit avant chaque mission.
- « Missions » : un dossier par mission. Tout ce que l'équipe produit (rapports, pages web, textes) y est rangé.

Le dossier caché « .bureau » garde l'état du bureau et l'enregistrement de chaque mission, pour la rejouer.
Tu peux le supprimer pour tout recommencer.
`;

/**
 * Les réglages par défaut. Le garde-fou se règle dans le bureau ; les anciennes variables d'environnement
 * (BUREAU_MAX_ENERGY, BUREAU_MAX_MISSION) servent de repli tant que rien n'est enregistré.
 */
function initialSettings(): Settings {
  const s = defaultSettings();
  const env = percentFromEnv('BUREAU_MAX_ENERGY', -1);
  if (env >= 0) { const v = env === 0 ? 100 : Math.max(10, Math.round(env / 5) * 5); s.guard.max5h = v; s.guard.maxWeek = v; }
  const mission = percentFromEnv('BUREAU_MAX_MISSION', -1);
  if (mission > 0) s.guard.budget = [5, 10, 15, 25].find((x) => x >= mission) ?? 25;
  return s;
}
const IDLE_STOP_MS = 15 * 60 * 1000;
const MAX_LOG = 8000;
const MAX_MISSIONS = 300;

/** Pourcentage (0-100) lu dans une variable d'environnement ; 0 ou invalide = pas de limite. */
function percentFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 0;
}
/** « aujourd'hui à 23:30 », « demain à 08:00 » ou « mardi 27 octobre à 08:00 ». */
function whenFr(ms: number): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const now = new Date();
  if (day(d) === day(now)) return `aujourd’hui à ${hm}`;
  if (day(d) === day(new Date(now.getTime() + 86400000))) return `demain à ${hm}`;
  return `${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${hm}`;
}

/** Garde-fous pour ne pas vider l'abonnement : plafond de l'énergie 5 h, et part maximale d'une mission. */
const PAUSE_RESUME_TEXT = 'La pause café est finie : l’énergie est rechargée. Reprends exactement là où l’équipe s’était arrêtée, sans refaire ce qui est déjà fait, et mène la mission à son terme.';
/** au-delà, un fichier n'est pas gardé en version (vidéos, gros exports) */
const MAX_VERSION_SIZE = 5_000_000;
const MAX_VERSIONS = 30;

/** Un nom de dossier sûr pour ranger les versions d'un fichier. */
const versionDirName = (rel: string) => rel.replace(/[\\/]+/g, '__').replace(/[^\w.\-À-ÿ ]+/g, '_').slice(0, 160);

/** La pause café en cours : quelle mission reprendre, et quand (ms). Sauvegardée pour survivre à un redémarrage. */
interface Pause { missionId: string; resumeAt: number; text: string }
interface State { missions: MissionInfo[]; settings: Settings; pause?: Pause; quota?: Quota; projects?: ProjectInfo[] }

interface Live {
  proc: ClaudeProcess;
  norm: Normalizer;
  stopping: boolean;
  /** le dernier message envoyé (pour le renvoyer si la reprise de séance échoue) */
  lastText: string;
  resumed: boolean;
}

interface Current {
  mission: MissionInfo;
  log: Logged[];
  live: Live | null;
  /** les prénoms déjà donnés dans cette mission */
  names: Set<string>;
  /** la part de la semaine déjà utilisée (0-1) quand la demande a commencé : sert à son budget */
  quotaBase?: number;
  /** le budget de la demande est atteint : Max a demandé s'il continue */
  budgetAsked?: boolean;
  budgetUsed?: number;
  watcher: FSWatcher | null;
  fileTimers: Map<string, NodeJS.Timeout>;
  idleTimer: NodeJS.Timeout | null;
  /** depuis quand l'équipe travaille (null = au repos) */
  busySince: number | null;
  stopAsked: boolean;
  lastChefText: string;
  /** les places occupées, pôle par pôle (identifiants des appels Agent) */
  slots: Map<Pole, Set<string>>;
  /** les appels Agent qui attendent une place */
  waiters: { pole: Pole; id: string; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }[];
  /** le modèle de chaque agent (pour la fiche et les bascules) */
  models: Map<string, string>;
  /** le dernier état noté de chaque agent */
  states: Map<string, AgentState>;
  /** les agents déjà relancés une fois après un plantage */
  relaunched: Set<string>;
  /** la demande travaille dans un projet : ses consignes (git, carte, carnet) */
  brief?: ProjectBrief;
}

function newCurrent(mission: MissionInfo, extra: Partial<Current> = {}): Current {
  return {
    mission, log: [], live: null, names: new Set(), watcher: null, fileTimers: new Map(), idleTimer: null,
    busySince: null, stopAsked: false, lastChefText: '', slots: new Map(), waiters: [], models: new Map(),
    states: new Map(), relaunched: new Set(), ...extra,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Un titre court, tiré de la demande : « Analyse mes 5 concurrents et fais-moi… » → « Analyse mes 5 concurrents et fais-moi » */
function titleOf(prompt: string) {
  const first = prompt.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  let t = first.replace(/[.!?:;,]+$/, '');
  if (t.length > 46) t = t.slice(0, 46).replace(/\s+\S*$/, '') + '…';
  return t ? t[0].toUpperCase() + t.slice(1) : 'Mission';
}

const cleanName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');

/** Le contenu du règlement, sans les commentaires d'exemple. */
function readRules(dir: string) {
  try {
    return readFileSync(path.join(dir, RULES_FILE), 'utf8').replace(/<!--[\s\S]*?-->/g, '').slice(0, 20000);
  } catch { return ''; }
}

export class Bureau {
  readonly dir: string;
  readonly missionsDir: string;
  private stateFile: string;
  private recDir: string;
  private verDir: string;
  private state: State = { missions: [], settings: initialSettings() };
  private saveTimer: NodeJS.Timeout | null = null;
  current: Current | null = null;
  quota: Quota | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  /** le jeton secret du hook (propre à ce lancement du bureau) et son adresse (posée par index.ts) */
  readonly hookToken = randomBytes(24).toString('hex');
  hookUrl = '';
  /** les modèles dont le quota est plein, jusqu'à quand (ms) */
  private limits = new Map<ModelId, number>();
  /** l'historique des agents, sur le disque */
  readonly history: History;
  private histChain: Promise<void> = Promise.resolve();
  /** une seule demande à la fois par projet */
  readonly locks = new ProjectLocks();

  private claude: ClaudeBinary | null;
  private broadcast: (m: ServerMsg) => void;

  constructor(claude: ClaudeBinary | null, broadcast: (m: ServerMsg) => void, dir?: string) {
    this.claude = claude;
    this.broadcast = broadcast;
    this.dir = dir ?? path.join(os.homedir(), 'Documents', 'Bureau des agents');
    this.missionsDir = path.join(this.dir, 'Missions');
    this.stateFile = path.join(this.dir, '.bureau', 'state.json');
    this.recDir = path.join(this.dir, '.bureau', 'missions');
    this.verDir = path.join(this.dir, '.bureau', 'versions');
    this.history = new History(this.dir);
  }

  async init() {
    const fresh = !existsSync(this.dir);
    await mkdir(this.recDir, { recursive: true });
    await mkdir(this.missionsDir, { recursive: true });
    if (fresh) await writeFile(path.join(this.dir, 'LISEZ-MOI.md'), README);
    if (!existsSync(path.join(this.dir, RULES_FILE))) await writeFile(path.join(this.dir, RULES_FILE), RULES_TEMPLATE);
    if (existsSync(this.stateFile)) {
      try {
        const s = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<State>;
        this.state = { ...s, missions: Array.isArray(s.missions) ? s.missions : [], settings: mergeSettings(initialSettings(), s.settings), pause: s.pause, quota: s.quota };
        // la dernière mesure d'énergie : le bureau l'affiche dès l'ouverture (elle se périme toute seule à la recharge)
        this.quota = s.quota ?? null;
      } catch { /* état illisible : on repart proprement */ }
    }
    // une mission restée « au travail » (le bureau a été coupé pendant qu'elle tournait) est arrêtée
    for (const m of this.state.missions) if (m.status === 'working') m.status = 'stopped';
    await this.history.init(this.settings.follow.keepMonths, this.state.missions, this.recDir).catch((e) => console.error('  ⚠  Historique des agents :', e instanceof Error ? e.message : e));
    await this.restore();
    this.startProbing();
    setInterval(() => this.watchdog(), 30_000).unref();
  }

  claudeInfo(): ClaudeInfo {
    return this.claude ? { found: true, version: this.claude.version, path: this.claude.path } : { found: false };
  }

  get settings() { return this.state.settings; }

  setSettings(p: Partial<Settings>) {
    this.state.settings = mergeSettings(this.state.settings, p);
    this.save();
    this.broadcast({ t: 'settings', settings: this.state.settings });
  }

  missions(): MissionInfo[] {
    return [...this.state.missions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
  }

  hello(): ServerMsg {
    const c = this.current;
    return {
      t: 'hello', claude: this.claudeInfo(), dir: this.dir, settings: this.settings, quota: this.quota,
      missions: this.missions(), current: c ? { mission: c.mission, log: c.log } : null, pause: this.pauseInfo(), projects: this.projects,
    };
  }

  /** La part de la semaine utilisée (0-1) : 0 si elle s'est déjà rechargée, undefined si inconnue. */
  private weekUsed(): number | undefined {
    const q = this.quota;
    if (!q || q.sevenDay === undefined) return undefined;
    return q.sevenDayResetsAt && Date.now() >= q.sevenDayResetsAt * 1000 ? 0 : q.sevenDay;
  }

  /** Pourquoi on doit faire une pause café, et quand reprendre (ms), ou null si tout va bien (voir server/guard.ts). */
  private limitReason(cur?: Current | null): { message: string; resumeAt: number } | null {
    const r = guardDecision({ now: Date.now(), quota: this.quota, guard: this.settings.guard, bypass: cur?.mission.bypass });
    if (r.kind !== 'pause') return null;
    const where = r.window === '5h' ? 'la fenêtre de 5 h' : 'la semaine';
    return {
      resumeAt: r.resumeAt,
      message: `☕ Pause café : ton abonnement est utilisé à ${Math.round(r.used * 100)} % sur ${where} (plafond ${r.cap} %). L’équipe reprend toute seule ${whenFr(r.resumeAt)}.`,
    };
  }

  /** Appelé à chaque mesure d'énergie : plafond atteint = pause café ; budget de la demande atteint = Max demande. */
  private guard() {
    const cur = this.current;
    if (!cur || cur.mission.status !== 'working' || cur.stopAsked) return;
    if (cur.quotaBase === undefined) cur.quotaBase = this.weekUsed();
    const r = guardDecision({ now: Date.now(), quota: this.quota, guard: this.settings.guard, base: cur.quotaBase, bypass: cur.mission.bypass });
    if (r.kind === 'pause') {
      const why = this.limitReason(cur);
      if (why) this.startPause(cur, why.resumeAt, why.message);
    } else if (r.kind === 'budget' && !cur.budgetAsked) {
      cur.budgetAsked = true;
      cur.budgetUsed = r.used;
      this.stop();
    }
  }

  /** La pause café : on note où reprendre, on arrête l'équipe, et la reprise se fera toute seule (même après un redémarrage). */
  private startPause(cur: Current, resumeAt: number, message: string) {
    if (this.state.pause?.missionId === cur.mission.id && cur.mission.status !== 'working') return;
    this.record(cur, { k: 'error', message });
    this.record(cur, { k: 'state', who: 'chef', state: 'pause', reason: message });
    this.state.pause = { missionId: cur.mission.id, resumeAt, text: PAUSE_RESUME_TEXT };
    this.save();
    this.armPause();
    this.notify('pause', message);
    this.stop();
    // l'interruption polie ne suffit pas quand plusieurs agents travaillent en parallèle : au bout de 5 s, on coupe net
    const proc = cur.live?.proc;
    if (proc) setTimeout(() => { if (proc.alive) proc.kill(); }, 5000).unref();
  }

  /** Une nouvelle mesure d'énergie : on la montre, on la garde, et on vérifie les limites. */
  private setQuota(q: Partial<Quota>) {
    this.quota = { fiveHour: 0, resetsAt: null, ...this.quota, ...q, ...(q.models ? { models: { ...this.quota?.models, ...q.models } } : {}) };
    this.broadcast({ t: 'quota', quota: this.quota });
    this.state.quota = this.quota;
    this.save();
    this.guard();
  }

  /**
   * Claude Code n'envoie pas toujours la mesure d'énergie pendant une mission : on la demande donc avec une toute petite
   * requête (un mot, modèle léger), au démarrage puis toutes les 2 minutes tant qu'une mission travaille.
   */
  private probing = false;
  async probeQuota() {
    if (!this.claude || this.probing) return;
    this.probing = true;
    try {
      const env = { ...process.env };
      if (process.env.BUREAU_USE_API_KEY !== '1') { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
      const out = await new Promise<string>((resolve) => {
        const p = execFile(this.claude!.path, ['-p', '--model', 'haiku', '--restricted', '--output-format', 'stream-json', '--verbose'],
          { cwd: os.tmpdir(), env, timeout: 90000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? '')));
        p.stdin?.end('ok\n');
      });
      for (const line of out.split('\n')) {
        if (!line.includes('rate_limit_event')) continue;
        try {
          const m = JSON.parse(line);
          if (m.type !== 'rate_limit_event') continue;
          const part = quotaFromEvent(m);
          if (Object.keys(part).length) this.setQuota(part);
        } catch { /* ligne abîmée */ }
      }
    } finally {
      this.probing = false;
    }
  }

  private startProbing() {
    setTimeout(() => { void this.probeQuota(); }, 3000).unref();
    setInterval(() => { if (this.current?.mission.status === 'working') void this.probeQuota(); }, 2 * 60 * 1000).unref();
  }

  pauseInfo() { const p = this.state.pause; return p ? { missionId: p.missionId, resumeAt: p.resumeAt } : null; }

  /** Programme la reprise automatique (elle survit à un redémarrage du bureau : voir init). */
  private armPause() {
    this.broadcast({ t: 'pause', pause: this.pauseInfo() });
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const p = this.state.pause;
    if (!p) return;
    const delay = Math.min(Math.max(p.resumeAt - Date.now(), 0) + 15000, 2 ** 31 - 1);
    this.pauseTimer = setTimeout(() => { void this.endPause(); }, delay);
  }

  private async endPause() {
    const p = this.state.pause;
    this.pauseTimer = null;
    if (!p) return;
    const retry = (ms: number) => { this.pauseTimer = setTimeout(() => { void this.endPause(); }, ms); };
    // une mesure fraîche (la dernière date peut-être d'avant le reset), puis : une autre fenêtre est peut-être encore pleine
    await this.probeQuota().catch(() => {});
    const why = this.limitReason();
    if (why) { p.resumeAt = why.resumeAt; this.save(); this.armPause(); return; }
    // une autre mission est en cours : on ne la dérange pas
    if (this.current?.mission.status === 'working') return retry(5 * 60 * 1000);
    try {
      if (this.current?.mission.id !== p.missionId) await this.reopen(p.missionId);
      this.state.pause = undefined;
      this.save();
      this.broadcast({ t: 'pause', pause: null });
      const cur = this.current;
      if (cur) this.record(cur, { k: 'state', who: 'chef', state: 'working', reason: 'Reprise après la pause café' });
      this.notify('pause', `Fin de la pause café : l’équipe reprend « ${cur?.mission.title ?? ''} ».`);
      this.say(p.text);
    } catch (e) {
      const cur = this.current;
      if (cur) this.record(cur, { k: 'error', message: `La pause café est finie, mais je n’ai pas pu reprendre : ${e instanceof Error ? e.message : String(e)}` });
      this.state.pause = undefined;
      this.save();
      this.broadcast({ t: 'pause', pause: null });
    }
  }

  /** Remet une mission passée sur le bureau (historique compris) : Max reprend sa séance dès qu'on lui parle. */
  async reopen(missionId: string): Promise<void> {
    const m = this.mission(missionId);
    if (!m) throw new Error('Mission introuvable.');
    if (this.current?.mission.status === 'working') throw new Error('L’équipe est déjà sur une mission.');
    if (this.current) this.close();
    const raw = await readFile(path.join(this.recDir, `${m.id}.jsonl`), 'utf8').catch(() => '');
    const log: Logged[] = [];
    const names = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const l = JSON.parse(line) as Logged;
        log.push(l);
        if (l.ev.k === 'hire') names.add(l.ev.name);
      } catch { /* ligne abîmée : on la saute */ }
    }
    const proj = m.projectId ? this.project(m.projectId) : null;
    const brief = proj ? await this.projectBrief(proj, m, m.branch ?? '', (/^\[Demande (D-\d+)\]/.exec(log.find((x) => x.ev.k === 'start')?.ev.k === 'start' ? (log.find((x) => x.ev.k === 'start')!.ev as { text: string }).text : '') ?? [])[1] ?? '', null).catch(() => undefined) : undefined;
    const cur = newCurrent(m, { log, names, lastChefText: m.final ?? '', quotaBase: this.weekUsed(), brief });
    this.current = cur;
    this.watch(cur);
    this.broadcast({ t: 'mission', mission: m });
  }

  /** Au démarrage : on remet sur le bureau la mission en pause, ou la dernière, pour reprendre où on en était. */
  private async restore() {
    const p = this.state.pause;
    const last = [...this.state.missions].sort((a, b) => b.createdAt - a.createdAt)[0];
    const id = p?.missionId ?? last?.id;
    if (id) await this.reopen(id).catch(() => {});
    this.armPause();
  }

  private mission(id: string) { return this.state.missions.find((m) => m.id === id) ?? null; }

  // ── Une nouvelle mission ──
  async start(prompt: string, opts: { bypass?: boolean; projectId?: string } = {}) {
    const text = prompt.trim();
    const bypass = opts.bypass === true && this.settings.guard.allowBypass;
    if (!text) throw new Error('Dis à Max ce que tu veux.');
    if (!this.claude) throw new Error('Claude Code n’est pas installé sur cet ordinateur.');
    const proj = opts.projectId ? this.project(opts.projectId) : null;
    if (opts.projectId && !proj) throw new Error('Ce projet n’existe plus.');
    // le verrou : une demande est déjà en cours sur ce projet → la nouvelle attend dans le carnet
    if (proj && this.locks.holder(proj.id) && this.current?.mission.status === 'working') {
      const row = await this.carnetAdd(proj, text, `${this.current.mission.title}`);
      this.broadcast({ t: 'toast', kind: 'info', text: `Une demande est déjà en cours sur ${proj.name} : « ${row.title} » attend dans le carnet (${row.id}).` });
      return;
    }
    if (this.current?.mission.status === 'working') throw new Error('L’équipe est déjà sur une mission. Attends qu’elle la rende, ou arrête-la.');
    const blocked = bypass ? null : this.limitReason();
    if (blocked) throw new Error(blocked.message);
    if (this.current) this.close();

    const now = new Date();
    const title = titleOf(text);
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}h${pad(now.getMinutes())}`;
    let folder = path.join(this.missionsDir, cleanName(`${stamp} · ${title.replace(/…$/, '')}`).slice(0, 90));
    for (let n = 2; existsSync(folder); n++) folder = path.join(this.missionsDir, cleanName(`${stamp} · ${title.replace(/…$/, '')} ${n}`).slice(0, 90));
    await mkdir(folder, { recursive: true });

    const mission: MissionInfo = {
      id: 'm' + Date.now().toString(36), title, prompt: text, folder, createdAt: Date.now(), workMs: 0,
      status: 'working', stats: emptyStats(), files: [], ...(bypass ? { bypass: true } : {}),
      ...(proj ? { projectId: proj.id } : {}),
    };
    const brief = proj ? await this.prepareProject(proj, mission) : undefined;
    this.state.missions.push(mission);
    if (this.state.missions.length > MAX_MISSIONS) this.state.missions.splice(0, this.state.missions.length - MAX_MISSIONS);
    this.save();
    const cur = newCurrent(mission, { busySince: Date.now(), quotaBase: this.weekUsed(), brief });
    this.current = cur;
    if (proj) this.locks.acquire(proj.id, mission.id);
    this.watch(cur);
    this.broadcast({ t: 'mission', mission });
    if (brief) {
      for (const n of brief.notes) this.record(cur, { k: 'note', who: 'chef', text: n, level: 'info' });
      void this.sendProjects();
    }
    this.say(brief ? `[Demande ${brief.requestId}] ${text}` : text);
  }

  /** Parler à Max : la mission, puis les retouches. S'il s'était endormi, il reprend sa séance. */
  say(text: string) {
    const cur = this.current;
    if (!cur) throw new Error('Lance d’abord une mission.');
    const clean = text.trim();
    if (!clean) return;
    if (!this.claude) throw new Error('Claude Code n’est pas installé sur cet ordinateur.');
    const blocked = this.limitReason(cur);
    if (blocked) {
      // pendant la pause café, le message du patron est gardé et envoyé à la reprise
      const prev = this.state.pause?.missionId === cur.mission.id ? this.state.pause.text : PAUSE_RESUME_TEXT;
      this.state.pause = { missionId: cur.mission.id, resumeAt: blocked.resumeAt, text: `${prev}\n\nMessage de ton patron reçu pendant la pause : ${clean}` };
      this.save();
      this.armPause();
      this.record(cur, { k: 'error', message: `${blocked.message} Je garde ton message et je le lui transmettrai à la reprise.` });
      return;
    }
    if (cur.mission.projectId && !this.locks.acquire(cur.mission.projectId, cur.mission.id)) throw new Error('Une autre demande travaille déjà sur ce projet.');
    let l = cur.live;
    if (!l || !l.proc.alive) l = this.spawn(cur);
    if (cur.idleTimer) { clearTimeout(cur.idleTimer); cur.idleTimer = null; }
    l.lastText = clean;
    cur.stopAsked = false;
    // le budget de la demande était atteint et Max a demandé : ta réponse lui rouvre un budget
    if (cur.budgetAsked) { cur.budgetAsked = false; cur.quotaBase = this.weekUsed(); }
    if (cur.mission.status !== 'working') {
      cur.mission.status = 'working';
      cur.mission.endedAt = undefined;
      cur.busySince = Date.now();
      this.broadcast({ t: 'mission', mission: cur.mission });
    }
    this.record(cur, { k: 'start', text: clean });
    l.proc.send(clean);
  }

  private spawn(cur: Current, opts: { fresh?: boolean } = {}): Live {
    if (!this.claude) throw new Error('Claude Code n’est pas installé sur cet ordinateur.');
    const s = this.settings;
    const resume = opts.fresh ? undefined : cur.mission.sessionId;
    const limited = this.limited();
    const chefModel = poleModel(s, 'chef', limited) ?? s.team.chef.model;
    // le Normalizer renvoie vers la mission courante ; « proc » est connu dès que la ligne suivante a tourné
    const norm: Normalizer = new Normalizer({
      emit: (ev) => { if (cur.live?.proc === proc) this.onEvent(cur, ev); },
      onQuota: (q) => this.setQuota(q),
      onLimit: (info) => this.onLimit(info),
      onResult: (r) => { if (cur.live?.proc === proc) this.onResult(cur, r); },
      folder: cur.mission.folder,
      names: cur.names,
    });
    const proc: ClaudeProcess = new ClaudeProcess(
      {
        bin: this.claude.path, cwd: cur.brief ? this.project(cur.mission.projectId ?? '')?.path ?? cur.mission.folder : cur.mission.folder,
        addDirs: cur.brief ? [cur.mission.folder, path.dirname(cur.brief.mapPath)] : undefined, permissionMode: s.permission === 'ask' ? 'acceptEdits' : 'auto',
        model: chefModel, effort: s.team.chef.effort, resume, tools: SESSION_TOOLS, allowedTools: ALWAYS_ALLOWED,
        agents: agentsJson(s, limited), appendSystemPrompt: chefPrompt(readRules(this.dir), s, limited, cur.brief), useApiKey: process.env.BUREAU_USE_API_KEY === '1',
        settings: this.hookSettings(), env: { BUREAU_HOOK_URL: this.hookUrl, BUREAU_HOOK_TOKEN: this.hookToken },
      },
      (m) => {
        if (cur.live?.proc !== proc) return; // un ancien processus qui parle encore
        const refuse = norm.handle(m);
        if (refuse) proc.refuseControl(refuse);
      },
      (code, signal, stderr) => this.onExit(cur, proc, code, signal, stderr),
    );
    const l: Live = { proc, norm, stopping: false, lastText: '', resumed: !!resume };
    cur.live = l;
    proc.start();
    const before = cur.models.get('chef');
    if (before !== chefModel) {
      cur.models.set('chef', chefModel);
      this.record(cur, { k: 'model', who: 'chef', model: chefModel, effort: s.team.chef.effort, ...(chefModel !== s.team.chef.model ? { from: s.team.chef.model, reason: `quota de ${modelLabel(s.team.chef.model)} plein` } : {}) });
    }
    return l;
  }

  private onEvent(cur: Current, ev: OfficeEvent) {
    const m = cur.mission;
    if (ev.k === 'init') {
      const sid = cur.live?.norm.sessionId;
      if (sid) m.sessionId = sid;
      m.model = ev.model;
    }
    if (ev.k === 'say' && ev.who === 'chef') cur.lastChefText = ev.text;
    countStats(m.stats, ev);
    this.record(cur, ev);
    if (ev.k === 'leave') {
      this.releaseSlot(cur, ev.who);
      cur.states.set(ev.who, ev.ok ? 'done' : 'crashed');
      if (!ev.ok) this.onAgentCrash(cur, ev.who, 'L’agent s’est arrêté sur une erreur.');
    }
    if (ev.k === 'hire' || ev.k === 'init') this.save();
  }

  private onResult(cur: Current, r: TurnResult) {
    const l = cur.live;
    // des membres de l'équipe travaillent encore : Max reprendra la main quand ils auront rendu leur travail
    if (l && l.norm.present.size > 0 && r.ok && !cur.stopAsked) return;
    if (!r.ok && !cur.stopAsked && cur.mission.status === 'working') {
      const e = resultError(r.subtype, r.text);
      if (e.limit ? this.chefLimited(cur, r.text) : this.chefCrashed(cur, e.reason)) return;
    }
    this.finish(cur, r.ok, r.text.trim() || cur.lastChefText, r.ms, cur.stopAsked);
  }

  /**
   * Le modèle de Max n'a plus de quota : on note la limite, puis on relance sa séance avec son repli
   * (ou c'est la pause café s'il n'en a pas). Renvoie vrai si c'est pris en charge.
   */
  private chefLimited(cur: Current, text: string): boolean {
    const fam = modelFamily(cur.models.get('chef') ?? '') ?? this.settings.team.chef.model;
    const q = this.quota;
    const until = Math.max(q?.resetsAt ? q.resetsAt * 1000 : 0, Date.now() + 15 * 60 * 1000);
    this.setLimited(fam, until, text.slice(0, 120) || 'limite atteinte');
    if (poleModel(this.settings, 'chef', this.limited())) { this.restartChef(cur, `Le quota de ${modelLabel(fam)} est plein : tu continues avec ton modèle de repli.`); return true; }
    this.startPause(cur, until, `☕ Pause café : le quota de ${modelLabel(fam)} est plein et Max n’a pas de repli. L’équipe reprend toute seule ${whenFr(until)}.`);
    return true;
  }

  /** Max a planté : selon le réglage, on relance sa séance une fois (elle reprend où elle en était). */
  private chefCrashed(cur: Current, reason: string): boolean {
    this.record(cur, { k: 'state', who: 'chef', state: 'crashed', reason });
    this.notify('crash', `Max a planté : ${reason}`);
    const policy = this.settings.follow.onCrash;
    if (policy === 'retry' && !cur.relaunched.has('chef')) {
      cur.relaunched.add('chef');
      this.record(cur, { k: 'note', who: 'chef', text: 'Relance automatique (une fois).', level: 'info' });
      this.restartChef(cur, `Ta séance s’est arrêtée sur une erreur (${reason}).`);
      return true;
    }
    return false;
  }

  /** Relance la séance de Max (même conversation) et lui dit de reprendre là où il en était. */
  private restartChef(cur: Current, why: string) {
    const old = cur.live;
    if (old) {
      old.stopping = true;
      for (const id of old.norm.present) { this.record(cur, { k: 'leave', who: id, ok: false, tokens: 0, tools: 0, ms: 0 }); this.releaseSlot(cur, id); }
      old.norm.present.clear();
      cur.live = null;
      old.proc.kill();
    }
    const l = this.spawn(cur);
    const text = `${why} Reprends exactement là où l’équipe s’était arrêtée, sans refaire ce qui est déjà fait, et mène la demande à son terme.`;
    l.lastText = text;
    this.record(cur, { k: 'state', who: 'chef', state: 'working', reason: 'Séance relancée' });
    l.proc.send(text);
  }

  private finish(cur: Current, ok: boolean, text: string, ms: number, stopped: boolean) {
    const m = cur.mission;
    if (m.status !== 'working') return;
    // ceux qui travaillaient encore (mission arrêtée, erreur) quittent leur poste
    const present = cur.live?.norm.present;
    if (present?.size) {
      for (const id of present) this.record(cur, { k: 'leave', who: id, ok: false, tokens: 0, tools: 0, ms: 0 });
      present.clear();
    }
    for (const id of [...cur.slots.values()].flatMap((x) => [...x])) this.releaseSlot(cur, id);
    if (m.projectId) { this.locks.release(m.projectId, m.id); setTimeout(() => void this.sendProjects(), 50); }
    for (const w of cur.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(false); }
    const now = Date.now();
    m.status = ok ? 'done' : stopped ? 'stopped' : 'error';
    m.endedAt = now;
    if (cur.busySince) m.workMs += now - cur.busySince;
    cur.busySince = null;
    if (text) m.final = text.slice(0, 20000);
    // les demandes encore ouvertes n'ont plus d'objet
    const l = cur.live;
    if (l) for (const id of l.norm.pendingRequests()) { l.norm.forgetRequest(id); this.record(cur, { k: 'ask_done', requestId: id, allow: false, cancelled: true }); }
    this.record(cur, { k: 'end', ok, text: m.final ?? '', ms, stopped });
    if (cur.budgetAsked) {
      const q = `J’ai consommé ${Math.round((cur.budgetUsed ?? 0) * 100)} % de la semaine sur cette demande (budget : ${this.settings.guard.budget} %). Je continue ?`;
      this.record(cur, { k: 'say', who: 'chef', text: q });
      cur.lastChefText = q;
      this.notify('question', `Max : ${q}`);
    } else if (!stopped) this.notify(ok ? 'done' : 'crash', ok ? `Demande terminée : ${m.title}` : `La demande « ${m.title} » s’est mal terminée.`);
    this.broadcast({ t: 'mission', mission: m });
    this.save();
    // Max reste disponible un moment pour les retouches, puis s'endort (il reprendra sa séance si on lui reparle)
    if (cur.idleTimer) clearTimeout(cur.idleTimer);
    cur.idleTimer = setTimeout(() => {
      if (this.current === cur && cur.mission.status !== 'working' && cur.live) { cur.live.stopping = true; cur.live.proc.stop(); }
    }, IDLE_STOP_MS);
  }

  private onExit(cur: Current, proc: ClaudeProcess, code: number | null, signal: string | null, stderr: string) {
    const l = cur.live;
    if (!l || l.proc !== proc) return;
    cur.live = null;
    const failed = !l.stopping && (code !== 0 || signal !== null);
    // La séance à reprendre n'existe plus (Claude Code efface les vieilles séances) : on repart de zéro.
    if (failed && l.resumed && !l.norm.started && l.lastText && this.current === cur) {
      this.record(cur, { k: 'error', message: 'Je ne retrouve plus notre ancienne conversation : je reprends de zéro, avec ton dernier message.' });
      cur.mission.sessionId = undefined;
      const fresh = this.spawn(cur, { fresh: true });
      fresh.lastText = l.lastText;
      fresh.proc.send(l.lastText);
      return;
    }
    if (cur.mission.status === 'working') {
      const reason = crashReason({ code, signal, stderr, stopping: l.stopping });
      if (reason && !cur.stopAsked && this.current === cur) {
        cur.live = l;
        const handled = /^Limite atteinte/.test(reason) ? this.chefLimited(cur, reason) : this.chefCrashed(cur, reason);
        if (handled) return;
        cur.live = null;
      }
      const message = reason ?? 'Claude Code s’est arrêté.';
      if (!cur.stopAsked) this.record(cur, { k: 'error', message });
      // les membres de l'équipe encore présents s'en vont
      for (const id of l.norm.present) this.record(cur, { k: 'leave', who: id, ok: false, tokens: 0, tools: 0, ms: 0 });
      l.norm.present.clear();
      cur.live = l; // le temps de ranger les demandes ouvertes
      this.finish(cur, false, cur.lastChefText, 0, cur.stopAsked);
      cur.live = null;
    }
  }

  private record(cur: Current, ev: OfficeEvent) {
    const at = Date.now();
    this.broadcast({ t: 'ev', missionId: cur.mission.id, at, ev });
    if (ev.k === 'typing') return; // trop bavard pour l'enregistrement
    cur.log.push({ at, ev });
    if (cur.log.length > MAX_LOG) cur.log.splice(0, cur.log.length - MAX_LOG);
    void appendFile(path.join(this.recDir, `${cur.mission.id}.jsonl`), JSON.stringify({ at, ev }) + '\n').catch(() => {});
    // l'historique des agents (dans l'ordre : une file d'écriture)
    const m = cur.mission;
    this.histChain = this.histChain.then(() => this.history.add(m, ev, at, (w) => cur.models.get(w))).catch(() => {});
    // un agent noté « bloqué » qui se remet à bouger
    const who = 'who' in ev && typeof ev.who === 'string' ? ev.who : ev.k === 'hire' ? ev.id : '';
    if (who && ev.k !== 'state' && ev.k !== 'note' && ev.k !== 'model' && cur.states.get(who) === 'blocked') {
      cur.states.set(who, 'working');
      this.record(cur, { k: 'state', who, state: 'working', reason: 'Reprend le travail' });
    }
  }

  // ── Les fichiers produits par l'équipe ──
  private watch(cur: Current) {
    const folder = cur.mission.folder;
    try {
      cur.watcher = watch(folder, { recursive: true }, (_type, name) => {
        if (!name) return;
        const rel = String(name);
        if (rel.split(path.sep).some((p) => p.startsWith('.') || p === 'node_modules')) return;
        const prev = cur.fileTimers.get(rel);
        if (prev) clearTimeout(prev);
        cur.fileTimers.set(rel, setTimeout(() => { cur.fileTimers.delete(rel); void this.fileChanged(cur, rel); }, 350));
      });
      cur.watcher.on('error', () => {});
    } catch { cur.watcher = null; }
  }

  private async fileChanged(cur: Current, rel: string) {
    if (this.current !== cur) return;
    const abs = path.join(cur.mission.folder, rel);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return;
    const files = cur.mission.files;
    const i = files.findIndex((f) => f.path === rel);
    if (i >= 0 && files[i].size === st.size && files[i].at === st.mtimeMs) return;
    const file: FileInfo = {
      path: rel, name: path.basename(rel), ext: path.extname(rel).slice(1).toLowerCase(), size: st.size, at: st.mtimeMs,
      by: cur.live?.norm.writers.get(abs) ?? (i >= 0 ? files[i].by : 'chef'),
    };
    if (i >= 0) files[i] = file; else files.push(file);
    this.record(cur, { k: 'file', file, isNew: i < 0 });
    this.save();
    if (st.size <= MAX_VERSION_SIZE) void this.keepVersion(cur.mission.id, rel, abs, st.mtimeMs, file.by);
  }

  /** Garde une copie de chaque version d'un rendu (l'historique des versions). */
  private async keepVersion(missionId: string, rel: string, abs: string, at: number, by: string) {
    try {
      const dir = path.join(this.verDir, missionId, versionDirName(rel));
      await mkdir(dir, { recursive: true });
      const safeBy = by.replace(/[^\w-]/g, '').slice(0, 64) || 'chef';
      await copyFile(abs, path.join(dir, `${Math.round(at)}__${safeBy}${path.extname(rel)}`));
      const all = (await readdir(dir)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - MAX_VERSIONS))) await unlink(path.join(dir, old)).catch(() => {});
    } catch { /* pas de version cette fois : le fichier reste là */ }
  }

  /** Les versions d'un rendu, de la plus récente à la plus ancienne. */
  async versions(missionId: string, file: string): Promise<VersionInfo[]> {
    this.inside(missionId, file);
    const dir = path.join(this.verDir, missionId, versionDirName(file));
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: VersionInfo[] = [];
    for (const n of names) {
      const m = n.match(/^(\d+)__([\w-]*)/);
      if (!m) continue;
      const st = await stat(path.join(dir, n)).catch(() => null);
      if (st) out.push({ id: n, at: Number(m[1]), size: st.size, by: m[2] || 'chef' });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** Le chemin d'un fichier de la mission pour l'aperçu des sites (null s'il sort du dossier). */
  previewPath(missionId: string, rel: string): string | null {
    const m = this.mission(missionId);
    if (!m) return null;
    const target = path.resolve(m.folder, rel);
    if (!target.startsWith(m.folder + path.sep) || !existsSync(target)) return null;
    return target;
  }

  /** Tous les agents passés au bureau, mission par mission (les plus récentes d'abord). */
  async teamHistory(): Promise<TeamEntry[]> {
    const out: TeamEntry[] = [];
    for (const m of this.missions().slice(0, 40)) {
      const raw = await readFile(path.join(this.recDir, `${m.id}.jsonl`), 'utf8').catch(() => '');
      const byId = new Map<string, TeamEntry>();
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let l: Logged;
        try { l = JSON.parse(line) as Logged; } catch { continue; }
        const ev = l.ev;
        if (ev.k === 'hire') {
          byId.set(ev.id, {
            missionId: m.id, missionTitle: m.title, at: l.at, id: ev.id, name: ev.name, role: normRole(ev.role), task: ev.task,
            status: 'working', tools: 0, tokens: 0, ms: 0, report: '',
          });
        } else if (ev.k === 'report') {
          const e = byId.get(ev.who);
          if (e) e.report = ev.text.slice(0, 600);
        } else if (ev.k === 'leave') {
          const e = byId.get(ev.who);
          if (e) Object.assign(e, { status: ev.ok ? 'done' : 'failed', tools: ev.tools, tokens: ev.tokens, ms: ev.ms || l.at - e.at });
        }
      }
      out.push(...[...byId.values()].reverse());
    }
    return out;
  }

  // ── Le garde-fou de l'équipe (hook PreToolUse) : places, modèles, interdits ──

  /** Les modèles dont le quota est plein en ce moment. */
  limited(): Set<string> {
    const now = Date.now();
    for (const [m, until] of this.limits) if (until <= now) this.limits.delete(m);
    return new Set(this.limits.keys());
  }

  /** Une limite propre à un modèle (rate_limit_event) : les prochains appels de ce modèle basculent sur leur repli. */
  private onLimit(info: Json) {
    if (info.status !== 'rejected') return;
    const type = String(info.rateLimitType ?? '');
    const fam: ModelId | null = type === 'seven_day_opus' ? 'opus' : type === 'seven_day_sonnet' ? 'sonnet' : null;
    if (fam) this.setLimited(fam, Number(info.resetsAt ?? 0) * 1000 || Date.now() + 3600_000, `limite de la semaine propre à ${modelLabel(fam)}`);
  }

  /** Note qu'un modèle n'a plus de quota jusqu'à « until », et le dit dans le journal. */
  setLimited(fam: ModelId, until: number, why: string) {
    const was = this.limits.has(fam);
    this.limits.set(fam, Math.max(until, this.limits.get(fam) ?? 0));
    if (was) return;
    const cur = this.current;
    const s = this.settings;
    const poles = (Object.keys(s.team) as Pole[]).filter((p) => s.team[p].model === fam);
    const text = `Quota de ${modelLabel(fam)} plein (${why}) : ${poles.map((p) => `${ROLES[p].label} → ${s.team[p].fallback === 'none' ? 'pause café' : modelLabel(s.team[p].fallback)}`).join(', ') || 'aucun pôle concerné'}.`;
    if (cur) this.record(cur, { k: 'note', who: 'chef', text, level: 'warn' });
    this.notify('model', text);
  }

  /** Les hooks du garde-fou, passés à Claude Code par --settings (actifs même en mode restreint). */
  private hookSettings(): string {
    const command = `"${process.execPath}" "${HOOK_SCRIPT}"`;
    return JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Agent|Task|Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command, timeout: 1800 }] }] } });
  }

  /** Le jeton présenté par le hook est-il le bon ? (comparaison à temps constant) */
  hookAllowed(token: string): boolean {
    const a = Buffer.from(token);
    const b = Buffer.from(this.hookToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Le hook demande si un appel d'outil est permis (et comment le modifier). */
  async onHook(p: Json): Promise<HookReply> {
    const cur = this.current;
    if (!cur || !cur.live) return pass;
    const tool = String(p.tool_name ?? '');
    const input = (p.tool_input ?? {}) as Json;
    // qui fait l'appel : Max, ou un membre de l'équipe (son agent_type)
    const agentType = typeof p.agent_type === 'string' ? p.agent_type : '';
    const pole = agentType ? roleOfType(agentType) : 'chef';
    const who = (agentType && cur.live.norm.agentOfTaskId(String(p.agent_id ?? ''))) || 'chef';
    if (tool === 'Agent' || tool === 'Task') return this.hookAgent(cur, input, String(p.tool_use_id ?? ''));
    let why: string | null = null;
    if (tool === 'Bash') {
      const cmd = String(input.command ?? '');
      if (pole === 'relecture') why = checkReviewBash(cmd);
      why ??= await this.projectBash(cur, cmd);
    } else {
      const file = String(input.file_path ?? input.notebook_path ?? '');
      if (pole === 'relecture') why = checkReviewWrite(file);
      why ??= this.projectWrite(cur, file);
    }
    if (!why) return pass;
    this.record(cur, { k: 'note', who, text: `Refusé : ${why}`, level: 'warn' });
    return deny(why);
  }

  /** Un appel Agent : le modèle du pôle (ou son repli), sa puissance, et une place libre. */
  private async hookAgent(cur: Current, input: Json, id: string): Promise<HookReply> {
    const role = roleOfType(String(input.subagent_type ?? ''));
    if (role === 'renfort' || role === 'chef') return deny('Seuls les pôles du bureau peuvent être appelés : chercheur, designer, developpeur, relecteur, redacteur.');
    const pole = role;
    const s = this.settings;
    const conf = s.team[pole];
    const model = poleModel(s, pole, this.limited());
    if (!model) {
      const until = Math.max(this.limits.get(conf.model) ?? 0, Date.now() + 15 * 60 * 1000);
      const why = `Le quota de ${modelLabel(conf.model)} est plein et le pôle ${ROLES[pole].label} n’a pas de repli : pause café jusqu’au reset.`;
      this.record(cur, { k: 'state', who: id, state: 'pause', reason: why });
      this.startPause(cur, until, `☕ Pause café : ${why}`);
      return deny(why);
    }
    if (!(await this.takeSlot(cur, pole, id))) {
      return deny(`Le pôle ${ROLES[pole].label} est complet (${conf.places} place${conf.places > 1 ? 's' : ''}) depuis trop longtemps : attends qu’un agent ait fini, puis rappelle-le.`);
    }
    // petites tâches : Max peut demander Haiku (et une puissance faible) ; sinon, le modèle et la puissance du pôle
    const small = input.model === 'haiku';
    const finalModel = small ? 'haiku' : model;
    const effort = small ? String(input.effort ?? 'low') : conf.effort;
    cur.models.set(id, finalModel);
    this.record(cur, { k: 'model', who: id, model: finalModel, effort, ...(!small && model !== conf.model ? { from: conf.model, reason: `quota de ${modelLabel(conf.model)} plein` } : {}) });
    return {
      exit: 0,
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, model: finalModel, effort } } }),
    };
  }

  /** Une place au pôle : tout de suite s'il en reste, sinon on attend qu'un agent du pôle s'en aille. */
  private takeSlot(cur: Current, pole: Pole, id: string): Promise<boolean> {
    const places = this.settings.team[pole].places;
    let set = cur.slots.get(pole);
    if (!set) cur.slots.set(pole, (set = new Set()));
    if (set.has(id) || set.size < places) { set.add(id); return Promise.resolve(true); }
    this.record(cur, { k: 'state', who: id, state: 'queued', reason: `Attend une place au pôle ${ROLES[pole].label} (${places} place${places > 1 ? 's' : ''})` });
    cur.states.set(id, 'queued');
    return new Promise((resolve) => {
      const w = { pole, id, resolve, timer: setTimeout(() => { cur.waiters = cur.waiters.filter((x) => x !== w); resolve(false); }, SLOT_WAIT_MS) };
      cur.waiters.push(w);
    });
  }

  private releaseSlot(cur: Current, id: string) {
    for (const [pole, set] of cur.slots) {
      if (!set.delete(id)) continue;
      const i = cur.waiters.findIndex((w) => w.pole === pole);
      if (i < 0 || set.size >= this.settings.team[pole].places) continue;
      const [w] = cur.waiters.splice(i, 1);
      clearTimeout(w.timer);
      set.add(w.id);
      cur.states.set(w.id, 'working');
      this.record(cur, { k: 'state', who: w.id, state: 'working', reason: 'Une place s’est libérée' });
      w.resolve(true);
    }
  }

  /** Un agent a planté : selon le réglage, on le fait relancer une fois, on prévient, ou on arrête la demande. */
  private onAgentCrash(cur: Current, who: string, reason: string) {
    const policy = this.settings.follow.onCrash;
    const name = cur.log.find((l) => l.ev.k === 'hire' && l.ev.id === who)?.ev as { name?: string; role?: string } | undefined;
    const label = name?.name ?? (who === 'chef' ? 'Max' : 'Un agent');
    this.record(cur, { k: 'state', who, state: 'crashed', reason });
    this.notify('crash', `${label} a planté : ${reason}`);
    if (policy === 'stop') { this.record(cur, { k: 'note', who, text: 'Demande arrêtée (réglage « Arrêter la demande »).', level: 'error' }); this.stop(); return; }
    if (policy === 'retry' && who !== 'chef' && !cur.relaunched.has(who)) this.relaunch(who, true);
  }

  /** Toutes les 30 s : un agent sans aucun événement depuis le délai réglé est noté « bloqué ». */
  private watchdog() {
    const cur = this.current;
    const l = cur?.live;
    if (!cur || !l || cur.mission.status !== 'working') return;
    const delay = this.settings.follow.blockedMin;
    const now = Date.now();
    const waiting = (id: string) => l.norm.pendingRequests().length > 0 && (id === 'chef' || cur.states.get(id) === 'waiting') || cur.states.get(id) === 'queued';
    const ids = ['chef', ...l.norm.present];
    for (const id of ids) {
      // Max attend son équipe : ce n'est pas un blocage tant qu'un agent travaille
      if (id === 'chef' && l.norm.present.size > 0) continue;
      const last = Math.max(l.norm.lastSeen.get(id) ?? 0, cur.busySince ?? 0);
      const min = blockedFor(now, last, delay, waiting(id));
      if (!min || cur.states.get(id) === 'blocked') continue;
      cur.states.set(id, 'blocked');
      const name = id === 'chef' ? 'Max' : (cur.log.find((x) => x.ev.k === 'hire' && x.ev.id === id)?.ev as { name?: string } | undefined)?.name ?? 'Un agent';
      this.record(cur, { k: 'state', who: id, state: 'blocked', reason: `Bloqué · ${min} min sans aucune action` });
      this.notify('blocked', `${name} est bloqué depuis ${min} min (« ${cur.mission.title} »).`);
    }
  }

  /** Fait relancer un agent planté par Max, avec la même mission (bouton « Relancer », ou relance automatique). */
  relaunch(who: string, auto = false) {
    const cur = this.current;
    if (!cur) throw new Error('Aucune demande en cours.');
    const hire = cur.log.find((l) => l.ev.k === 'hire' && l.ev.id === who)?.ev;
    if (!hire || hire.k !== 'hire') throw new Error('Agent introuvable.');
    cur.relaunched.add(who);
    this.record(cur, { k: 'note', who, text: auto ? 'Relance automatique (une fois).' : 'Relance demandée.', level: 'info' });
    const text = `${hire.name} (pôle ${ROLES[normRole(hire.role)].label}) a planté sur « ${hire.task} ». Relance-le une seule fois, avec la même mission (subagent_type ${hire.type}).`;
    if (cur.mission.status === 'working' && cur.live?.proc.alive) cur.live.proc.send(text);
    else this.say(text);
  }

  /** Une alerte (Telegram, si relié et si la case est cochée dans l'onglet Suivi). */
  notify(kind: 'crash' | 'question' | 'pause' | 'done' | 'blocked' | 'model', text: string) {
    this.onNotify?.(kind, text);
  }
  onNotify: ((kind: 'crash' | 'question' | 'pause' | 'done' | 'blocked' | 'model', text: string) => void) | null = null;

  /** Les règles d'un projet pour une commande : interdits git, merge seulement si tout est vert, pas de signature d'IA. */
  private async projectBash(cur: Current, cmd: string): Promise<string | null> {
    const proj = cur.mission.projectId ? this.project(cur.mission.projectId) : null;
    if (!proj) return null;
    // l'équipe ne sort pas du projet (ni des dossiers de la demande)
    const allowed = [proj.path, cur.mission.folder, projectHome(this.dir, proj)];
    for (const m of cmd.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)/g)) {
      const target = m[1].replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, os.homedir());
      if (!path.isAbsolute(target)) continue;
      const abs = path.resolve(target);
      if (!allowed.some((d) => abs === d || abs.startsWith(d + path.sep))) return `L’équipe reste dans le projet : « cd ${m[1]} » est refusé.`;
    }
    if (!/\bgit\b|merge/.test(cmd)) return null;
    const ctx = await this.gitContext(cur, proj);
    const why = checkGit(cmd, ctx);
    if (why) return why;
    if (/\bgit\b[^;&|]*\bpush\b/.test(cmd)) {
      const sig = await signaturesBeforePush(proj.path, proj.base);
      if (sig) return `Refusé par le bureau : le commit ${sig} contient une signature d’IA (Co-Authored-By, « Generated with »…). Réécris son message sans, avec l’accord de ton patron.`;
    }
    if (isMergeToBase(cmd, ctx)) {
      // le merge vers la base n'est permis que si lint, typage, tests et build sont verts : le bureau les lance lui-même
      const checks = proj.commands.filter((c) => c.confirmed && c.name !== 'Merge');
      if (!checks.length) return 'Merge refusé : aucune commande de vérification confirmée pour ce projet (fiche du projet, « Commandes détectées »).';
      for (const c of checks) {
        const r = await new Promise<{ ok: boolean; out: string }>((resolve) => execFile('sh', ['-c', c.cmd], { cwd: proj.path, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => resolve({ ok: !e, out: `${out}${err}`.slice(-600) })));
        this.record(cur, { k: 'note', who: 'chef', text: `Vérification avant merge : ${c.name} (${c.cmd}) ${r.ok ? 'verte' : 'en échec'}.`, level: r.ok ? 'info' : 'warn' });
        if (!r.ok) return `Merge refusé : ${c.name} (${c.cmd}) n’est pas vert.\n${r.out}`;
      }
    }
    return null;
  }

  private projectWrite(cur: Current, file: string): string | null {
    const proj = cur.mission.projectId ? this.project(cur.mission.projectId) : null;
    if (!proj || proj.access !== 'read' || !file) return null;
    return checkReadOnlyWrite(file, proj.path);
  }

  private async gitContext(cur: Current, proj: ProjectInfo): Promise<GitContext> {
    const current = (await git(proj.path, ['branch', '--show-current'])).out;
    const merge = proj.commands.find((c) => c.name === 'Merge' && c.confirmed)?.cmd;
    return { access: proj.access, base: proj.base, work: cur.mission.branch ?? '', forbidden: proj.forbidden, current, mergeScript: merge?.replace(/^(npm run|pnpm|yarn|bash|sh)\s+/, '') };
  }

  // ── Les projets ──
  private get projects(): ProjectInfo[] { return (this.state.projects ??= []); }
  project(id: string) { return this.projects.find((p) => p.id === id) ?? null; }

  async projectList(): Promise<ProjectInfo[]> {
    const out: ProjectInfo[] = [];
    for (const p of this.projects) {
      const e = await enrich(p, this.dir).catch(() => ({ ...p }));
      const holder = this.locks.holder(p.id);
      e.busy = !!holder && this.current?.mission.id === holder && this.current.mission.status === 'working';
      e.missionId = holder ?? undefined;
      out.push(e);
    }
    return out;
  }

  async sendProjects() { this.broadcast({ t: 'projects', list: await this.projectList() }); }

  async addProject(dir: string) {
    const abs = path.resolve(dir.replace(/^~(?=\/|$)/, os.homedir()));
    if (this.projects.some((p) => p.path === abs)) throw new Error('Ce dossier est déjà un projet du bureau.');
    if (abs === this.dir || abs.startsWith(this.dir + path.sep)) throw new Error('Le dossier du bureau ne peut pas être un projet.');
    const p = await newProject(abs);
    this.projects.push(p);
    this.save();
    await this.sendProjects();
  }

  async updateProject(id: string, patch: Partial<ProjectInfo>) {
    const p = this.project(id);
    if (!p) throw new Error('Ce projet n’existe plus.');
    if (this.locks.holder(id) && this.current?.mission.status === 'working') throw new Error('Une demande travaille sur ce projet : attends qu’elle soit finie pour changer ses réglages.');
    const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : null);
    const name = str(patch.name, 60); if (name) p.name = name;
    if (typeof patch.path === 'string' && patch.path.trim()) {
      const abs = path.resolve(patch.path.trim().replace(/^~(?=\/|$)/, os.homedir()));
      if (!existsSync(abs)) throw new Error('Ce dossier n’existe pas.');
      p.path = abs;
    }
    if (patch.access === 'read' || patch.access === 'branch' || patch.access === 'push') p.access = patch.access;
    const base = str(patch.base, 100); if (base && /^[\w./-]+$/.test(base)) p.base = base;
    if (Array.isArray(patch.forbidden)) p.forbidden = patch.forbidden.map((x) => String(x).trim()).filter((x) => /^[\w./-]+$/.test(x)).slice(0, 20);
    if (Array.isArray(patch.commands)) p.commands = patch.commands.slice(0, 12).map((c) => ({ name: String(c.name ?? '').slice(0, 30), cmd: String(c.cmd ?? '').slice(0, 300), confirmed: c.confirmed === true })).filter((c) => c.name && c.cmd);
    if (Array.isArray(patch.readFirst)) p.readFirst = patch.readFirst.map((x) => String(x).trim().slice(0, 200)).filter((x) => x && !x.includes('..') && !path.isAbsolute(x)).slice(0, 20);
    if (typeof patch.backlogFile === 'string') { const f = patch.backlogFile.trim(); if (!f.includes('..') && !path.isAbsolute(f)) p.backlogFile = f.slice(0, 200); }
    this.save();
    await this.sendProjects();
  }

  async removeProject(id: string) {
    if (this.locks.holder(id) && this.current?.mission.status === 'working') throw new Error('Une demande travaille sur ce projet.');
    this.state.projects = this.projects.filter((p) => p.id !== id);
    this.save();
    await this.sendProjects();
  }

  /** Les sous-dossiers d'un dossier, pour « Choisir… » (à partir du dossier personnel). */
  async browse(dir: string) {
    const abs = path.resolve((dir || os.homedir()).replace(/^~(?=\/|$)/, os.homedir()));
    const parent = path.dirname(abs) === abs ? null : path.dirname(abs);
    return { path: abs, parent, dirs: await listDirs(abs) };
  }

  /** Le fichier du carnet d'un projet (et s'il appartient au dépôt). */
  private carnetFile(p: ProjectInfo) {
    return p.backlogFile ? { abs: path.join(p.path, p.backlogFile), shown: p.backlogFile, external: true } : { abs: path.join(projectHome(this.dir, p), 'carnet.md'), shown: 'Projets/' + path.basename(projectHome(this.dir, p)) + '/carnet.md', external: false };
  }

  /** Ajoute une demande au carnet (À faire), sans la lancer. */
  async carnetAdd(p: ProjectInfo, title: string, wait: string): Promise<BacklogRow> {
    const f = this.carnetFile(p);
    const raw = await readFile(f.abs, 'utf8').catch(() => (f.external ? '' : EMPTY_BACKLOG(p.name)));
    const row: BacklogRow = { id: nextId(parseBacklog(raw)), title: titleOf(title), step: 'Questions', state: 'À faire', wait };
    // un backlog du dépôt n'est écrit que par Max (dans son format) : on garde la demande à part, dans le carnet du bureau
    const own = this.carnetFile({ ...p, backlogFile: '' });
    const ownRaw = await readFile(own.abs, 'utf8').catch(() => EMPTY_BACKLOG(p.name));
    await mkdir(path.dirname(own.abs), { recursive: true });
    await writeFile(own.abs, addRow(ownRaw, { ...row, title: `${row.title} :: ${title.replace(/\s+/g, ' ').slice(0, 300)}` }));
    return row;
  }

  async carnet(projectId: string): Promise<CarnetInfo> {
    const p = this.project(projectId);
    if (!p) throw new Error('Ce projet n’existe plus.');
    const f = this.carnetFile(p);
    const raw = await readFile(f.abs, 'utf8').catch(() => '');
    let rows = parseBacklog(raw);
    // les demandes en attente gardées par le bureau (projet avec un backlog à lui)
    if (f.external) {
      const own = parseBacklog(await readFile(this.carnetFile({ ...p, backlogFile: '' }).abs, 'utf8').catch(() => '')) ?? [];
      const waiting = own.filter((r) => r.state === 'À faire' && !(rows ?? []).some((x) => x.id === r.id));
      if (waiting.length) rows = [...(rows ?? []), ...waiting];
    }
    if (rows) rows = rows.map((r) => ({ ...r, title: r.title.split(' :: ')[0] }));
    const cur = this.current?.mission.projectId === p.id ? this.current : null;
    const reqId = cur?.brief?.requestId ?? '';
    const row = rows?.find((r) => r.id === reqId);
    const last = cur?.lastChefText ?? '';
    return {
      projectId: p.id, file: f.shown, external: f.external, rows, raw: raw.slice(0, 60000),
      current: cur ? { id: reqId, title: row?.title ?? cur.mission.title, step: row?.step ?? 'Questions', missionId: cur.mission.id, working: cur.mission.status === 'working' } : null,
      questions: cur ? questionCount(last) : 0,
      tests: (rows ?? []).filter((r) => /ton test/i.test(r.step) && !/termin/i.test(r.state)).length,
      toValidate: cur && cur.mission.status !== 'working' ? (/À valider\s*:\s*(.+)$/im.exec(last)?.[1] ?? '') : '',
    };
  }

  /** Lance une demande du carnet (« À faire ») : on retrouve son texte complet. */
  async carnetLaunch(projectId: string, id: string) {
    const p = this.project(projectId);
    if (!p) throw new Error('Ce projet n’existe plus.');
    const own = this.carnetFile({ ...p, backlogFile: '' });
    const raw = await readFile(own.abs, 'utf8').catch(() => '');
    const row = parseBacklog(raw)?.find((r) => r.id === id);
    if (!row) throw new Error('Demande introuvable dans le carnet.');
    const text = row.title.includes(' :: ') ? row.title.split(' :: ').slice(1).join(' :: ') : row.title;
    await writeFile(own.abs, setRow(raw, id, { state: 'Lancée', wait: '—' }));
    await this.start(text, { projectId });
  }

  /** Prépare une demande dans un projet : numéro, branche, hook, arbre sale, carte, consignes. */
  private async prepareProject(p: ProjectInfo, m: MissionInfo): Promise<ProjectBrief & { notes: string[] }> {
    const notes: string[] = [];
    if (!existsSync(p.path)) throw new Error(`Le dossier du projet ${p.name} est introuvable.`);
    await mkdir(projectHome(this.dir, p), { recursive: true });
    // le numéro de la demande, et sa ligne dans le carnet du bureau
    const f = this.carnetFile(p);
    const raw = await readFile(f.abs, 'utf8').catch(() => (f.external ? '' : EMPTY_BACKLOG(p.name)));
    const own = this.carnetFile({ ...p, backlogFile: '' });
    const ownRaw = await readFile(own.abs, 'utf8').catch(() => EMPTY_BACKLOG(p.name));
    const requestId = nextId([...(parseBacklog(raw) ?? []), ...(parseBacklog(ownRaw) ?? [])]);
    if (!f.external) await writeFile(own.abs, addRow(ownRaw, { id: requestId, title: m.title, step: 'Questions', state: 'En cours', wait: '—' }));
    const isGit = (await git(p.path, ['rev-parse', '--is-inside-work-tree'])).out === 'true';
    const branch = isGit && p.access !== 'read' ? `bureau/${requestId.toLowerCase()}-${slug(m.title)}` : '';
    m.branch = branch || undefined;
    let dirty: string | null = null;
    if (isGit) {
      dirty = await dirtyTree(p.path);
      if (p.access !== 'read') {
        const hook = await ensureCommitHook(p.path);
        if (hook === 'installed') notes.push('Hook commit-msg installé dans le dépôt : il retire les signatures d’IA.');
        else if (hook === 'skipped') notes.push('Le dépôt a son propre dossier de hooks : le bureau vérifiera les messages avant chaque push.');
        const prep = await prepareBranch(p.path, p.base, branch, !!dirty);
        notes.push(prep.note);
      }
      if (dirty) notes.push('Le dépôt a des modifications non commitées : Max ne jette rien et te propose une branche de sauvegarde.');
    }
    const brief = await this.projectBrief(p, m, branch, requestId, dirty);
    return { ...brief, notes };
  }

  private async projectBrief(p: ProjectInfo, m: MissionInfo, branch: string, requestId: string, dirty: string | null): Promise<ProjectBrief> {
    const mapPath = path.join(projectHome(this.dir, p), 'carte.md');
    const ctx = await mapContext(p.path, mapPath);
    const f = this.carnetFile(p);
    return {
      name: p.name, access: p.access, base: p.base, branch, forbidden: p.forbidden,
      commands: p.commands.filter((c) => c.confirmed).map((c) => ({ name: c.name, cmd: c.cmd })),
      readFirst: p.readFirst, map: ctx.map, mapCommit: ctx.commit, diffSince: ctx.diff,
      backlog: f.external ? p.backlogFile : f.abs, backlogExternal: f.external, dirty, mapPath,
      deliverDir: m.folder, requestId: requestId || 'D-?',
    };
  }

  // ── Les commandes du bureau ──
  stop() {
    const cur = this.current;
    if (!cur || cur.mission.status !== 'working') return;
    cur.stopAsked = true;
    if (cur.live?.proc.alive) cur.live.proc.interrupt();
    else this.finish(cur, false, cur.lastChefText, 0, true);
  }

  answer(requestId: string, allow: boolean) {
    const cur = this.current;
    const l = cur?.live;
    if (!cur || !l || !l.norm.hasRequest(requestId)) return;
    l.proc.answerPermission(requestId, allow, l.norm.inputOf(requestId));
    l.norm.forgetRequest(requestId);
    this.record(cur, { k: 'ask_done', requestId, allow });
  }

  /** On range la mission (fin de journée) : le bureau est prêt pour la suivante. */
  close() {
    const cur = this.current;
    if (!cur) return;
    if (cur.mission.status === 'working') { cur.stopAsked = true; this.finish(cur, false, cur.lastChefText, 0, true); }
    if (cur.idleTimer) clearTimeout(cur.idleTimer);
    for (const t of cur.fileTimers.values()) clearTimeout(t);
    cur.watcher?.close();
    if (cur.live) { cur.live.stopping = true; cur.live.proc.stop(); }
    this.current = null;
    this.broadcast({ t: 'closed', missionId: cur.mission.id });
    this.save();
  }

  /** Le chemin d'un fichier de la mission (refusé s'il sort du dossier). */
  private inside(missionId: string, file?: string) {
    const m = this.mission(missionId);
    if (!m) throw new Error('Cette mission n’existe plus.');
    if (!file) return { m, target: m.folder };
    const target = path.resolve(m.folder, file);
    if (!target.startsWith(m.folder + path.sep) || !existsSync(target)) throw new Error('Ce fichier n’est pas dans le dossier de la mission.');
    return { m, target };
  }

  /** Ouvre le dossier de la mission (ou un de ses fichiers) avec l'appli par défaut. */
  open(missionId: string, file?: string) {
    const { target } = this.inside(missionId, file);
    openPath(target);
  }

  /** Ouvre le dossier du bureau, ou son règlement (dans l'éditeur de texte par défaut). */
  openRoot(rules: boolean) {
    const target = rules ? path.join(this.dir, RULES_FILE) : this.dir;
    if (rules && !existsSync(target)) writeFileSync(target, RULES_TEMPLATE);
    openPath(target, { textEditor: rules });
  }

  /** Le texte d'un rendu (rapport, CSV…), pour le lire dans le bureau. */
  async readText(missionId: string, file: string, version?: string) {
    let { target } = this.inside(missionId, file);
    if (version) {
      if (!/^\d+__[\w-]*(\.[\w-]+)?$/.test(version)) throw new Error('Version inconnue.');
      target = path.join(this.verDir, missionId, versionDirName(file), version);
      if (!existsSync(target)) throw new Error('Cette version n’existe plus.');
    }
    const st = await stat(target);
    const max = 400_000;
    const buf = await readFile(target);
    return { text: buf.subarray(0, max).toString('utf8'), truncated: st.size > max };
  }

  /** L'enregistrement d'une mission, pour la rejouer (pratique pour filmer sans relancer l'équipe). */
  async replay(missionId: string): Promise<{ mission: MissionInfo; log: Logged[] }> {
    const m = this.mission(missionId);
    if (!m) throw new Error('Cette mission n’existe plus.');
    const raw = await readFile(path.join(this.recDir, `${m.id}.jsonl`), 'utf8').catch(() => '');
    const log: Logged[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { log.push(JSON.parse(line) as Logged); } catch { /* ligne coupée */ }
    }
    if (!log.length) throw new Error('Cette mission n’a pas été enregistrée.');
    return { mission: m, log };
  }

  /** Sauvegarde groupée (au plus une fois par seconde), écrite d'un coup pour ne jamais laisser un fichier à moitié écrit. */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      try {
        const tmp = this.stateFile + '.tmp';
        await writeFile(tmp, JSON.stringify(this.state));
        await rename(tmp, this.stateFile);
      } catch (e) {
        console.error('  ⚠  Sauvegarde du bureau impossible :', e instanceof Error ? e.message : e);
      }
    }, 1000);
  }

  /** Le pont s'arrête : tout le monde s'arrête tout de suite, et on sauvegarde. */
  shutdown() {
    const cur = this.current;
    if (cur) {
      if (cur.mission.status === 'working') { cur.mission.status = 'stopped'; cur.mission.endedAt = Date.now(); if (cur.busySince) cur.mission.workMs += Date.now() - cur.busySince; }
      cur.watcher?.close();
      if (cur.live) { cur.live.stopping = true; cur.live.proc.kill(); }
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      const tmp = this.stateFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.stateFile);
    } catch { /* tant pis : l'état de la dernière sauvegarde reste */ }
  }
}
