// La mémoire du bureau, côté navigateur : la mission en cours, l'équipe, le plan, les rendus, ce que
// dit Max. Chaque événement venu du pont est rangé ici, puis transmis au moteur du jeu (les robots).
import { create } from 'zustand';
import { countStats, emptyStats, normRole } from '../../shared/activity.ts';
import { defaultSettings } from '../../shared/settings.ts';
import { setPlaces } from '../engine/layout.ts';
import { world } from '../engine/instance.ts';
import type {
  ActKind, ClaudeInfo, ClientMsg, FileInfo, MissionInfo, MissionStats, OfficeEvent, PlanItem, Quota, Role, ServerMsg, Settings, TeamEntry, TelegramStatus, VersionInfo, PauseInfo, ProjectInfo, AgentState, HistEntry, HistLine,
} from '../../shared/protocol.ts';
import { sfx } from '../audio/sfx.ts';
import { say } from '../audio/voice.ts';
import { bus } from './bus.ts';

export interface ActView { id: string; kind: ActKind; label: string; detail: string; at: number; ok?: boolean }

export interface AgentView {
  id: string;
  role: Role;
  name: string;
  task: string;
  prompt: string;
  status: 'working' | 'reporting' | 'done' | 'failed';
  act: ActView | null;
  acts: ActView[];
  say: string;
  sayAt: number;
  report: string;
  hiredAt: number;
  leftAt?: number;
  tokens: number;
  tools: number;
}

/** Le suivi d'un agent (ou de Max) : son état noté par le bureau, sa frise, son modèle. */
export interface TrackView {
  state: AgentState | null;
  reason: string;
  stateAt: number;
  /** les changements d'état, dans l'ordre (la frise de sa fiche) */
  timeline: { state: AgentState; at: number }[];
  /** le dernier événement venu de lui */
  lastAt: number;
  model: string;
  effort: string;
  /** la bascule de modèle (repli), s'il y en a eu une */
  switched: { from: string; to: string; at: number } | null;
  crashedAt: number;
}

export const emptyTrack = (): TrackView => ({ state: null, reason: '', stateAt: 0, timeline: [], lastAt: 0, model: '', effort: '', switched: null, crashedAt: 0 });

export interface ChefView {
  say: string;
  sayAt: number;
  typing: string;
  thinkingAt: number;
  act: ActView | null;
  acts: ActView[];
}

export interface AskView { requestId: string; who: string; tool: string; label: string; detail: string; full: boolean; at: number }

export interface FeedLine { id: number; at: number; who: string; text: string; kind: 'user' | 'chef' | 'hire' | 'act' | 'report' | 'file' | 'ask' | 'end' | 'error' }

export interface Toast { id: number; kind: 'info' | 'error'; text: string }

export type Tod = 'auto' | 'day' | 'evening' | 'night';

/** Les fenêtres qu'on ouvre en cliquant sur le bureau (un robot, le tableau, l'horloge…). */
export type Modal =
  | { kind: 'agent'; id: string; missionId?: string }
  | { kind: 'board' }
  | { kind: 'clock' }
  | { kind: 'machine' }
  | { kind: 'jukebox' }
  | { kind: 'team'; role?: Role }
  | { kind: 'files' }
  | { kind: 'preview'; missionId: string; file: string };

interface S {
  connection: 'connecting' | 'live' | 'offline' | 'demo';
  claude: ClaudeInfo | null;
  dir: string;
  settings: Settings;
  quota: Quota | null;
  telegram: TelegramStatus | null;
  /** la pause café en cours (bulle de Max, reprise automatique) */
  pause: PauseInfo | null;
  /** les projets (dossiers existants) enregistrés */
  projects: ProjectInfo[];
  /** le projet choisi pour la prochaine demande ('' = un nouveau dossier de demande) */
  projectId: string;
  missions: MissionInfo[];
  mission: MissionInfo | null;
  /** vrai pendant une rediffusion (ou la démo) */
  replaying: boolean;
  chef: ChefView;
  agents: Record<string, AgentView>;
  order: string[];
  plan: PlanItem[];
  files: FileInfo[];
  asks: Record<string, AskView>;
  stats: MissionStats;
  feed: FeedLine[];
  /** le suivi de chacun (clé : « chef » ou l'identifiant de l'agent) */
  track: Record<string, TrackView>;
  /** les journaux reçus du serveur (clé : demande|agent) */
  agentLogs: Record<string, { entry: HistEntry | null; lines: HistLine[] }>;
  /** la page de l'historique de l'équipe (👥) */
  historyPage: { q: string; page: number; total: number; entries: HistEntry[] } | null;
  final: { ok: boolean; text: string; ms: number; stopped?: boolean; at: number } | null;
  /** quand l'équipe s'est mise au travail (pour le chrono) ; null = au repos */
  busySince: number | null;
  workMs: number;
  // l'interface
  showFinal: boolean;
  viewer: { missionId: string; file: string; text?: string; truncated?: boolean; version?: string } | null;
  modal: Modal | null;
  /** les versions de chaque rendu (clé : mission|fichier) */
  versions: Record<string, VersionInfo[]>;
  teamHistory: TeamEntry[] | null;
  /** chaque version du plan, dans l'ordre (le tableau garde l'historique) */
  planHistory: { at: number; items: PlanItem[] }[];
  music: { playing: boolean; index: number; volume: number };
  /** la voix de Max (ElevenLabs) */
  voiceOn: boolean;
  /** en mode tournage, la caméra suit l'action toute seule */
  cameraAuto: boolean;
  /** la visite guidée en cours (le texte que Max dit) */
  tour: { step: number; text: string } | null;
  historyOpen: boolean;
  settingsOpen: boolean;
  vertical: boolean;
  /** écran en hauteur (téléphone) : même mise en page que le cadre vertical */
  portrait: boolean;
  filming: boolean;
  sound: boolean;
  tod: Tod;
  draft: string;
  toasts: Toast[];
  send: (m: ClientMsg) => void;
  receive: (m: ServerMsg) => void;
  apply: (ev: OfficeEvent, at: number, live: boolean) => void;
  resetMission: (m: MissionInfo | null) => void;
  toast: (kind: Toast['kind'], text: string) => void;
}

const pref = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem('bureau:' + key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
};
export const savePref = (key: string, v: unknown) => { try { localStorage.setItem('bureau:' + key, JSON.stringify(v)); } catch { /* navigation privée */ } };

/** Autant de chaises que de places, dans le bureau. */
function placesFrom(s: Settings) {
  if (!s?.team) return;
  setPlaces({ recherche: s.team.recherche.places, design: s.team.design.places, code: s.team.code.places, relecture: s.team.relecture.places, redaction: s.team.redaction.places });
}

const emptyChef = (): ChefView => ({ say: '', sayAt: 0, typing: '', thinkingAt: 0, act: null, acts: [] });

let feedId = 0;
let toastId = 0;
let lastActSound = 0;
const MAX_ACTS = 80;
const MAX_FEED = 160;

export const useOffice = create<S>((set, get) => ({
  connection: 'connecting',
  claude: null,
  dir: '',
  settings: defaultSettings(),
  quota: null,
  telegram: null,
  pause: null,
  projects: [],
  projectId: pref('projectId', ''),
  missions: [],
  mission: null,
  replaying: false,
  chef: emptyChef(),
  agents: {},
  order: [],
  plan: [],
  files: [],
  asks: {},
  stats: emptyStats(),
  feed: [],
  track: {},
  agentLogs: {},
  historyPage: null,
  final: null,
  busySince: null,
  workMs: 0,
  showFinal: false,
  viewer: null,
  modal: null,
  versions: {},
  teamHistory: null,
  planHistory: [],
  music: { playing: false, index: 0, volume: 0.55 },
  voiceOn: pref('voice', true),
  cameraAuto: pref('cameraAuto', true),
  tour: null,
  historyOpen: false,
  settingsOpen: false,
  vertical: pref('vertical', false),
  portrait: typeof window !== 'undefined' && window.innerWidth / Math.max(1, window.innerHeight) < 0.8,
  filming: false,
  sound: pref('sound', true),
  tod: pref<Tod>('tod', 'auto'),
  draft: '',
  toasts: [],
  send: () => {},

  toast: (kind, text) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-4) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 4500);
  },

  resetMission: (m) => {
    set({
      mission: m, chef: emptyChef(), agents: {}, order: [], plan: [], files: [], asks: {}, stats: emptyStats(),
      feed: [], final: null, busySince: null, workMs: 0, showFinal: false, planHistory: [], track: {},
    });
    bus.reset();
  },

  receive: (m) => {
    const s = get();
    switch (m.t) {
      case 'hello': {
        set({ claude: m.claude, dir: m.dir, settings: m.settings, quota: m.quota, missions: m.missions, pause: m.pause ?? null });
        world.setPause(!!m.pause);
        placesFrom(m.settings);
        if (s.replaying) break;
        if (m.current) {
          get().resetMission(m.current.mission);
          for (const l of m.current.log) get().apply(l.ev, l.at, false);
          set({ mission: m.current.mission });
        } else get().resetMission(null);
        break;
      }
      case 'mission': {
        const list = [m.mission, ...s.missions.filter((x) => x.id !== m.mission.id)].sort((a, b) => b.createdAt - a.createdAt);
        set({ missions: list });
        if (s.replaying) break;
        if (s.mission?.id === m.mission.id) set({ mission: m.mission });
        else if (m.mission.status === 'working' && (!s.mission || s.mission.id !== m.mission.id)) get().resetMission(m.mission);
        break;
      }
      case 'ev':
        if (s.replaying || s.mission?.id !== m.missionId) break;
        get().apply(m.ev, m.at, true);
        break;
      case 'closed':
        if (!s.replaying && s.mission?.id === m.missionId) get().resetMission(null);
        break;
      case 'file_text':
        if (s.viewer && s.viewer.file === m.file) set({ viewer: { ...s.viewer, text: m.text, truncated: m.truncated, version: m.version } });
        break;
      case 'versions':
        set({ versions: { ...s.versions, [`${m.missionId}|${m.file}`]: m.list } });
        break;
      case 'team_history':
        set({ teamHistory: m.entries });
        break;
      case 'agent_log':
        set({ agentLogs: { ...s.agentLogs, [`${m.missionId}|${m.who}`]: { entry: m.entry, lines: m.lines } } });
        break;
      case 'history_page':
        set({ historyPage: { q: m.q, page: m.page, total: m.total, entries: m.entries } });
        break;
      case 'quota':
        set({ quota: m.quota });
        break;
      case 'telegram':
        set({ telegram: m.status });
        break;
      case 'pause':
        set({ pause: m.pause });
        world.setPause(!!m.pause);
        break;
      case 'settings':
        set({ settings: m.settings });
        placesFrom(m.settings);
        break;
      case 'toast':
        get().toast(m.kind, m.text);
        break;
      case 'replay':
        // géré par le lecteur (net/replay.ts)
        break;
    }
  },

  apply: (ev, at, live) => {
    const s = get();
    const feed = (who: string, text: string, kind: FeedLine['kind']) => {
      const line: FeedLine = { id: ++feedId, at, who, text, kind };
      return [...get().feed, line].slice(-MAX_FEED);
    };
    const agentName = (who: string) => (who === 'chef' ? 'Max' : s.agents[who]?.name ?? 'Un agent');
    // le suivi : le dernier signe de vie, l'état, la frise, le modèle
    {
      const who = 'who' in ev && typeof ev.who === 'string' ? ev.who : ev.k === 'hire' ? ev.id : ev.k === 'start' || ev.k === 'end' ? 'chef' : '';
      if (who) {
        const t = { ...(s.track[who] ?? emptyTrack()) };
        const setState = (state: AgentState, reason = '') => {
          if (t.state !== state) t.timeline = [...t.timeline, { state, at }].slice(-80);
          t.state = state; t.reason = reason; t.stateAt = at;
          if (state === 'crashed') t.crashedAt = at;
        };
        if (ev.k !== 'state' && ev.k !== 'note' && ev.k !== 'model') t.lastAt = at;
        if (ev.k === 'state') setState(ev.state, ev.reason ?? '');
        else if (ev.k === 'model') { t.model = ev.model; t.effort = ev.effort; if (ev.from) t.switched = { from: ev.from, to: ev.model, at }; }
        else if (ev.k === 'hire' || ev.k === 'start') setState('working');
        else if (ev.k === 'ask') setState('waiting', ev.label);
        else if (ev.k === 'leave') setState(ev.ok ? 'done' : 'crashed', ev.ok ? '' : t.reason || 'N’a pas pu finir');
        else if (ev.k === 'end') setState(ev.ok || ev.stopped ? 'done' : 'crashed', ev.ok ? '' : ev.stopped ? 'Demande arrêtée' : 'La demande s’est mal terminée');
        else if ((t.state === 'blocked' || t.state === 'waiting') && (ev.k === 'act' || ev.k === 'say' || ev.k === 'typing' || ev.k === 'report')) setState('working');
        set({ track: { ...get().track, [who]: t } });
      }
      if (ev.k === 'ask_done') {
        const ask = s.asks[ev.requestId];
        const t = ask && s.track[ask.who];
        if (t && t.state === 'waiting') set({ track: { ...get().track, [ask.who]: { ...t, state: 'working', reason: '', timeline: [...t.timeline, { state: 'working' as AgentState, at }] } } });
      }
    }
    switch (ev.k) {
      case 'start': {
        const first = s.feed.length === 0;
        set({
          chef: { ...s.chef, say: '', typing: '', thinkingAt: at }, final: null, showFinal: false,
          busySince: at, feed: feed('toi', ev.text, 'user'),
        });
        if (live && !first) sfx('send');
        if (live) void say('parti');
        break;
      }
      case 'init':
        break;
      case 'think':
        if (ev.who === 'chef') set({ chef: { ...s.chef, thinkingAt: at } });
        break;
      case 'typing':
        if (ev.who === 'chef') set({ chef: { ...s.chef, typing: ev.text } });
        else if (s.agents[ev.who]) set({ agents: { ...s.agents, [ev.who]: { ...s.agents[ev.who], say: ev.text, sayAt: at } } });
        break;
      case 'say':
        if (ev.who === 'chef') set({ chef: { ...s.chef, say: ev.text, sayAt: at, typing: '' }, feed: feed('Max', ev.text, 'chef') });
        else if (s.agents[ev.who]) set({ agents: { ...s.agents, [ev.who]: { ...s.agents[ev.who], say: ev.text, sayAt: at } } });
        break;
      case 'plan':
        set({ plan: ev.items, planHistory: [...s.planHistory, { at, items: ev.items }].slice(-60) });
        if (live && s.plan.length !== ev.items.length) sfx('plan');
        else if (live && ev.items.filter((i) => i.status === 'completed').length > s.plan.filter((i) => i.status === 'completed').length) sfx('check');
        break;
      case 'hire': {
        const a: AgentView = {
          id: ev.id, role: normRole(ev.role), name: ev.name, task: ev.task, prompt: ev.prompt, status: 'working', act: null, acts: [],
          say: '', sayAt: 0, report: '', hiredAt: at, tokens: 0, tools: 0,
        };
        const stats = { ...s.stats };
        countStats(stats, ev);
        const firstOfRound = !s.order.some((id) => s.agents[id]?.status === 'working' || s.agents[id]?.status === 'reporting');
        set({ agents: { ...s.agents, [ev.id]: a }, order: [...s.order, ev.id], stats, feed: feed('Max', `appelle ${ev.name} : ${ev.task}`, 'hire') });
        if (live) sfx('spawn');
        if (live && firstOfRound) void say('equipe');
        break;
      }
      case 'act': {
        const act: ActView = { id: ev.id, kind: ev.kind, label: ev.label, detail: ev.detail, at };
        const stats = { ...s.stats };
        countStats(stats, ev);
        if (ev.who === 'chef') set({ chef: { ...s.chef, act, acts: [...s.chef.acts, act].slice(-MAX_ACTS) }, stats });
        else if (s.agents[ev.who]) {
          const a = s.agents[ev.who];
          set({ agents: { ...s.agents, [ev.who]: { ...a, act, acts: [...a.acts, act].slice(-MAX_ACTS) } }, stats });
        } else set({ stats });
        if (ev.kind !== 'plan') set({ feed: feed(agentName(ev.who), ev.label, 'act') });
        if (live && Date.now() - lastActSound > 220) { lastActSound = Date.now(); sfx(ev.kind === 'search' || ev.kind === 'web' ? 'search' : 'tick'); }
        break;
      }
      case 'act_done': {
        const mark = (acts: ActView[]) => acts.map((x) => (x.id === ev.id ? { ...x, ok: ev.ok } : x));
        if (ev.who === 'chef') set({ chef: { ...s.chef, acts: mark(s.chef.acts) } });
        else if (s.agents[ev.who]) set({ agents: { ...s.agents, [ev.who]: { ...s.agents[ev.who], acts: mark(s.agents[ev.who].acts) } } });
        break;
      }
      case 'report': {
        const a = s.agents[ev.who];
        if (!a) break;
        set({ agents: { ...s.agents, [ev.who]: { ...a, report: ev.text, status: 'reporting' } }, feed: feed(a.name, 'rend son rapport à Max', 'report') });
        if (live) sfx('paper');
        break;
      }
      case 'leave': {
        const a = s.agents[ev.who];
        if (!a) break;
        set({ agents: { ...s.agents, [ev.who]: { ...a, status: ev.ok ? 'done' : 'failed', leftAt: at, tokens: ev.tokens, tools: ev.tools } } });
        break;
      }
      case 'file': {
        const files = [...s.files.filter((f) => f.path !== ev.file.path), ev.file].sort((a, b) => a.at - b.at);
        set({ files, feed: ev.isNew ? feed(agentName(ev.file.by), `a rangé ${ev.file.name}`, 'file') : get().feed });
        if (live && ev.isNew) sfx('print');
        break;
      }
      case 'ask': {
        const ask: AskView = { requestId: ev.requestId, who: ev.who, tool: ev.tool, label: ev.label, detail: ev.detail, full: ev.full, at };
        set({ asks: { ...s.asks, [ev.requestId]: ask }, feed: feed(agentName(ev.who), ev.label, 'ask') });
        if (live) { sfx('ask'); void say('feu-vert', true); }
        break;
      }
      case 'ask_done': {
        const asks = { ...s.asks };
        delete asks[ev.requestId];
        set({ asks });
        break;
      }
      case 'end': {
        const workMs = s.workMs + (s.busySince ? Math.max(0, at - s.busySince) : 0);
        set({
          final: { ok: ev.ok, text: ev.text, ms: ev.ms, stopped: ev.stopped, at }, busySince: null, workMs, asks: {},
          showFinal: false, feed: feed('Max', ev.ok ? 'Mission accomplie !' : ev.stopped ? 'Mission arrêtée.' : 'La mission s’est mal terminée.', 'end'),
        });
        if (live) sfx(ev.ok ? 'done' : 'error');
        if (live && ev.ok) setTimeout(() => { void say('accomplie', true); }, 900);
        // d'abord Max fait la fête (confettis), puis la carte du rendu s'ouvre
        if (live && ev.ok) setTimeout(() => { if (get().final?.at === at) set({ showFinal: true }); }, 3200);
        break;
      }
      case 'error':
        set({ feed: feed('Max', ev.message, 'error') });
        if (live) get().toast('error', ev.message);
        break;
      case 'note':
        set({ feed: feed(agentName(ev.who), ev.text, ev.level === 'info' ? 'act' : 'error') });
        break;
      case 'state':
        if (ev.state === 'crashed' || ev.state === 'blocked') set({ feed: feed(agentName(ev.who), ev.reason || (ev.state === 'crashed' ? 'a planté' : 'est bloqué'), 'error') });
        if (live && ev.state === 'crashed') sfx('error');
        break;
      case 'model':
        if (ev.from) set({ feed: feed(agentName(ev.who), `passe de ${ev.from} à ${ev.model}${ev.reason ? ` (${ev.reason})` : ''}`, 'act') });
        break;
    }
    bus.emit(ev, live);
  },
}));

/** Les membres de l'équipe, dans l'ordre où ils sont arrivés. */
export const teamList = (s: S) => s.order.map((id) => s.agents[id]).filter(Boolean);
