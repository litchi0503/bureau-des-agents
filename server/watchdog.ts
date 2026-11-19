// La détection des agents bloqués et plantés (fonctions pures, testées dans test/watchdog.test.ts).
//   Bloqué = aucun événement de l'agent depuis le délai réglé (sauf s'il attend ta réponse ou une place).
//   Planté = processus terminé en erreur, résultat d'erreur, erreur du flux, ou limite atteinte sans repli.

/** Depuis combien de minutes l'agent est bloqué, ou 0 s'il ne l'est pas. */
export function blockedFor(now: number, lastSeen: number, delayMin: number, waiting: boolean): number {
  if (waiting) return 0;
  const min = Math.floor((now - lastSeen) / 60_000);
  return min >= delayMin ? min : 0;
}

export interface EndInfo {
  code: number | null;
  signal: string | null;
  stderr: string;
  /** l'arrêt a été demandé (bouton Arrêter, fin de journée) */
  stopping: boolean;
}

/** Pourquoi le processus de Claude Code a planté (phrase lisible), ou null s'il s'est arrêté normalement. */
export function crashReason(e: EndInfo): string | null {
  if (e.stopping) return null;
  if (e.code === 0 && e.signal === null) return null;
  const last = e.stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
  if (/limit|quota|429/i.test(last)) return `Limite atteinte : ${last.slice(0, 200)}`;
  if (/ENOENT|not found|introuvable/i.test(last)) return 'Claude Code est introuvable.';
  if (/auth|login|401|403/i.test(last)) return 'Claude Code n’est plus connecté (relance « claude » pour te reconnecter).';
  if (last) return last.slice(0, 240);
  return e.signal ? `Claude Code s’est arrêté (${e.signal}).` : `Claude Code s’est arrêté en erreur (code ${e.code}).`;
}

/** Un résultat de tour en erreur : pourquoi (null si c'est une limite d'usage, gérée à part). */
export function resultError(subtype: string, text: string): { reason: string; limit: boolean } {
  const limit = /usage limit|rate limit|limit reached|hit your limit|quota/i.test(text);
  const reason = subtype === 'error_max_turns' ? 'Trop d’étapes d’affilée (limite de tours).'
    : subtype === 'error_during_execution' ? `Erreur pendant le travail${text ? ` : ${text.slice(0, 200)}` : ''}.`
      : text.slice(0, 240) || `Erreur (${subtype}).`;
  return { reason, limit };
}
