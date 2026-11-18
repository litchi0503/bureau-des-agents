// Les projets : des dossiers existants (souvent des dépôts git) où l'équipe travaille. Le bureau détecte ce
// qu'il peut (branches, auteur, commandes, docs, backlog), prépare la branche de travail de chaque demande,
// installe le hook qui retire les signatures d'IA, et tient un verrou (une seule demande à la fois par projet).
// La carte et le carnet du projet sont rangés hors du dépôt : <bureau>/Projets/<projet>/.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectInfo } from '../shared/protocol.ts';

export function git(cwd: string, args: string[], timeout = 20000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) => resolve({ ok: !e, out: String(out ?? '').trim(), err: String(err ?? '').trim() }));
  });
}

/** Le script commit-msg : retire Co-Authored-By, Claude-Session, « Generated with »… (même règle que le bureau). */
export const COMMIT_MSG_HOOK = `#!/bin/sh
# Installé par le Bureau des agents : retire toute signature d'IA du message de commit.
f="$1"
tmp="$f.tmp.$$"
grep -viE '^(co-authored-by:|claude-session:)|generated with|🤖 generated|noreply@anthropic\\.com' "$f" > "$tmp" || true
awk 'NF{n=NR} {l[NR]=$0} END{for(i=1;i<=n;i++) print l[i]}' "$tmp" > "$f"
rm -f "$tmp"
`;

/** Une signature d'IA dans un message de commit ? */
export const AI_SIGNATURE = /^(co-authored-by:.*(claude|anthropic|ai\b|bot)|claude-session:)|generated with (claude|ai)|noreply@anthropic\.com/im;

/** Un nom de dossier sûr (pour Projets/<projet>/). */
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60) || 'projet';

/** Un morceau de nom de branche : « Ajoute une fonction et son test » → « ajoute-une-fonction-et-son ». */
export function slug(text: string, max = 32): string {
  const s = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= max) return s || 'demande';
  return (s.slice(0, max).replace(/-[^-]*$/, '') || s.slice(0, max)).replace(/-+$/, '');
}

/** Les commandes du projet, lues dans package.json, composer.json, Makefile et scripts/. */
export function detectCommands(dir: string): { name: string; cmd: string; confirmed: boolean }[] {
  const out: { name: string; cmd: string; confirmed: boolean }[] = [];
  const add = (name: string, cmd: string) => { if (!out.some((c) => c.name === name)) out.push({ name, cmd, confirmed: false }); };
  const pkg = (() => { try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } })();
  if (pkg?.scripts) {
    const s = pkg.scripts as Record<string, string>;
    const runner = existsSync(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(dir, 'yarn.lock')) ? 'yarn' : 'npm run';
    const run = (k: string) => (runner === 'npm run' && k === 'test' ? 'npm test' : `${runner} ${k}`);
    const first = (...keys: string[]) => keys.find((k) => s[k]);
    const lint = first('lint', 'lint:all'); if (lint) add('Lint', run(lint));
    const types = first('typecheck', 'type-check', 'types', 'tsc', 'check'); if (types) add('Typage', run(types));
    if (s.test) add('Tests', run('test'));
    if (s.build) add('Build', run('build'));
    const merge = Object.keys(s).find((k) => /^merge/.test(k)); if (merge) add('Merge', run(merge));
  }
  const composer = (() => { try { return JSON.parse(readFileSync(path.join(dir, 'composer.json'), 'utf8')); } catch { return null; } })();
  if (composer?.scripts) {
    for (const [k, name] of [['lint', 'Lint'], ['phpstan', 'Typage'], ['analyse', 'Typage'], ['test', 'Tests']] as const) if (composer.scripts[k]) add(name, `composer ${k}`);
  }
  try {
    const mk = readFileSync(path.join(dir, 'Makefile'), 'utf8');
    for (const [t, name] of [['lint', 'Lint'], ['check', 'Typage'], ['test', 'Tests'], ['build', 'Build']] as const) if (new RegExp(`^${t}:`, 'm').test(mk)) add(name, `make ${t}`);
  } catch { /* pas de Makefile */ }
  try {
    for (const f of readdirSyncSafe(path.join(dir, 'scripts'))) if (/^merge/i.test(f)) add('Merge', /\.sh$/.test(f) ? `bash scripts/${f}` : `scripts/${f}`);
  } catch { /* pas de dossier scripts */ }
  return out;
}

function readdirSyncSafe(d: string): string[] {
  try { return statSync(d).isDirectory() ? readdirSync(d) : []; } catch { return []; }
}

/** Ce que Max lit avant chaque demande (par défaut : CLAUDE.md, README.md, docs/, s'ils existent). */
export function detectReadFirst(dir: string): string[] {
  return ['CLAUDE.md', 'README.md', 'docs/'].filter((f) => existsSync(path.join(dir, f)));
}

/** Un backlog déjà présent dans le dépôt (Max le tiendra dans son format). */
export function detectBacklog(dir: string): string {
  return ['docs/agent/BACKLOG.md', 'BACKLOG.md', 'docs/BACKLOG.md', 'TODO.md'].find((f) => existsSync(path.join(dir, f))) ?? '';
}

/** Un nouveau projet, à partir d'un dossier. */
export async function newProject(dir: string): Promise<ProjectInfo> {
  const abs = path.resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error('Ce dossier n’existe pas.');
  const isGit = (await git(abs, ['rev-parse', '--is-inside-work-tree'])).out === 'true';
  const branches = isGit ? (await git(abs, ['branch', '--format=%(refname:short)'])).out.split('\n').filter(Boolean) : [];
  const base = branches.includes('dev') ? 'dev' : branches.includes('main') ? 'main' : branches.includes('master') ? 'master' : branches[0] ?? 'main';
  return {
    id: 'p' + Date.now().toString(36), name: path.basename(abs), path: abs, access: isGit ? 'branch' : 'read', base,
    forbidden: branches.includes('main') || !branches.length ? ['main'] : branches.includes('master') ? ['master'] : [],
    commands: detectCommands(abs), readFirst: detectReadFirst(abs), backlogFile: detectBacklog(abs), createdAt: Date.now(),
  };
}

/** Le dossier du bureau pour ce projet (carte et carnet), hors du dépôt. */
export const projectHome = (bureauDir: string, p: ProjectInfo) => path.join(bureauDir, 'Projets', safeName(p.name));

/** Le commit analysé par la carte (sa première ligne « Commit analysé : <sha> »). */
export function mapCommit(text: string): string | null {
  return /Commit analysé\s*:\s*`?([0-9a-f]{7,40})/i.exec(text)?.[1] ?? null;
}

/** Ce qu'on calcule à chaque envoi au navigateur : git, auteur, hook, carte. */
export async function enrich(p: ProjectInfo, bureauDir: string): Promise<ProjectInfo> {
  const out: ProjectInfo = { ...p };
  if (!existsSync(p.path)) return { ...out, isGit: false, branches: [] };
  out.isGit = (await git(p.path, ['rev-parse', '--is-inside-work-tree'])).out === 'true';
  if (out.isGit) {
    out.branches = (await git(p.path, ['branch', '--format=%(refname:short)'])).out.split('\n').filter(Boolean);
    const name = (await git(p.path, ['config', 'user.name'])).out;
    const email = (await git(p.path, ['config', 'user.email'])).out;
    out.author = name ? `${name}${email ? ` <${email}>` : ''}` : '';
    out.hookOk = !!(await hookPath(p.path));
  }
  const map = path.join(projectHome(bureauDir, p), 'carte.md');
  if (existsSync(map)) {
    const text = await readFile(map, 'utf8').catch(() => '');
    out.map = { commit: mapCommit(text) ?? '', at: statSync(map).mtimeMs };
  } else out.map = null;
  return out;
}

/** Le hook commit-msg actif du dépôt, s'il y en a un (son chemin). */
async function hookPath(repo: string): Promise<string | null> {
  const custom = (await git(repo, ['config', 'core.hooksPath'])).out;
  const dir = custom ? path.resolve(repo, custom) : path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'hooks'])).out || '.git/hooks');
  const f = path.join(dir, 'commit-msg');
  return existsSync(f) ? f : null;
}

/**
 * Installe le hook commit-msg du bureau s'il n'y en a pas (dans le dossier des hooks git, jamais versionné).
 * S'il y en a déjà un (le sien, ou un dossier de hooks versionné), on n'y touche pas : le bureau vérifie
 * alors les messages avant chaque push.
 */
export async function ensureCommitHook(repo: string): Promise<'installed' | 'present' | 'skipped'> {
  if (await hookPath(repo)) return 'present';
  if ((await git(repo, ['config', 'core.hooksPath'])).out) return 'skipped';
  const dir = path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'hooks'])).out || '.git/hooks');
  await mkdir(dir, { recursive: true });
  const f = path.join(dir, 'commit-msg');
  await writeFile(f, COMMIT_MSG_HOOK);
  await chmod(f, 0o755);
  return 'installed';
}

/** Les modifications non commitées (court), ou null si l'arbre est propre. */
export async function dirtyTree(repo: string): Promise<string | null> {
  const r = await git(repo, ['status', '--porcelain']);
  if (!r.ok || !r.out) return null;
  const lines = r.out.split('\n');
  return lines.slice(0, 20).map((l) => `  ${l}`).join('\n') + (lines.length > 20 ? `\n  … et ${lines.length - 20} autres` : '');
}

/**
 * Prépare la branche de travail : depuis la base à jour (origin/<base> si le dépôt distant la connaît),
 * sans jamais toucher à la base elle-même. Arbre sale : on ne change pas de branche (Max propose une sauvegarde).
 */
export async function prepareBranch(repo: string, base: string, branch: string, dirty: boolean): Promise<{ ok: boolean; note: string }> {
  const remote = (await git(repo, ['remote'])).out.split('\n').includes('origin');
  if (remote) await git(repo, ['fetch', '--quiet', 'origin', base], 60000);
  if (dirty) return { ok: false, note: `Arbre sale : la branche ${branch} sera créée après la sauvegarde.` };
  const exists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
  if (exists) {
    const r = await git(repo, ['switch', branch]);
    return { ok: r.ok, note: r.ok ? `Branche ${branch} reprise.` : r.err };
  }
  const from = remote && (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])).ok ? `origin/${base}` : base;
  const r = await git(repo, ['switch', '--no-track', '-c', branch, from]);
  return { ok: r.ok, note: r.ok ? `Branche ${branch} créée depuis ${from}.` : r.err };
}

/** Le texte de la carte, et le diff depuis son commit (court), pour les consignes de Max. */
export async function mapContext(repo: string, mapFile: string): Promise<{ map: string | null; commit: string | null; diff: string | null }> {
  const map = await readFile(mapFile, 'utf8').catch(() => null);
  if (!map) return { map: null, commit: null, diff: null };
  const commit = mapCommit(map);
  if (!commit) return { map: map.slice(0, 12000), commit: null, diff: null };
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out;
  if (head.startsWith(commit) || commit.startsWith(head)) return { map: map.slice(0, 12000), commit, diff: null };
  const stat = (await git(repo, ['diff', '--stat', `${commit}..HEAD`])).out;
  const body = (await git(repo, ['diff', `${commit}..HEAD`, '--', '.', ':(exclude)*lock*'])).out;
  const diff = `${stat}\n\n${body}`.slice(0, 8000);
  return { map: map.slice(0, 12000), commit, diff: diff.trim() || null };
}

/** Les signatures d'IA dans les commits qui vont partir (avant un push). */
export async function signaturesBeforePush(repo: string, base: string): Promise<string | null> {
  const range = (await git(repo, ['rev-parse', '--verify', '--quiet', `origin/${base}`])).ok ? `origin/${base}..HEAD` : `${base}..HEAD`;
  const log = await git(repo, ['log', '--format=%H%n%B%n--fin--', range]);
  for (const block of log.out.split('--fin--')) {
    if (AI_SIGNATURE.test(block)) return block.trim().split('\n')[0].slice(0, 10);
  }
  return null;
}

/** Le verrou des projets : une seule demande à la fois par projet. */
export class ProjectLocks {
  private held = new Map<string, string>();
  /** Prend le verrou du projet pour cette demande ; faux s'il est déjà pris par une autre. */
  acquire(projectId: string, missionId: string): boolean {
    const h = this.held.get(projectId);
    if (h && h !== missionId) return false;
    this.held.set(projectId, missionId);
    return true;
  }
  release(projectId: string, missionId?: string) {
    if (!missionId || this.held.get(projectId) === missionId) this.held.delete(projectId);
  }
  holder(projectId: string) { return this.held.get(projectId) ?? null; }
}

/** Les sous-dossiers d'un dossier (pour « Choisir… »), sans les dossiers cachés. */
export async function listDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name).sort((a, b) => a.localeCompare(b, 'fr')).slice(0, 300);
}
