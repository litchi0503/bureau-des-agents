// Les règles que le serveur fait respecter (via le hook PreToolUse), et pas seulement le prompt :
//   - les interdits git (push vers une branche interdite, --force, reset --hard, réécriture d'historique…) ;
//   - la Relecture ne lance que des commandes de vérification, et n'écrit que son fichier de revue ;
//   - en « Lecture seule », personne ne modifie le dépôt.
// Fonctions pures : testées dans test/policy.test.ts.
import path from 'node:path';

export interface GitContext {
  /** l'accès de l'équipe au projet */
  access: 'read' | 'branch' | 'push';
  /** la branche de base (dev, main…) */
  base: string;
  /** la branche de travail de la demande (bureau/…) */
  work: string;
  /** les branches interdites */
  forbidden: string[];
  /** la branche actuelle du dépôt (au moment de la commande) */
  current: string;
  /** le script de merge du projet, s'il y en a un (sa commande) */
  mergeScript?: string;
  /** un merge vers la base vient d'être autorisé (vérifications vertes) : on peut pousser la base */
  baseOpen?: boolean;
  /** les branches qui existent (locales et distantes, sans « origin/ ») et les tags : pour demander plutôt que refuser */
  branches?: string[];
  tags?: string[];
  /** les branches distantes déjà fusionnées dans la base (sans « origin/ ») */
  mergedRemote?: string[];
}

/** Un mot de la commande, ou un opérateur qui sépare deux commandes. */
type Tok = { w: string } | { op: string };

/** Découpe une ligne de shell en mots (guillemets, échappements) et en opérateurs (; && || | & ( ) et retours à la ligne). */
export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let cur = '';
  let has = false;
  const push = () => { if (has) out.push({ w: cur }); cur = ''; has = false; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { cur += src[++i]; has = true; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); cur += src.slice(i + 1, j < 0 ? undefined : j); has = true; i = j < 0 ? src.length : j; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) j++; j++; }
      const inner = src.slice(i + 1, j);
      // ce qui est entre $( ) ou ` ` dans des guillemets est une vraie commande : on la sort à part
      for (const sub of inner.match(/\$\(([^)]*)\)|`([^`]*)`/g) ?? []) out.push({ op: ';' }, ...lex(sub.replace(/^\$\(|\)$|`/g, '')), { op: ';' });
      cur += inner.replace(/\\(.)/g, '$1'); has = true; i = j; continue;
    }
    if (c === '`') { push(); out.push({ op: ';' }); continue; }
    if (c === '$' && src[i + 1] === '(') { push(); out.push({ op: ';' }); i++; continue; }
    if (/\s/.test(c)) { if (c === '\n') { push(); out.push({ op: ';' }); } else push(); continue; }
    if (c === '>' || c === '<') {
      // « 2>fichier », « 2>&1 », « >>fichier » : une redirection (le chiffre n'est pas un argument)
      if (has && /^\d+$/.test(cur)) { cur = ''; has = false; } else push();
      if (src[i + 1] === '&' && /\d/.test(src[i + 2] ?? '')) { i += 2; while (/\d/.test(src[i + 1] ?? '')) i++; continue; }
      if (src[i + 1] === '>') i++;
      out.push({ op: c });
      continue;
    }
    if (';&|()'.includes(c)) {
      push();
      const two = src.slice(i, i + 2);
      if (two === '&>') { out.push({ op: '>' }); i++; } else if (two === '&&' || two === '||') { out.push({ op: two }); i++; } else out.push({ op: c });
      continue;
    }
    if (c === '#' && !has) { while (i < src.length && src[i] !== '\n') i++; i--; continue; }
    cur += c; has = true;
  }
  push();
  return out;
}

/** Les commandes simples d'une ligne de shell (chacune = sa liste de mots), redirections retirées. */
export function commands(src: string, depth = 0): string[][] {
  const toks = lex(src);
  const out: string[][] = [];
  let cur: string[] = [];
  let redirect = false;
  for (const t of toks) {
    if ('op' in t) {
      if (t.op === '>' || t.op === '<') { redirect = true; continue; }
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    if (redirect) { redirect = false; continue; }
    cur.push(t.w);
  }
  if (cur.length) out.push(cur);
  // bash -c "…", sh -c "…", eval "…" : on regarde aussi dedans
  const more: string[][] = [];
  if (depth < 3) {
    for (const c of out) {
      const name = path.basename(c[0] ?? '');
      if (['bash', 'sh', 'zsh', 'dash'].includes(name)) {
        const i = c.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
        if (i > 0 && c[i + 1]) more.push(...commands(c[i + 1], depth + 1));
      }
      if (name === 'eval') more.push(...commands(c.slice(1).join(' '), depth + 1));
      if (name === 'xargs' || name === 'env' || name === 'sudo' || name === 'command' || name === 'nohup' || name === 'time' || name === 'nice') {
        const rest = c.slice(1).filter((w, k, arr) => !(w.includes('=') && !w.startsWith('-') && arr.slice(0, k).every((x) => x.includes('=') || x.startsWith('-'))) && !w.startsWith('-'));
        if (rest.length) more.push(rest);
      }
    }
  }
  return [...out, ...more];
}

/** Les mots d'un appel git, sans « git » ni ses options globales : [sous-commande, ...arguments], ou null. */
export function gitArgs(words: string[]): string[] | null {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  if (path.basename(words[i] ?? '') !== 'git') return null;
  i++;
  while (i < words.length && words[i].startsWith('-')) {
    const o = words[i];
    if (o === '-C' || o === '-c' || o === '--git-dir' || o === '--work-tree' || o === '--namespace' || o === '--exec-path') i += 2;
    else i++;
  }
  return words.slice(i);
}

const short = (w: string, letters: string) => /^-[A-Za-z]+$/.test(w) && [...letters].some((l) => w.includes(l));

/** La branche visée par un refspec (src:dst → dst ; « main » → main ; refs/heads/x → x). */
function dstOf(spec: string, current: string): string {
  const s = spec.replace(/^\+/, '');
  const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  const b = dst.replace(/^refs\/heads\//, '');
  return b === 'HEAD' || b === '' ? current : b;
}

/** Une permission à demander à ton patron : sa clé (pour « Oui pour cette demande ») et ce qu'on lui montre. */
export interface Ask { key: string; label: string }

/**
 * Une commande de shell sur ce dépôt : la raison du refus (en français), ou les permissions à demander, ou rien.
 */
export function gitVerdict(cmd: string, ctx: GitContext): { why: string | null; asks: Ask[] } {
  const forbidden = new Set(ctx.forbidden);
  const asks: Ask[] = [];
  const no = (why: string) => ({ why, asks: [] });
  for (const words of commands(cmd)) {
    if (ctx.mergeScript && words.join(' ').includes(ctx.mergeScript.trim())) {
      if (ctx.access !== 'push') return no('Le merge demande l’accès « Code + push ».');
      if (forbidden.has(ctx.base)) return no(`La branche ${ctx.base} est interdite : pas de merge.`);
      continue; // les vérifications (lint, tests…) sont faites par le serveur avant d'autoriser
    }
    const g = gitArgs(words);
    if (!g || !g.length) continue;
    const [sub, ...args] = g;
    const opts = args.filter((a) => a.startsWith('-'));
    const plain = args.filter((a) => !a.startsWith('-'));
    const has = (...names: string[]) => opts.some((o) => names.includes(o.split('=')[0]));
    const deny = (why: string) => no(why);
    switch (sub) {
      case 'push': {
        if (ctx.access !== 'push') return deny('L’accès de l’équipe à ce projet ne permet pas de pousser (il faut « Code + push »).');
        if (has('--force', '--force-with-lease', '--force-if-includes', '--mirror', '--all', '--prune') || opts.some((o) => short(o, 'f'))) return deny('Refusé par le bureau : pas de push forcé, ni de push qui réécrit ou supprime des branches en masse.');
        if (has('--no-verify')) return deny('Refusé par le bureau : pas de push qui saute les vérifications (--no-verify).');
        // git push [remote] [refspec…] : le premier mot est le dépôt distant
        const specs = plain.slice(1);
        if (specs.some((s) => s.startsWith('+'))) return deny('Refusé par le bureau : pas de push forcé.');
        const del = has('--delete') || opts.some((o) => short(o, 'd'));
        // une suppression de branche distante : seulement une branche déjà fusionnée dans la base, et avec ton accord
        const gone = (del ? specs : specs.filter((s) => s.startsWith(':'))).map((s) => s.replace(/^:/, '').replace(/^refs\/heads\//, ''));
        for (const b of gone) {
          if (forbidden.has(b) || b === ctx.base) return deny(`Refusé par le bureau : on ne supprime pas la branche protégée ${b}.`);
          if (!ctx.mergedRemote?.includes(b)) return deny(`Refusé par le bureau : la branche distante ${b} n’est pas fusionnée dans ${ctx.base}, on ne la supprime pas.`);
          asks.push({ key: `delete:${b}`, label: `Supprimer la branche distante ${b} (déjà fusionnée dans ${ctx.base})` });
        }
        if (del) break;
        if (has('--tags')) asks.push({ key: 'push-tags', label: 'Pousser les tags' });
        const pushes = specs.filter((s) => !s.startsWith(':'));
        const targets = pushes.length ? pushes : specs.length || has('--tags') ? [] : [ctx.current];
        for (const spec of targets) {
          if (/^refs\/tags\//.test(spec) || ctx.tags?.includes(spec)) { asks.push({ key: `tag:${spec.replace(/^refs\/tags\//, '')}`, label: `Pousser le tag ${spec.replace(/^refs\/tags\//, '')}` }); continue; }
          const t = dstOf(spec, ctx.current);
          if (forbidden.has(t)) return deny(`Refusé par le bureau : la branche ${t} est interdite.`);
          if (t === ctx.base && !ctx.baseOpen) return deny(`Refusé par le bureau : on ne pousse sur ${ctx.base} qu’après un merge vérifié (lint, typage, tests, build verts). Pousse la branche ${ctx.work}.`);
          if (t === ctx.base || t === ctx.work || t.startsWith('bureau/')) continue;
          if (ctx.branches && !ctx.branches.includes(t)) return deny(`Refusé par le bureau : la branche ${t} n’existe pas. Seule la branche de travail (${ctx.work}) peut être créée.`);
          asks.push({ key: `push:${t}`, label: `Pousser la branche ${t}` });
        }
        break;
      }
      case 'commit':
        if (ctx.access === 'read') return deny('Accès en lecture seule : pas de commit.');
        if (has('--amend')) return deny('Refusé par le bureau : pas de réécriture d’historique (--amend).');
        if (has('--no-verify') || opts.some((o) => short(o, 'n') && !o.startsWith('--'))) return deny('Refusé par le bureau : pas de commit qui saute les vérifications (--no-verify).');
        if (has('--author')) return deny('Refusé par le bureau : l’auteur des commits reste celui du dépôt.');
        if (forbidden.has(ctx.current)) return deny(`Refusé par le bureau : on ne commite pas sur ${ctx.current} (branche interdite).`);
        if (ctx.current === ctx.base) return deny(`Refusé par le bureau : on ne commite pas sur ${ctx.base}. Passe sur ${ctx.work}.`);
        break;
      case 'reset':
        if (has('--hard', '--merge', '--keep')) return deny('Refusé par le bureau : pas de reset --hard (on ne jette jamais rien).');
        break;
      case 'rebase': case 'filter-branch': case 'filter-repo': case 'replace': case 'update-ref':
        return deny(`Refusé par le bureau : pas de réécriture d’historique (git ${sub}).`);
      case 'reflog':
        if (plain[0] === 'expire' || plain[0] === 'delete') return deny('Refusé par le bureau : on ne touche pas au reflog.');
        break;
      case 'gc':
        if (opts.some((o) => o.startsWith('--prune'))) return deny('Refusé par le bureau : pas de nettoyage qui supprime des commits.');
        break;
      case 'clean':
        if (!has('--dry-run') && !opts.some((o) => short(o, 'n'))) return deny('Refusé par le bureau : git clean supprime des fichiers (on ne jette jamais rien).');
        break;
      case 'stash':
        if (plain[0] === 'drop' || plain[0] === 'clear') return deny('Refusé par le bureau : on ne jette pas une remise (stash).');
        break;
      case 'restore':
        if (!has('--staged') || has('--worktree')) return deny('Refusé par le bureau : git restore jette des modifications (on ne jette jamais rien).');
        break;
      case 'checkout': case 'switch':
        if (has('--force', '--discard-changes') || opts.some((o) => short(o, 'f'))) return deny('Refusé par le bureau : pas de checkout forcé (il jette des modifications).');
        if (sub === 'checkout' && (args.includes('--') || plain.includes('.'))) return deny('Refusé par le bureau : ce checkout jetterait des modifications.');
        if (sub === 'checkout' && opts.some((o) => short(o, 'B'))) return deny('Refusé par le bureau : checkout -B réécrit une branche.');
        break;
      case 'branch': {
        const del = has('--delete') || opts.some((o) => short(o, 'dD'));
        const force = has('--force') || opts.some((o) => short(o, 'fDM'));
        const move = has('--move') || opts.some((o) => short(o, 'mM'));
        if ((del || force || move) && plain.some((b) => forbidden.has(b) || b === ctx.base)) return deny('Refusé par le bureau : on ne supprime ni ne déplace une branche protégée.');
        if (opts.some((o) => short(o, 'D')) || (del && force)) return deny('Refusé par le bureau : pas de suppression forcée de branche (demande d’abord l’accord).');
        break;
      }
      case 'merge':
        if (has('--abort') || has('--continue')) break;
        if (ctx.access !== 'push') return deny('Le merge demande l’accès « Code + push ».');
        if (forbidden.has(ctx.current)) return deny(`Refusé par le bureau : jamais de merge vers ${ctx.current} (branche interdite).`);
        if (ctx.current === ctx.base && ctx.mergeScript) return deny(`Refusé par le bureau : pour merger vers ${ctx.base}, passe par le script de merge du projet (${ctx.mergeScript}).`);
        break;
      case 'pull':
        if (has('--rebase', '--force') || opts.some((o) => short(o, 'rf'))) return deny('Refusé par le bureau : pas de pull qui réécrit l’historique.');
        break;
      case 'config':
        if (plain.some((a) => /^(user\.|core\.hookspath|author\.|committer\.)/i.test(a)) && plain.length > 1) return deny('Refusé par le bureau : l’auteur des commits et les hooks du dépôt ne se changent pas.');
        break;
      case 'tag':
        if (has('--delete', '--force') || opts.some((o) => short(o, 'df'))) return deny('Refusé par le bureau : on ne supprime ni ne remplace un tag.');
        break;
    }
    // git -c user.name=… / -c core.hooksPath=… : changer l'auteur ou sauter les hooks
    const i = words.indexOf('-c');
    if (i >= 0 && /^(user\.|core\.hookspath|author\.|committer\.)/i.test(words[i + 1] ?? '')) return deny('Refusé par le bureau : l’auteur des commits et les hooks du dépôt ne se changent pas.');
  }
  return { why: null, asks };
}

/** Une commande de shell est-elle permise sur ce dépôt ? La raison du refus, ou null (les permissions à demander comprises). */
export function checkGit(cmd: string, ctx: GitContext): string | null {
  return gitVerdict(cmd, ctx).why;
}

/** Est-ce une commande qui merge vers la base (git merge sur la base, ou le script de merge) ? */
export function isMergeToBase(cmd: string, ctx: GitContext): boolean {
  for (const words of commands(cmd)) {
    if (ctx.mergeScript && words.join(' ').includes(ctx.mergeScript.trim())) return true;
    const g = gitArgs(words);
    if (g?.[0] === 'merge' && !g.includes('--abort') && ctx.current === ctx.base) return true;
  }
  return false;
}

const CHECK_SCRIPT = /^(lint|test|tests|check|typecheck|type-check|types|tsc|build|format:check|prettier:check|e2e|ci)(:[\w:-]+)?$/i;

/** La Relecture ne lance que des commandes de vérification (lint, typage, tests, build, lecture du dépôt). */
export function checkReviewBash(cmd: string): string | null {
  for (const words of commands(cmd)) {
    let w = words;
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    const name = path.basename(w[0] ?? '');
    const a = w.slice(1);
    const ok = (() => {
      switch (name) {
        case 'npm': case 'pnpm': case 'yarn': case 'bun':
          if (a[0] === 'test' || a[0] === 't') return true;
          if (a[0] === 'run' || a[0] === 'run-script') return CHECK_SCRIPT.test(a[1] ?? '');
          return name !== 'npm' && CHECK_SCRIPT.test(a[0] ?? '');
        case 'npx': case 'pnpx': {
          const tool = a.find((x) => !x.startsWith('-')) ?? '';
          return ['tsc', 'eslint', 'vitest', 'jest', 'prettier', 'playwright', 'stylelint', 'biome', 'mocha'].includes(tool) && !a.includes('--write') && !a.includes('--fix');
        }
        case 'node': return a[0] === '--test' || a.includes('--test');
        case 'tsc': case 'vitest': case 'jest': case 'pytest': case 'phpunit': case 'phpstan': case 'mocha': return true;
        case 'eslint': case 'prettier': case 'stylelint': case 'biome': case 'ruff': return !a.some((x) => x === '--fix' || x === '--write' || x === 'format');
        case 'composer': return ['test', 'lint', 'check', 'phpstan', 'validate'].includes(a[0] ?? '');
        case 'make': return a.length > 0 && a.every((t) => CHECK_SCRIPT.test(t));
        case 'php': return a[0] === '-l' || /phpunit|phpstan/.test(a.join(' '));
        case 'python': case 'python3': return a[0] === '-m' && ['pytest', 'unittest', 'mypy', 'ruff', 'flake8'].includes(a[1] ?? '');
        case 'git': {
          const g = gitArgs(w) ?? [];
          if (g[0] === 'branch') return g.slice(1).every((x) => ['-a', '-r', '--list', '-v', '-vv', '--show-current', '--merged', '--no-merged'].includes(x));
          return ['status', 'diff', 'log', 'show', 'rev-parse', 'blame', 'ls-files', 'shortlog', 'describe'].includes(g[0] ?? '');
        }
        case 'ls': case 'cat': case 'head': case 'tail': case 'wc': case 'grep': case 'rg': case 'diff': case 'echo': case 'pwd': case 'true': case 'test': case 'stat': case 'file': case 'sort': case 'uniq': case 'jq': case 'tree': case 'which': case 'cd':
          return true;
        case 'find': return !a.some((x) => ['-delete', '-exec', '-execdir', '-ok', '-fprint'].includes(x));
        case 'sed': return a.includes('-n') && !a.some((x) => x.startsWith('-i'));
        // avant la suite de tests : la base et les services répondent-ils ?
        case 'pg_isready': return true;
        case 'redis-cli': case 'docker': case 'docker-compose': return readOnly(w);
        case 'curl': {
          const o = a.indexOf('-o');
          return a.some((x) => LOCAL_URL.test(x)) && !a.some((x) => URLISH.test(x) && !LOCAL_URL.test(x))
            && !a.some((x) => ['-T', '--upload-file', '-d', '--data', '--data-raw', '-F', '--form', '-X', '--request', '-K', '--config'].includes(x.split('=')[0]))
            && (o < 0 || a[o + 1] === '/dev/null');
        }
        default: return false;
      }
    })();
    if (!ok) return `Le pôle Relecture ne lance que des commandes de vérification (lint, typage, tests, build, git status/diff/log). « ${w.join(' ').slice(0, 80)} » est refusé.`;
  }
  return null;
}

/** La Relecture n'écrit que son fichier de revue. */
export function checkReviewWrite(file: string): string | null {
  return /^(revue|relecture)[\w.-]*\.md$/i.test(path.basename(file)) ? null : 'Le pôle Relecture ne modifie pas les fichiers : il écrit seulement son fichier de revue (revue.md).';
}

/** En lecture seule, aucun fichier du dépôt n'est modifié (les rendus vont dans le dossier de la demande). */
export function checkReadOnlyWrite(file: string, repo: string): string | null {
  const abs = path.resolve(repo, file);
  return abs === repo || abs.startsWith(repo + path.sep) ? 'Accès en lecture seule : on ne modifie pas le dépôt. Range ce fichier dans le dossier de la demande.' : null;
}

// ── Les commandes de shell : lecture seule (permise sans question), à demander, ou refusée ──

export interface ShellContext {
  /** le dossier où la commande est lancée */
  cwd: string;
  /** les dossiers où l'équipe peut écrire (le projet, le dossier de la demande) */
  dirs: string[];
  home: string;
  /** refuser une redirection vers un fichier hors de ces dossiers (dans un projet) */
  strictRedirects?: boolean;
  /** les paquets déjà présents dans package.json (leur installation n'est pas « nouvelle ») */
  known?: ReadonlySet<string>;
}

export type ShellVerdict =
  | { kind: 'read' }
  | { kind: 'ask'; asks: Ask[] }
  | { kind: 'deny'; why: string }
  | { kind: 'pass' };

const READ_GIT = new Set(['status', 'log', 'show', 'diff', 'ls-tree', 'ls-files', 'grep', 'rev-parse', 'merge-base', 'check-ignore', 'fetch', 'blame', 'shortlog', 'describe', 'rev-list', 'cat-file']);
const BRANCH_LIST = new Set(['-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--merged', '--no-merged', '--contains', '--no-contains', '--color', '--no-color', '--sort', '--format', '--points-at']);
const TAG_LIST = new Set(['-l', '--list', '-n', '--sort', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--color']);
const SIMPLE_READ = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'cut', 'diff', 'file', 'stat', 'echo', 'printf', 'pwd', 'true', 'false', 'test', '[', 'basename', 'dirname', 'realpath', 'readlink', 'which', 'tree', 'du', 'date', 'jq', 'tr', 'column', 'nl', 'cd', 'xargs', 'env', 'command', 'time', 'nice', 'pg_isready']);
/** du JavaScript qui écrit, supprime ou lance des commandes */
const JS_WRITES = /\b(write|append|rm|unlink|rmdir|mkdir|rename|copy|cp|truncate|chmod|chown|symlink|link|utimes|createWriteStream|mkdtemp)(File)?(Sync)?\s*\(|child_process|\bspawn|\bexec|\bfork\s*\(|process\.binding|require\s*\(\s*['"`]http|\bfetch\s*\(|import\s*\(/;
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;
const URLISH = /^[a-z]+:\/\/|^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/i;

function shortHas(w: string, l: string) { return /^-[A-Za-z]+$/.test(w) && w.includes(l); }

/** Une commande simple est-elle en lecture seule ? */
function readOnly(words: string[]): boolean {
  let w = words;
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
  if (!w.length) return true;
  const name = path.basename(w[0]);
  const a = w.slice(1);
  const opts = a.filter((x) => x.startsWith('-'));
  const plain = a.filter((x) => !x.startsWith('-'));
  if (SIMPLE_READ.has(name)) return true;
  switch (name) {
    case 'git': {
      const g = gitArgs(w) ?? [];
      const [sub, ...ga] = g;
      const go = ga.filter((x) => x.startsWith('-'));
      const gp = ga.filter((x) => !x.startsWith('-'));
      if (go.some((o) => o.startsWith('--output') || o === '-O' || o.startsWith('--open-files-in-pager') || o === '--ext-diff')) return false;
      if (READ_GIT.has(sub ?? '')) return true;
      if (sub === 'branch') return go.every((o) => BRANCH_LIST.has(o.split('=')[0])) && (!gp.length || go.some((o) => ['-l', '--list', '--merged', '--no-merged', '--contains', '--no-contains', '--points-at'].includes(o.split('=')[0])));
      if (sub === 'tag') return go.every((o) => TAG_LIST.has(o.split('=')[0]) || /^-n\d*$/.test(o)) && (!gp.length || go.some((o) => o === '-l' || o === '--list'));
      if (sub === 'remote') return (!gp.length && go.every((o) => o === '-v' || o === '--verbose')) || gp[0] === 'get-url' || (gp[0] === 'show' && !go.length);
      return false;
    }
    case 'rg': return !opts.some((o) => o.startsWith('--pre'));
    case 'find': return !a.some((x) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(x));
    case 'sed': {
      const quiet = opts.some((o) => o === '--quiet' || o === '--silent' || shortHas(o, 'n'));
      const inPlace = opts.some((o) => o.startsWith('--in-place') || /^-[A-Za-z]*i/.test(o));
      // les commandes w (écrire un fichier) et e (lancer une commande) de sed
      const writes = plain.some((x) => /(^|[;{}\s/\d$])\s*[wWe](\s|$)/.test(x));
      return quiet && !inPlace && !writes;
    }
    case 'sort': return !opts.some((o) => o.startsWith('--output') || /^-[A-Za-z]*o/.test(o));
    case 'uniq': return plain.length <= 1;
    case 'node': {
      const i = a.findIndex((x) => x === '-e' || x === '--eval' || x === '-p' || x === '--print');
      return i >= 0 && !!a[i + 1] && !JS_WRITES.test(a[i + 1]);
    }
    case 'redis-cli': return plain[plain.length - 1]?.toLowerCase() === 'ping' && !a.some((x) => URLISH.test(x) && !LOCAL_URL.test(x));
    case 'docker': return (plain[0] === 'ps' && plain.length === 1) || (plain[0] === 'compose' && plain[plain.length - 1] === 'ps');
    case 'docker-compose': return plain[plain.length - 1] === 'ps' && plain.length === 1;
    default: return false;
  }
}

/** Les permissions à demander pour une commande simple (docker, sudo, réseau, suppression hors du projet…). */
function asksOf(words: string[], ctx: ShellContext): Ask[] {
  let w = words;
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
  const name = path.basename(w[0] ?? '');
  const a = w.slice(1);
  const plain = a.filter((x) => !x.startsWith('-'));
  const line = w.join(' ').slice(0, 120);
  switch (name) {
    case 'docker': case 'docker-compose': case 'podman':
      return [{ key: 'docker', label: `Docker : ${line}` }];
    case 'psql': case 'mysql': case 'mariadb': case 'redis-cli': case 'mongosh': case 'mongo': case 'sqlite3':
      return [{ key: name, label: `Base de données (${name}) : ${line}` }];
    case 'sudo': return [{ key: 'sudo', label: `Droits administrateur (sudo) : ${line}` }];
    case 'ssh': case 'scp': case 'rsync': case 'sftp':
      return [{ key: name, label: `Accès à une autre machine (${name}) : ${line}` }];
    case 'curl': case 'wget': {
      const hosts = a.filter((x) => URLISH.test(x) && !LOCAL_URL.test(x));
      if (!hosts.length && a.some((x) => LOCAL_URL.test(x))) return [];
      const host = (hosts[0] ?? '').replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0] || 'internet';
      return [{ key: `web:${host}`, label: `Appel réseau vers ${host} (${name})` }];
    }
    case 'rm': case 'rmdir': case 'unlink': case 'shred': {
      const out = plain.filter((x) => !insideDirs(x, ctx));
      return out.length ? [{ key: 'rm-dehors', label: `Supprimer hors du projet : ${out.slice(0, 3).join(' ')}` }] : [];
    }
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      const verb = plain[0] ?? '';
      if (!['install', 'i', 'add', 'in', 'isntall'].includes(verb)) return [];
      const pkgs = plain.slice(1).filter((p) => !ctx.known?.has(p.replace(/(.)@[^/]*$/, '$1')));
      return pkgs.length ? [{ key: `npm:${pkgs.sort().join(',')}`, label: `Installer un nouveau paquet : ${pkgs.join(', ')}` }] : [];
    }
    default: return [];
  }
}

/** Ce chemin (relatif au dossier de la commande) reste-t-il dans les dossiers permis ? */
function insideDirs(p: string, ctx: ShellContext): boolean {
  if (/[$`]/.test(p)) return false;
  if (['/dev/null', '/dev/stdout', '/dev/stderr'].includes(p)) return true;
  const abs = path.resolve(ctx.cwd, p.replace(/^~(?=\/|$)/, ctx.home));
  return ctx.dirs.some((d) => abs === d || abs.startsWith(d + path.sep));
}

/** Les fichiers visés par les redirections (> fichier, >> fichier) d'une ligne de shell. */
export function redirectTargets(src: string): string[] {
  const toks = lex(src);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const n = toks[i + 1];
    if ('op' in t && t.op === '>' && n && 'w' in n) out.push(n.w);
  }
  return out;
}

/**
 * Le verdict du bureau sur une ligne de shell (pipes et commandes composées compris) :
 *   - read : tout est en lecture seule (et les redirections restent dans le projet) : permis sans question ;
 *   - ask : un geste qui demande l'accord de ton patron (docker, sudo, réseau, suppression hors du projet…) ;
 *   - deny : une redirection hors du projet ;
 *   - pass : le reste, que Claude Code gère comme d'habitude.
 */
export function classifyBash(cmd: string, ctx: ShellContext): ShellVerdict {
  const cmds = commands(cmd);
  const outside = redirectTargets(cmd).filter((f) => !insideDirs(f, ctx));
  if (outside.length && ctx.strictRedirects) return { kind: 'deny', why: `Refusé par le bureau : une redirection écrit hors du projet et du dossier de la demande (${outside.slice(0, 2).join(', ')}).` };
  const asks = cmds.filter((w) => !readOnly(w)).flatMap((w) => asksOf(w, ctx));
  if (asks.length) return { kind: 'ask', asks: asks.filter((x, i) => asks.findIndex((y) => y.key === x.key) === i) };
  if (cmds.length && !outside.length && cmds.every(readOnly)) return { kind: 'read' };
  return { kind: 'pass' };
}

/** La raison d'un refus, suivie de ce que l'agent peut faire à la place (pour ne pas tâtonner). */
export function withHint(why: string, kind: 'git' | 'review' | 'shell' | 'refused'): string {
  const hint = kind === 'review'
    ? 'À la place : une commande de vérification équivalente (npm test, npm run lint, tsc, git diff, git status).'
    : kind === 'refused'
      ? 'Ton patron a dit non : ne réessaie pas autrement. Note-le dans ton rapport et continue sans.'
      : 'À la place : ne contourne pas le refus. Si ce geste est vraiment nécessaire, explique-le dans ton rapport : Max demandera la permission à ton patron. Pour lire l’état du dépôt, les commandes en lecture seule (git status, git log, git diff, ls, cat, grep) sont toujours permises.';
  return `${why}\n${hint}`;
}
