// La règle du garde-fou, en une fonction pure (testée dans test/guard.test.ts) :
//   - au-delà du plafond de la fenêtre de 5 h ou de la semaine : pause café jusqu'au reset ;
//   - le plafond est levé à 100 % à partir d'un jour et d'une heure (heure de Paris) jusqu'au reset réel
//     de la semaine, et, si la case est cochée, seulement quand ce reset tombe le week-end ;
//   - une demande ne consomme pas plus que son budget (part de la semaine) : Max s'arrête et demande ;
//   - une fenêtre déjà rechargée ne compte plus.
import type { Quota } from '../shared/protocol.ts';
import type { GuardSettings } from '../shared/settings.ts';

export type GuardResult =
  | { kind: 'ok' }
  | { kind: 'pause'; window: '5h' | 'week'; used: number; cap: number; resumeAt: number }
  | { kind: 'budget'; used: number; budget: number };

const TZ = 'Europe/Paris';
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
const DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Le jour (0 = dimanche) et l'heure, à Paris. */
export function parisDayHour(ms: number): { day: number; hour: number } {
  const parts = fmt.formatToParts(new Date(ms));
  return { day: DAY[parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'], hour: Number(parts.find((p) => p.type === 'hour')?.value ?? 0) };
}

/** Le dernier moment « jour J à H h, heure de Paris » avant (ou à) maintenant, en ms. */
export function lastMoment(now: number, day: number, hour: number): number {
  const h0 = Math.floor(now / 3_600_000) * 3_600_000;
  for (let i = 0; i <= 7 * 24 + 2; i++) {
    const t = h0 - i * 3_600_000;
    const p = parisDayHour(t);
    if (p.day === day && p.hour === hour) return t;
  }
  return -Infinity;
}

/** Le plafond de la semaine est-il levé à 100 % en ce moment ? */
export function weekLifted(now: number, g: GuardSettings, weekResetMs: number | null): boolean {
  if (!weekResetMs || weekResetMs <= now) return false;
  if (g.liftOnlyWeekend) {
    const d = parisDayHour(weekResetMs).day;
    if (d !== 6 && d !== 0) return false;
  }
  // le moment de levée doit tomber dans la semaine en cours (après le reset précédent)
  const lift = lastMoment(now, g.liftDay, g.liftHour);
  return lift > weekResetMs - 7 * 86_400_000 && lift <= now;
}

export interface GuardInput {
  now: number;
  quota: Quota | null;
  guard: GuardSettings;
  /** la part de la semaine déjà utilisée quand la demande a commencé (pour le budget) */
  base?: number;
  /** « Ignorer le garde-fou pour cette demande » */
  bypass?: boolean;
}

export function guardDecision({ now, quota, guard, base, bypass }: GuardInput): GuardResult {
  if (!quota) return { kind: 'ok' };
  const fresh = (used: number | undefined, resetsAt: number | null | undefined) => (used === undefined ? undefined : resetsAt && now >= resetsAt * 1000 ? 0 : used);
  const five = fresh(quota.fiveHour, quota.resetsAt);
  const week = fresh(quota.sevenDay, quota.sevenDayResetsAt);
  const weekReset = quota.sevenDayResetsAt ? quota.sevenDayResetsAt * 1000 : null;
  const lifted = weekLifted(now, guard, weekReset);
  // ignorer le garde-fou ne va pas au-delà de 100 % : là, c'est l'abonnement lui-même qui s'arrête
  const cap5 = bypass || lifted ? 100 : guard.max5h;
  const capW = bypass || lifted ? 100 : guard.maxWeek;
  if (five !== undefined && five * 100 >= cap5) {
    return { kind: 'pause', window: '5h', used: five, cap: cap5, resumeAt: quota.resetsAt ? quota.resetsAt * 1000 : now + 5 * 3_600_000 };
  }
  if (week !== undefined && week * 100 >= capW) {
    // plafond normal atteint en semaine : on reprend au reset, ou plus tôt si le plafond se lève avant
    let resumeAt = weekReset ?? now + 24 * 3_600_000;
    if (!lifted && capW < 100 && weekReset) {
      const next = lastMoment(now + 7 * 86_400_000, guard.liftDay, guard.liftHour);
      const liftNext = next > now ? next : next + 7 * 86_400_000;
      if (liftNext < weekReset && weekLifted(liftNext, guard, weekReset) && week * 100 < 100) resumeAt = liftNext;
    }
    return { kind: 'pause', window: 'week', used: week, cap: capW, resumeAt };
  }
  if (!bypass && guard.budget > 0 && base !== undefined && week !== undefined && (week - base) * 100 >= guard.budget) {
    return { kind: 'budget', used: week - base, budget: guard.budget };
  }
  return { kind: 'ok' };
}
