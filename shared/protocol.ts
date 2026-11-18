// Le contrat entre le bureau (navigateur) et le pont (serveur Node qui pilote Claude Code).
// Tout passe par une seule connexion WebSocket, en JSON. Syntaxe « effaçable » uniquement :
// ce fichier est lu tel quel par Node (sans compilation) et par Vite.

/**
 * Les pôles du bureau. « chef » = Max, l'agent principal, celui à qui tu parles.
 * (Les anciennes missions peuvent contenir « analyse » : il est rangé dans Recherche, voir normRole.)
 */
export type Role = 'chef' | 'recherche' | 'design' | 'code' | 'relecture' | 'redaction' | 'renfort';

/** Les six pôles qu'on règle (le renfort, c'est un agent inconnu du bureau). */
export type Pole = Exclude<Role, 'renfort'>;

/** Ce que fait un agent à un instant : sert à l'animation, à l'icône et à la bulle. */
export type ActKind = 'search' | 'web' | 'read' | 'write' | 'edit' | 'bash' | 'plan' | 'skill' | 'mcp' | 'other';

export interface PlanItem { text: string; status: 'pending' | 'in_progress' | 'completed' }

/** Un fichier produit par l'équipe, dans le dossier de la mission. */
export interface FileInfo { path: string; name: string; ext: string; size: number; at: number; by: string }

export interface MissionStats { agents: number; searches: number; pages: number; reads: number; writes: number; commands: number }

export type MissionStatus = 'working' | 'done' | 'stopped' | 'error';

export interface MissionInfo {
  id: string;
  title: string;
  prompt: string;
  /** le dossier de la mission, sur ton ordinateur */
  folder: string;
  createdAt: number;
  endedAt?: number;
  /** temps de travail cumulé (toutes les reprises comprises) */
  workMs: number;
  status: MissionStatus;
  sessionId?: string;
  model?: string;
  stats: MissionStats;
  files: FileInfo[];
  /** le dernier message du chef, une fois la mission rendue */
  final?: string;
  /** « Ignorer le garde-fou pour cette demande » (avec confirmation) */
  bypass?: boolean;
  /** le projet (dossier existant) sur lequel travaille la demande */
  projectId?: string;
  /** la branche de travail de la demande (bureau/…) */
  branch?: string;
}

/**
 * Ce qui se passe dans le bureau. `who` vaut « chef » ou l'identifiant d'un agent de l'équipe
 * (l'identifiant de l'appel Agent qui l'a fait venir).
 */
export type OfficeEvent =
  | { k: 'start'; text: string }
  | { k: 'init'; model: string; auth: string }
  | { k: 'think'; who: string }
  | { k: 'typing'; who: string; text: string }
  | { k: 'say'; who: string; text: string }
  | { k: 'plan'; items: PlanItem[] }
  | { k: 'hire'; id: string; role: Role; type: string; name: string; task: string; prompt: string }
  | { k: 'act'; who: string; id: string; kind: ActKind; tool: string; label: string; detail: string }
  | { k: 'act_done'; who: string; id: string; ok: boolean }
  /** le rapport qu'un agent rend au chef */
  | { k: 'report'; who: string; text: string }
  /** un agent a fini son travail et quitte son poste */
  | { k: 'leave'; who: string; ok: boolean; tokens: number; tools: number; ms: number }
  | { k: 'file'; file: FileInfo; isNew: boolean }
  /** full = la bulle montre l'action en entier (sinon, on répond dans le panneau, où tout est affiché) */
  | { k: 'ask'; who: string; requestId: string; tool: string; label: string; detail: string; full: boolean }
  | { k: 'ask_done'; requestId: string; allow: boolean; cancelled?: boolean }
  | { k: 'end'; ok: boolean; text: string; ms: number; stopped?: boolean }
  /** une note du bureau dans le journal d'un agent (un appel refusé par le garde-fou, une relance…) */
  | { k: 'note'; who: string; text: string; level: 'info' | 'warn' | 'error' }
  /** un changement d'état noté par le bureau (bloqué, planté, en attente d'une place, pause café…) */
  | { k: 'state'; who: string; state: AgentState; reason?: string }
  /** le modèle et la puissance d'un agent ; « from » = une bascule (le quota de l'autre modèle est plein) */
  | { k: 'model'; who: string; model: string; effort: string; from?: string; reason?: string }
  | { k: 'error'; message: string };

/**
 * L'état d'un agent, pour sa pastille : il travaille, attend ta réponse (ou une place libre), fait la pause café,
 * est bloqué (rien depuis longtemps), a planté, ou a fini.
 */
export type AgentState = 'working' | 'waiting' | 'queued' | 'pause' | 'blocked' | 'crashed' | 'done';

/** Un événement daté, tel qu'il est enregistré. */
export interface Logged { at: number; ev: OfficeEvent }

export interface ClaudeInfo { found: boolean; version?: string; path?: string }

/** Une version enregistrée d'un fichier rendu (à chaque modification par l'équipe). */
export interface VersionInfo { id: string; at: number; size: number; by: string }

/** Un passage d'un agent au bureau (pour l'historique de l'équipe). */
export interface TeamEntry {
  missionId: string;
  missionTitle: string;
  at: number;
  id: string;
  name: string;
  role: Role;
  task: string;
  status: 'working' | 'done' | 'failed';
  tools: number;
  tokens: number;
  ms: number;
  report: string;
}

export type { Settings } from './settings.ts';
import type { Settings } from './settings.ts';

/** L'énergie de l'abonnement : part utilisée (0-1) de la fenêtre de 5 h et de celle de la semaine, et leur recharge (secondes). */
export interface Quota {
  fiveHour: number; resetsAt: number | null; sevenDay?: number; sevenDayResetsAt?: number | null;
  /** les limites propres à un modèle (rateLimitType seven_day_opus, seven_day_sonnet…), quand Claude Code les donne */
  models?: Record<string, { used: number; resetsAt: number | null }>;
}

/** Un projet : un dossier existant (souvent un dépôt git) dans lequel l'équipe travaille. */
export interface ProjectInfo {
  id: string;
  name: string;
  /** le dossier du projet, sur ton ordinateur */
  path: string;
  /** read = lecture seule ; branch = code sur une branche (commits locaux) ; push = code + push */
  access: 'read' | 'branch' | 'push';
  /** la branche de base (dev si elle existe, sinon main) */
  base: string;
  /** les branches où l'équipe ne commite, ne pousse et ne merge jamais */
  forbidden: string[];
  /** les commandes du projet (lint, typage, tests, build, merge), détectées puis confirmées */
  commands: { name: string; cmd: string; confirmed: boolean }[];
  /** ce que Max lit avant chaque demande */
  readFirst: string[];
  /** le carnet : '' = celui du bureau (Projets/<projet>/carnet.md), sinon un fichier du dépôt (son backlog) */
  backlogFile: string;
  createdAt: number;
  /** calculé à chaque envoi : */
  isGit?: boolean;
  branches?: string[];
  author?: string;
  hookOk?: boolean;
  map?: { commit: string; at: number } | null;
  busy?: boolean;
  missionId?: string;
}

/** La pause café en cours : quelle demande, et quand elle reprend (ms). */
export interface PauseInfo { missionId: string; resumeAt: number }

/** Telegram : relié ou pas (le jeton et le chat ne quittent jamais le serveur). */
export interface TelegramStatus { linked: boolean; step: 'none' | 'token' | 'start' | 'test' | 'linked'; botName?: string; error?: string }

// ── Navigateur → serveur ──
export type ClientMsg =
  | { t: 'start'; prompt: string; bypass?: boolean; projectId?: string }
  | { t: 'say'; text: string }
  | { t: 'stop' }
  | { t: 'answer'; requestId: string; allow: boolean }
  | { t: 'new' }
  | { t: 'open'; missionId: string; file?: string }
  /** ouvre le dossier du bureau (ou son règlement) */
  | { t: 'open_root'; rules?: boolean }
  | { t: 'read'; missionId: string; file: string; version?: string }
  | { t: 'versions'; missionId: string; file: string }
  | { t: 'team_history' }
  | { t: 'replay'; missionId: string }
  | { t: 'settings'; settings: Partial<Settings> }
  /** relancer un agent planté (bouton « Relancer » de sa fiche) */
  | { t: 'relaunch'; who: string };

// ── Serveur → navigateur ──
export type ServerMsg =
  | { t: 'hello'; claude: ClaudeInfo; dir: string; settings: Settings; quota: Quota | null; missions: MissionInfo[]; current: { mission: MissionInfo; log: Logged[] } | null; build?: string; pause: PauseInfo | null }
  | { t: 'pause'; pause: PauseInfo | null }
  | { t: 'mission'; mission: MissionInfo }
  | { t: 'ev'; missionId: string; at: number; ev: OfficeEvent }
  | { t: 'closed'; missionId: string }
  | { t: 'replay'; mission: MissionInfo; log: Logged[] }
  | { t: 'file_text'; missionId: string; file: string; text: string; truncated: boolean; version?: string }
  | { t: 'versions'; missionId: string; file: string; list: VersionInfo[] }
  | { t: 'team_history'; entries: TeamEntry[] }
  | { t: 'quota'; quota: Quota }
  | { t: 'settings'; settings: Settings }
  | { t: 'telegram'; status: TelegramStatus }
  | { t: 'toast'; kind: 'info' | 'error'; text: string };
