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
      out.push({ op: '>' });
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
      if (t.op === '>') { redirect = true; continue; }
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

/**
 * Une commande de shell est-elle permise sur ce dépôt ? Renvoie la raison du refus (en français), ou null.
 */
export function checkGit(cmd: string, ctx: GitContext): string | null {
  const forbidden = new Set(ctx.forbidden);
  for (const words of commands(cmd)) {
    if (ctx.mergeScript && words.join(' ').includes(ctx.mergeScript.trim())) {
      if (ctx.access !== 'push') return 'Le merge demande l’accès « Code + push ».';
      if (forbidden.has(ctx.base)) return `La branche ${ctx.base} est interdite : pas de merge.`;
      continue; // les vérifications (lint, tests…) sont faites par le serveur avant d'autoriser
    }
    const g = gitArgs(words);
    if (!g || !g.length) continue;
    const [sub, ...args] = g;
    const opts = args.filter((a) => a.startsWith('-'));
    const plain = args.filter((a) => !a.startsWith('-'));
    const has = (...names: string[]) => opts.some((o) => names.includes(o.split('=')[0]));
    switch (sub) {
      case 'push': {
        if (ctx.access !== 'push') return 'L’accès de l’équipe à ce projet ne permet pas de pousser (il faut « Code + push »).';
        if (has('--force', '--force-with-lease', '--force-if-includes', '--mirror', '--all', '--delete', '--prune') || opts.some((o) => short(o, 'fd'))) return 'Refusé par le bureau : pas de push forcé, ni de push qui supprime ou réécrit des branches.';
        if (has('--no-verify')) return 'Refusé par le bureau : pas de push qui saute les vérifications (--no-verify).';
        // git push [remote] [refspec…] : le premier mot est le dépôt distant
        const specs = plain.slice(1);
        if (specs.some((s) => s.startsWith('+') || s.startsWith(':'))) return 'Refusé par le bureau : pas de push forcé ni de suppression de branche distante.';
        const targets = specs.length ? specs.map((s) => dstOf(s, ctx.current)) : [ctx.current];
        for (const t of targets) {
          if (forbidden.has(t)) return `Refusé par le bureau : la branche ${t} est interdite.`;
          if (t === ctx.base && !ctx.baseOpen) return `Refusé par le bureau : on ne pousse sur ${ctx.base} qu’après un merge vérifié (lint, typage, tests, build verts). Pousse la branche ${ctx.work}.`;
          if (t === ctx.base) continue;
          if (t !== ctx.work && !t.startsWith('bureau/')) return `Refusé par le bureau : seule la branche de travail (${ctx.work}) peut être poussée.`;
        }
        break;
      }
      case 'commit':
        if (ctx.access === 'read') return 'Accès en lecture seule : pas de commit.';
        if (has('--amend')) return 'Refusé par le bureau : pas de réécriture d’historique (--amend).';
        if (has('--no-verify') || opts.some((o) => short(o, 'n') && !o.startsWith('--'))) return 'Refusé par le bureau : pas de commit qui saute les vérifications (--no-verify).';
        if (has('--author')) return 'Refusé par le bureau : l’auteur des commits reste celui du dépôt.';
        if (forbidden.has(ctx.current)) return `Refusé par le bureau : on ne commite pas sur ${ctx.current} (branche interdite).`;
        if (ctx.current === ctx.base) return `Refusé par le bureau : on ne commite pas sur ${ctx.base}. Passe sur ${ctx.work}.`;
        break;
      case 'reset':
        if (has('--hard', '--merge', '--keep')) return 'Refusé par le bureau : pas de reset --hard (on ne jette jamais rien).';
        break;
      case 'rebase': case 'filter-branch': case 'filter-repo': case 'replace': case 'update-ref':
        return `Refusé par le bureau : pas de réécriture d’historique (git ${sub}).`;
      case 'reflog':
        if (plain[0] === 'expire' || plain[0] === 'delete') return 'Refusé par le bureau : on ne touche pas au reflog.';
        break;
      case 'gc':
        if (opts.some((o) => o.startsWith('--prune'))) return 'Refusé par le bureau : pas de nettoyage qui supprime des commits.';
        break;
      case 'clean':
        if (!has('--dry-run') && !opts.some((o) => short(o, 'n'))) return 'Refusé par le bureau : git clean supprime des fichiers (on ne jette jamais rien).';
        break;
      case 'stash':
        if (plain[0] === 'drop' || plain[0] === 'clear') return 'Refusé par le bureau : on ne jette pas une remise (stash).';
        break;
      case 'restore':
        if (!has('--staged') || has('--worktree')) return 'Refusé par le bureau : git restore jette des modifications (on ne jette jamais rien).';
        break;
      case 'checkout': case 'switch':
        if (has('--force', '--discard-changes') || opts.some((o) => short(o, 'f'))) return 'Refusé par le bureau : pas de checkout forcé (il jette des modifications).';
        if (sub === 'checkout' && (args.includes('--') || plain.includes('.'))) return 'Refusé par le bureau : ce checkout jetterait des modifications.';
        if (sub === 'checkout' && opts.some((o) => short(o, 'B'))) return 'Refusé par le bureau : checkout -B réécrit une branche.';
        break;
      case 'branch': {
        const del = has('--delete') || opts.some((o) => short(o, 'dD'));
        const force = has('--force') || opts.some((o) => short(o, 'fDM'));
        const move = has('--move') || opts.some((o) => short(o, 'mM'));
        if ((del || force || move) && plain.some((b) => forbidden.has(b) || b === ctx.base)) return 'Refusé par le bureau : on ne supprime ni ne déplace une branche protégée.';
        if (opts.some((o) => short(o, 'D')) || (del && force)) return 'Refusé par le bureau : pas de suppression forcée de branche (demande d’abord l’accord).';
        break;
      }
      case 'merge':
        if (has('--abort') || has('--continue')) break;
        if (ctx.access !== 'push') return 'Le merge demande l’accès « Code + push ».';
        if (forbidden.has(ctx.current)) return `Refusé par le bureau : jamais de merge vers ${ctx.current} (branche interdite).`;
        if (ctx.current === ctx.base && ctx.mergeScript) return `Refusé par le bureau : pour merger vers ${ctx.base}, passe par le script de merge du projet (${ctx.mergeScript}).`;
        break;
      case 'pull':
        if (has('--rebase', '--force') || opts.some((o) => short(o, 'rf'))) return 'Refusé par le bureau : pas de pull qui réécrit l’historique.';
        break;
      case 'config':
        if (plain.some((a) => /^(user\.|core\.hookspath|author\.|committer\.)/i.test(a)) && plain.length > 1) return 'Refusé par le bureau : l’auteur des commits et les hooks du dépôt ne se changent pas.';
        break;
      case 'tag':
        if (has('--delete', '--force') || opts.some((o) => short(o, 'df'))) return 'Refusé par le bureau : on ne supprime ni ne remplace un tag.';
        break;
    }
    // git -c user.name=… / -c core.hooksPath=… : changer l'auteur ou sauter les hooks
    const i = words.indexOf('-c');
    if (i >= 0 && /^(user\.|core\.hookspath|author\.|committer\.)/i.test(words[i + 1] ?? '')) return 'Refusé par le bureau : l’auteur des commits et les hooks du dépôt ne se changent pas.';
  }
  return null;
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
