// La pastille au-dessus de chaque robot : un point de couleur et un texte court (son état en un coup d'œil).
// Les couleurs se distinguent aussi par leur luminosité (vert clair, bleu, brun, orange, rouge, gris).
import type { AgentState } from '../../shared/protocol.ts';
import type { useOffice } from '../state/store.ts';

type S = ReturnType<typeof useOffice.getState>;

export const PASTILLE: Record<AgentState, { label: string; color: string }> = {
  working: { label: 'Travaille', color: '#7CF0B4' },
  waiting: { label: 'Attend ta réponse', color: '#4FB3FF' },
  queued: { label: 'Attend une place', color: '#4FB3FF' },
  pause: { label: 'Pause café', color: '#B98B5E' },
  blocked: { label: 'Bloqué', color: '#FF9F43' },
  crashed: { label: 'Planté', color: '#E0412F' },
  done: { label: 'Terminé', color: '#8A90A0' },
};

const short = (t: string, n = 20) => {
  const x = t.replace(/\s«\s?(.+?)\s?»/, ' $1').replace(/^J’|^Je /, (m) => (m === 'J’' ? '' : '')).trim();
  const y = x.charAt(0).toUpperCase() + x.slice(1);
  return y.length > n ? y.slice(0, n - 1) + '…' : y;
};

/** L'état à afficher pour Max (« chef ») ou un agent, et son texte court ; null = pas de pastille. */
export function pastilleOf(who: string, s: S, now: number): { state: AgentState; text: string; color: string } | null {
  const t = s.track[who];
  const pick = (state: AgentState, text?: string) => ({ state, text: text ?? PASTILLE[state].label, color: PASTILLE[state].color });
  if (who === 'chef') {
    if (s.pause) return pick('pause');
    if (!s.mission) return null;
  } else if (!s.agents[who]) return null;
  if (Object.values(s.asks).some((a) => a.who === who)) return pick('waiting');
  const a = who === 'chef' ? null : s.agents[who];
  if (a?.status === 'done' || a?.status === 'reporting') return pick('done');
  if (a?.status === 'failed' || t?.state === 'crashed') return pick('crashed');
  if (t?.state === 'blocked') return pick('blocked', `Bloqué · ${Math.max(1, Math.round((now - (t.lastAt || t.stateAt)) / 60_000))} min`);
  if (t?.state === 'queued') return pick('queued');
  if (t?.state === 'pause') return pick('pause');
  if (who === 'chef') {
    const busy = s.busySince !== null;
    if (!busy) {
      const last = s.chef.say || s.final?.text || '';
      if (/\?\s*$|À valider\s*:/m.test(last.trim())) return pick('waiting');
      return pick('done');
    }
    if (s.chef.act && now - s.chef.act.at < 8000) return pick('working', short(s.chef.act.label));
    const working = s.order.filter((k) => s.agents[k]?.status === 'working').length;
    return pick('working', working ? 'Attend l’équipe' : s.plan.length ? 'Suit le plan' : 'Prépare le plan');
  }
  if (a?.act) return pick('working', short(a.act.label));
  return pick('working', 'S’installe');
}
