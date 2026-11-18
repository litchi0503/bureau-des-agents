// Ouvrir un dossier, un fichier ou une adresse avec l'appli par défaut de l'ordinateur.
// Sous WSL (Linux dans Windows), xdg-open ne marche pas : on passe par explorer.exe, avec le chemin
// converti pour Windows par wslpath -w. macOS et Linux gardent leur comportement habituel.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Est-ce qu'on tourne sous WSL ? */
export function isWsl(env: NodeJS.ProcessEnv = process.env, procVersion?: string): boolean {
  if (process.platform !== 'linux' && procVersion === undefined) return false;
  if (env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(procVersion ?? readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

/** La commande à lancer pour ouvrir « target » (un chemin, ou une adresse http). */
export function openCommand(target: string, opts: { textEditor?: boolean } = {}): [string, string[]] {
  if (process.platform === 'darwin') return ['open', opts.textEditor ? ['-t', target] : [target]];
  if (process.platform === 'win32') return ['explorer', [target]];
  if (isWsl()) {
    if (/^https?:\/\//.test(target)) return ['explorer.exe', [target]];
    let win = target;
    try { win = execFileSync('wslpath', ['-w', target], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { /* on garde le chemin tel quel */ }
    return ['explorer.exe', [win]];
  }
  return ['xdg-open', [target]];
}

export function openPath(target: string, opts: { textEditor?: boolean } = {}) {
  const [cmd, args] = openCommand(target, opts);
  // explorer.exe répond souvent avec un code 1 même quand tout va bien : on ignore le code de sortie
  execFile(cmd, args, () => {});
}
