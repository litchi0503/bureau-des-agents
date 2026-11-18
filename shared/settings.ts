// Les réglages du bureau : l'équipe (modèle, puissance, places, repli par pôle), le garde-fou et le suivi.
// Partagé par le serveur (qui les applique) et le navigateur (qui les affiche). Syntaxe effaçable uniquement.
import type { Pole } from './protocol.ts';

/** Les modèles qu'on peut choisir (les alias de Claude Code). */
export type ModelId = 'fable' | 'opus' | 'sonnet' | 'haiku';
/** La puissance (l'« effort » de Claude Code). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const MODELS: { id: ModelId; label: string }[] = [
  { id: 'fable', label: 'Fable 5.2' }, { id: 'opus', label: 'Opus 5.5' }, { id: 'sonnet', label: 'Sonnet 5.5' }, { id: 'haiku', label: 'Haiku 5.5' },
];
export const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Faible' }, { id: 'medium', label: 'Moyenne' }, { id: 'high', label: 'Élevée' }, { id: 'xhigh', label: 'Très élevée' }, { id: 'max', label: 'Max' },
];
export const modelLabel = (m: string) => MODELS.find((x) => x.id === m)?.label ?? (m === 'none' ? 'Aucun (pause)' : m);
export const effortLabel = (e: string) => EFFORTS.find((x) => x.id === e)?.label ?? e;

/** La famille d'un nom de modèle complet : claude-opus-5-5 → opus. */
export function modelFamily(name: string): ModelId | null {
  const n = name.toLowerCase();
  for (const m of MODELS) if (n.includes(m.id)) return m.id;
  return null;
}

export interface PoleSettings {
  model: ModelId;
  effort: Effort;
  /** combien d'agents de ce pôle en même temps (1 à 3 ; Max : toujours 1) */
  places: number;
  /** le modèle à prendre quand celui-ci n'a plus de quota ; « none » = pause café jusqu'au reset */
  fallback: ModelId | 'none';
}

export type PresetId = 'econome' | 'equilibre' | 'maximum';
export const PRESETS: { id: PresetId; label: string }[] = [{ id: 'econome', label: 'Économe' }, { id: 'equilibre', label: 'Équilibré' }, { id: 'maximum', label: 'Maximum' }];

const P = (model: ModelId, effort: Effort, places: number, fallback: ModelId | 'none'): PoleSettings => ({ model, effort, places, fallback });

export const PRESET_TEAMS: Record<PresetId, Record<Pole, PoleSettings>> = {
  equilibre: {
    chef: P('fable', 'high', 1, 'opus'),
    recherche: P('sonnet', 'medium', 2, 'haiku'),
    design: P('opus', 'high', 1, 'sonnet'),
    code: P('fable', 'xhigh', 1, 'opus'),
    relecture: P('opus', 'high', 1, 'sonnet'),
    redaction: P('sonnet', 'medium', 1, 'haiku'),
  },
  econome: {
    chef: P('opus', 'high', 1, 'sonnet'),
    recherche: P('haiku', 'medium', 1, 'none'),
    design: P('sonnet', 'medium', 1, 'haiku'),
    code: P('sonnet', 'xhigh', 1, 'haiku'),
    relecture: P('sonnet', 'medium', 1, 'haiku'),
    redaction: P('haiku', 'medium', 1, 'none'),
  },
  maximum: {
    chef: P('fable', 'xhigh', 1, 'opus'),
    recherche: P('fable', 'xhigh', 3, 'opus'),
    design: P('fable', 'xhigh', 1, 'opus'),
    code: P('fable', 'max', 1, 'opus'),
    relecture: P('fable', 'max', 1, 'opus'),
    redaction: P('fable', 'xhigh', 1, 'opus'),
  },
};

/** Le préréglage qui correspond exactement à cette équipe, ou null (« Personnalisé »). */
export function presetOf(team: Record<Pole, PoleSettings>): PresetId | null {
  for (const p of PRESETS) {
    const t = PRESET_TEAMS[p.id];
    if ((Object.keys(t) as Pole[]).every((k) => JSON.stringify(t[k]) === JSON.stringify(team[k]))) return p.id;
  }
  return null;
}

export interface GuardSettings {
  /** plafond de la fenêtre de 5 h, en % (100 = pas de plafond) */
  max5h: number;
  /** plafond de la semaine, en % */
  maxWeek: number;
  /** le plafond est levé à 100 % à partir de ce jour (0 = dimanche … 6 = samedi) et de cette heure (heure de Paris) */
  liftDay: number;
  liftHour: number;
  /** seulement si le reset de la semaine tombe le week-end */
  liftOnlyWeekend: boolean;
  /** la part de la semaine qu'une demande peut consommer, en % (0 = sans limite) */
  budget: number;
  /** autoriser « Ignorer le garde-fou pour cette demande » */
  allowBypass: boolean;
}

export type CrashPolicy = 'retry' | 'warn' | 'stop';
export interface AlertSettings { crash: boolean; question: boolean; pause: boolean; done: boolean; blocked: boolean; model: boolean }

export interface FollowSettings {
  /** la pastille au-dessus de chaque robot */
  pastilles: boolean;
  /** « Bloqué » après tant de minutes sans aucun événement */
  blockedMin: number;
  onCrash: CrashPolicy;
  alerts: AlertSettings;
  /** combien de mois on garde l'historique des agents (0 = toujours) */
  keepMonths: number;
}

export interface Settings {
  team: Record<Pole, PoleSettings>;
  /** auto : l'équipe décide seule et ne demande que pour les gestes risqués ; ask : elle demande avant chaque commande */
  permission: 'auto' | 'ask';
  guard: GuardSettings;
  follow: FollowSettings;
}

export const DEFAULT_GUARD: GuardSettings = { max5h: 80, maxWeek: 80, liftDay: 6, liftHour: 0, liftOnlyWeekend: true, budget: 0, allowBypass: false };
export const DEFAULT_FOLLOW: FollowSettings = {
  pastilles: true, blockedMin: 10, onCrash: 'retry', keepMonths: 6,
  alerts: { crash: true, question: true, pause: true, done: true, blocked: false, model: false },
};

export const cloneTeam = (t: Record<Pole, PoleSettings>) => JSON.parse(JSON.stringify(t)) as Record<Pole, PoleSettings>;

export function defaultSettings(): Settings {
  return { team: cloneTeam(PRESET_TEAMS.equilibre), permission: 'auto', guard: { ...DEFAULT_GUARD }, follow: { ...DEFAULT_FOLLOW, alerts: { ...DEFAULT_FOLLOW.alerts } } };
}

const POLE_KEYS: Pole[] = ['chef', 'recherche', 'design', 'code', 'relecture', 'redaction'];
const isModel = (v: unknown): v is ModelId => MODELS.some((m) => m.id === v);
const isEffort = (v: unknown): v is Effort => EFFORTS.some((e) => e.id === v);
const pick = <T,>(v: unknown, ok: (x: unknown) => x is T, fallback: T): T => (ok(v) ? v : fallback);
const num = (v: unknown, allowed: number[], fallback: number) => (typeof v === 'number' && allowed.includes(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const STEP5 = Array.from({ length: 19 }, (_, i) => 10 + i * 5);

/**
 * Des réglages sûrs, à partir de ce qu'envoie le navigateur (ou d'un vieux fichier) : tout ce qui est
 * inconnu ou hors des bornes garde la valeur actuelle.
 */
export function mergeSettings(cur: Settings, p: unknown): Settings {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, any>;
  const team = cloneTeam(cur.team);
  if (o.team && typeof o.team === 'object') {
    for (const k of POLE_KEYS) {
      const x = o.team[k];
      if (!x || typeof x !== 'object') continue;
      const c = team[k];
      team[k] = {
        model: pick(x.model, isModel, c.model),
        effort: pick(x.effort, isEffort, c.effort),
        places: k === 'chef' ? 1 : num(x.places, [1, 2, 3], c.places),
        fallback: x.fallback === 'none' ? 'none' : pick(x.fallback, isModel, c.fallback),
      };
    }
  }
  const g = (o.guard && typeof o.guard === 'object' ? o.guard : {}) as Record<string, unknown>;
  const f = (o.follow && typeof o.follow === 'object' ? o.follow : {}) as Record<string, any>;
  const a = (f.alerts && typeof f.alerts === 'object' ? f.alerts : {}) as Record<string, unknown>;
  return {
    team,
    permission: o.permission === 'ask' || o.permission === 'auto' ? o.permission : cur.permission,
    guard: {
      max5h: num(g.max5h, STEP5, cur.guard.max5h),
      maxWeek: num(g.maxWeek, STEP5, cur.guard.maxWeek),
      liftDay: num(g.liftDay, [0, 1, 2, 3, 4, 5, 6], cur.guard.liftDay),
      liftHour: num(g.liftHour, Array.from({ length: 24 }, (_, i) => i), cur.guard.liftHour),
      liftOnlyWeekend: bool(g.liftOnlyWeekend, cur.guard.liftOnlyWeekend),
      budget: num(g.budget, [0, 5, 10, 15, 25], cur.guard.budget),
      allowBypass: bool(g.allowBypass, cur.guard.allowBypass),
    },
    follow: {
      pastilles: bool(f.pastilles, cur.follow.pastilles),
      blockedMin: num(f.blockedMin, [5, 10, 15, 30], cur.follow.blockedMin),
      onCrash: f.onCrash === 'retry' || f.onCrash === 'warn' || f.onCrash === 'stop' ? f.onCrash : cur.follow.onCrash,
      keepMonths: num(f.keepMonths, [0, 3, 6, 12], cur.follow.keepMonths),
      alerts: {
        crash: bool(a.crash, cur.follow.alerts.crash), question: bool(a.question, cur.follow.alerts.question),
        pause: bool(a.pause, cur.follow.alerts.pause), done: bool(a.done, cur.follow.alerts.done),
        blocked: bool(a.blocked, cur.follow.alerts.blocked), model: bool(a.model, cur.follow.alerts.model),
      },
    },
  };
}
