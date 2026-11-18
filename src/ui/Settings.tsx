// Les réglages du bureau, en quatre onglets : l'Équipe (modèle, puissance, places, repli de chaque pôle),
// le Garde-fou (plafonds de l'abonnement), le Suivi (pastilles, détection, alertes, historique) et le Spectacle
// (la voix de Max, la caméra). Les changements comptent pour la prochaine demande.
import { useEffect, useState } from 'react';
import { POLES, ROLES } from '../../shared/activity.ts';
import type { Pole, Quota } from '../../shared/protocol.ts';
import {
  EFFORTS, MODELS, PRESET_TEAMS, PRESETS, presetOf, cloneTeam, type AlertSettings, type ModelId, type Settings,
} from '../../shared/settings.ts';
import { applySound } from '../audio/sound.ts';
import { sfx } from '../audio/sfx.ts';
import { savePref, useOffice } from '../state/store.ts';
import { tilde } from './format.ts';

type Tab = 'team' | 'guard' | 'follow' | 'show';
const TABS: [Tab, string][] = [['team', 'Équipe'], ['guard', 'Garde-fou'], ['follow', 'Suivi'], ['show', 'Spectacle']];

const INI: Record<Pole, string> = { chef: 'M', recherche: 'R', design: 'D', code: 'C', relecture: 'L', redaction: 'É' };
const ROLE_SUB: Record<Pole, string> = {
  chef: 'Chef et plan technique', recherche: 'Client, concurrents, docs', design: 'Maquettes, charte',
  code: 'Développement', relecture: 'Tests, comparaison maquette', redaction: 'Cahier des charges, docs',
};

export function SettingsPanel() {
  const open = useOffice((s) => s.settingsOpen);
  const settings = useOffice((s) => s.settings);
  const [tab, setTab] = useState<Tab>('team');
  const [draft, setDraft] = useState<Settings>(settings);
  // à chaque ouverture, on repart des réglages enregistrés
  useEffect(() => { if (open) setDraft(settings); }, [open, settings]);
  if (!open) return null;
  const close = () => useOffice.setState({ settingsOpen: false });
  const save = () => { sfx('click'); useOffice.getState().send({ t: 'settings', settings: draft }); close(); };
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal settings2" role="dialog" aria-label="Réglages du bureau" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><b>Réglages du bureau</b><button className="close" onClick={close} aria-label="Fermer">×</button></div>
        <nav className="set-tabs" aria-label="Onglets des réglages">
          {TABS.map(([id, label]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
        <div className="modal-body set-body">
          {tab === 'team' && <TeamTab draft={draft} setDraft={setDraft} />}
          {tab === 'guard' && <GuardTab draft={draft} setDraft={setDraft} />}
          {tab === 'follow' && <FollowTab draft={draft} setDraft={setDraft} />}
          {tab === 'show' && <ShowTab />}
        </div>
        <div className="set-foot">
          <span className="small muted">{tab === 'guard' ? 'Pourcentages lus en direct dans Claude Code.' : tab === 'follow' ? 'Historique rangé sur ton PC, dans le dossier du bureau.' : 'Compte pour la prochaine demande.'}</span>
          {tab !== 'show' ? (
            <div className="row"><button className="btn" onClick={close}>Annuler</button><button className="btn primary" onClick={save}>Enregistrer</button></div>
          ) : <button className="btn" onClick={close}>Fermer</button>}
        </div>
      </div>
    </div>
  );
}

type TabProps = { draft: Settings; setDraft: (s: Settings) => void };

function TeamTab({ draft, setDraft }: TabProps) {
  const preset = presetOf(draft.team);
  const setPole = (p: Pole, patch: Partial<Settings['team'][Pole]>) => setDraft({ ...draft, team: { ...draft.team, [p]: { ...draft.team[p], ...patch } } });
  return (
    <>
      <div className="set-row">
        <div className="set-label"><b>Préréglage</b><span>Change tous les pôles d’un coup, puis ajuste ligne par ligne.</span></div>
        <div className="seg" role="group" aria-label="Préréglage">
          {PRESETS.map((p) => <button key={p.id} className={preset === p.id ? 'on' : ''} onClick={() => setDraft({ ...draft, team: cloneTeam(PRESET_TEAMS[p.id]) })}>{p.label}</button>)}
          {!preset && <button className="on" disabled>Personnalisé</button>}
        </div>
      </div>
      <div className="team-table" role="table" aria-label="Les pôles de l’équipe">
        <div className="tt-row tt-head" role="row"><span>Pôle</span><span>Modèle</span><span>Puissance</span><span>Places</span><span>Repli si limite</span></div>
        {POLES.map((p) => {
          const c = draft.team[p];
          return (
            <div key={p} className="tt-row" role="row">
              <div className="tt-pole">
                <span className="tt-ini" style={{ background: ROLES[p].color }} aria-hidden="true">{INI[p]}</span>
                <span><b>{ROLES[p].label}</b><small>{ROLE_SUB[p]}</small></span>
              </div>
              <select aria-label={`Modèle de ${ROLES[p].label}`} value={c.model} onChange={(e) => setPole(p, { model: e.target.value as ModelId })}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <select aria-label={`Puissance de ${ROLES[p].label}`} value={c.effort} onChange={(e) => setPole(p, { effort: e.target.value as Settings['team'][Pole]['effort'] })}>
                {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
              <div className="stepper">
                {p === 'chef' ? <span className="muted small">1 (fixe)</span> : (
                  <>
                    <button aria-label="Une place de moins" disabled={c.places <= 1} onClick={() => setPole(p, { places: c.places - 1 })}>−</button>
                    <b>{c.places}</b>
                    <button aria-label="Une place de plus" disabled={c.places >= 3} onClick={() => setPole(p, { places: c.places + 1 })}>+</button>
                  </>
                )}
              </div>
              <select aria-label={`Modèle de repli de ${ROLES[p].label}`} value={c.fallback} onChange={(e) => setPole(p, { fallback: e.target.value as ModelId | 'none' })}>
                {MODELS.filter((m) => m.id !== c.model).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                <option value="none">Aucun (pause)</option>
              </select>
            </div>
          );
        })}
      </div>
      <div className="set-info">
        <i aria-hidden="true">i</i>
        <span>Chaque pôle a vraiment son modèle et sa puissance (Claude Code les règle sous-agent par sous-agent). Petites tâches (tri, résumé, recherche de fichiers) : <b>Haiku 5.5, puissance faible</b>. Le repli s’active quand le quota du modèle est plein ; la bascule est notée sur la fiche de l’agent.</span>
      </div>
      <div className="field">
        <span>Les permissions</span>
        <label className="radio"><input type="radio" checked={draft.permission === 'auto'} onChange={() => setDraft({ ...draft, permission: 'auto' })} /> L’équipe décide seule, et lève la main pour les gestes risqués</label>
        <label className="radio"><input type="radio" checked={draft.permission === 'ask'} onChange={() => setDraft({ ...draft, permission: 'ask' })} /> Elle demande avant chaque commande</label>
      </div>
    </>
  );
}

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const hhmm = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—');
const dayHhmm = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit' }) : '—');

function Gauge({ title, used, cap, foot }: { title: string; used: number | undefined; cap: number; foot: React.ReactNode }) {
  const pct = used === undefined ? null : Math.round(used * 100);
  const color = pct === null ? '#555' : pct >= cap ? '#ff7a7a' : pct >= cap - 15 ? '#ffd166' : '#3ddc97';
  return (
    <div className="gauge">
      <div className="gauge-top"><b>{title}</b><span>{pct === null ? '—' : `${pct} %`}</span></div>
      <div className="gauge-bar"><i style={{ width: `${Math.min(100, pct ?? 0)}%`, background: color }} /><em style={{ left: `${cap}%` }} aria-hidden="true" /></div>
      <span className="small muted">{foot}</span>
    </div>
  );
}

function GuardTab({ draft, setDraft }: TabProps) {
  const quota = useOffice((s) => s.quota) as Quota | null;
  const g = draft.guard;
  const set = (patch: Partial<Settings['guard']>) => setDraft({ ...draft, guard: { ...g, ...patch } });
  const fresh = (resets: number | null | undefined, used: number | undefined) => (resets && Date.now() > resets * 1000 ? 0 : used);
  const models = Object.entries(quota?.models ?? {});
  return (
    <>
      <h4 className="set-sec">En ce moment</h4>
      <div className="gauges">
        <Gauge title="Fenêtre de 5 h" used={quota ? fresh(quota.resetsAt, quota.fiveHour) : undefined} cap={g.max5h} foot={<>Plafond {g.max5h} % · reset à {hhmm(quota?.resetsAt)}</>} />
        <Gauge title="Semaine" used={quota ? fresh(quota.sevenDayResetsAt, quota.sevenDay) : undefined} cap={g.maxWeek}
          foot={<>Plafond {g.maxWeek} % · reset {dayHhmm(quota?.sevenDayResetsAt)}{models.map(([m, v]) => ` · ${m[0].toUpperCase() + m.slice(1)} : ${Math.round(v.used * 100)} % de sa limite`).join('')}</>} />
      </div>
      {!quota && <p className="small muted">Pas encore mesuré : le bureau lit ces chiffres dans Claude Code dès son lancement.</p>}
      <h4 className="set-sec">Plafonds</h4>
      <label className="slider"><span>Fenêtre de 5 h</span><input type="range" min={10} max={100} step={5} value={g.max5h} onChange={(e) => set({ max5h: Number(e.target.value) })} /><b>{g.max5h} %</b></label>
      <label className="slider"><span>Semaine</span><input type="range" min={10} max={100} step={5} value={g.maxWeek} onChange={(e) => set({ maxWeek: Number(e.target.value) })} /><b>{g.maxWeek} %</b></label>
      <h4 className="set-sec">Plafond levé à 100 %</h4>
      <div className="inline">
        <span>À partir du</span>
        <select aria-label="Jour" value={g.liftDay} onChange={(e) => set({ liftDay: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
        <span>à</span>
        <select aria-label="Heure" value={g.liftHour} onChange={(e) => set({ liftHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select>
        <span>(heure de Paris) jusqu’au reset de la semaine.</span>
      </div>
      <label className="radio"><input type="checkbox" checked={g.liftOnlyWeekend} onChange={(e) => set({ liftOnlyWeekend: e.target.checked })} /> Seulement si le reset tombe le week-end</label>
      <h4 className="set-sec">Au plafond</h4>
      <div className="set-warm">☕ Pause café : le travail en cours est sauvegardé, Max pose sa tasse, et le bureau reprend seul au reset.</div>
      <label className="inline">
        <span><b>Budget par demande</b></span>
        <select value={g.budget} onChange={(e) => set({ budget: Number(e.target.value) })}>
          <option value={0}>Sans limite</option>
          {[5, 10, 15, 25].map((b) => <option key={b} value={b}>Au plus {b} % de la semaine</option>)}
        </select>
      </label>
      <label className="radio"><input type="checkbox" checked={g.allowBypass} onChange={(e) => set({ allowBypass: e.target.checked })} /> Autoriser « Ignorer le garde-fou pour cette demande » (avec confirmation)</label>
    </>
  );
}

const STATES: [string, string, string][] = [
  ['Travaille', 'Affiche l’action en cours', '#3ddc97'], ['Attend ta réponse', 'Main levée', '#4fb3ff'],
  ['Pause café', 'Plafond atteint, reprise auto', '#c8a27a'], ['Bloqué', 'Aucune action depuis le délai', '#ff9f43'],
  ['Planté', 'Erreur ou processus arrêté', '#ff5d5d'], ['Terminé', 'Rapport rendu', '#9aa3b5'],
];
const ALERTS: [keyof AlertSettings, string][] = [['crash', 'Agent planté'], ['question', 'Question de Max'], ['pause', 'Pause café et reprise'], ['done', 'Demande terminée'], ['blocked', 'Agent bloqué'], ['model', 'Bascule de modèle']];

function FollowTab({ draft, setDraft }: TabProps) {
  const telegram = useOffice((s) => s.telegram);
  const f = draft.follow;
  const set = (patch: Partial<Settings['follow']>) => setDraft({ ...draft, follow: { ...f, ...patch } });
  const linked = !!telegram?.linked;
  return (
    <>
      <label className="set-card">
        <span><b>Pastille au-dessus de chaque robot</b><small>Son état en un coup d’œil. Un clic ouvre sa fiche.</small></span>
        <input type="checkbox" checked={f.pastilles} onChange={(e) => set({ pastilles: e.target.checked })} />
      </label>
      <h4 className="set-sec">États affichés</h4>
      <div className="states-grid">
        {STATES.map(([n, d, c]) => <div key={n}><i style={{ background: c }} aria-hidden="true" /><span><b>{n}</b><small>{d}</small></span></div>)}
      </div>
      <h4 className="set-sec">Détection</h4>
      <div className="inline">
        <span>Un agent est « bloqué » après</span>
        <select aria-label="Délai d’inactivité" value={f.blockedMin} onChange={(e) => set({ blockedMin: Number(e.target.value) })}>{[5, 10, 15, 30].map((m) => <option key={m} value={m}>{m} min</option>)}</select>
        <span>sans aucune action.</span>
      </div>
      <div className="inline">
        <span>Quand un agent plante :</span>
        <select aria-label="Action en cas de plantage" value={f.onCrash} onChange={(e) => set({ onCrash: e.target.value as Settings['follow']['onCrash'] })}>
          <option value="retry">Relancer une fois, puis m’avertir</option>
          <option value="warn">M’avertir seulement</option>
          <option value="stop">Arrêter la demande</option>
        </select>
      </div>
      <h4 className="set-sec">Alertes Telegram {!linked && <span className="muted small">(relie d’abord Telegram : icône en haut)</span>}</h4>
      <div className="alerts-grid">
        {ALERTS.map(([k, label]) => (
          <label key={k} className={`radio ${linked ? '' : 'off'}`}>
            <input type="checkbox" disabled={!linked} checked={f.alerts[k]} onChange={(e) => set({ alerts: { ...f.alerts, [k]: e.target.checked } })} /> {label}
          </label>
        ))}
      </div>
      <h4 className="set-sec">Historique</h4>
      <div className="inline">
        <span>Garder l’historique des agents</span>
        <select aria-label="Durée de conservation" value={f.keepMonths} onChange={(e) => set({ keepMonths: Number(e.target.value) })}>
          <option value={3}>3 mois</option><option value={6}>6 mois</option><option value={12}>1 an</option><option value={0}>Toujours</option>
        </select>
      </div>
    </>
  );
}

function ShowTab() {
  const voiceOn = useOffice((s) => s.voiceOn);
  const cameraAuto = useOffice((s) => s.cameraAuto);
  const claude = useOffice((s) => s.claude);
  const dir = useOffice((s) => s.dir);
  return (
    <>
      <div className="field">
        <span>Le spectacle</span>
        <label className="radio"><input type="checkbox" checked={voiceOn} onChange={(e) => { useOffice.setState({ voiceOn: e.target.checked }); savePref('voice', e.target.checked); applySound(useOffice.getState().sound); }} /> La voix de Max (« C’est parti ! », « Mission accomplie ! », la visite guidée)</label>
        <label className="radio"><input type="checkbox" checked={cameraAuto} onChange={(e) => { useOffice.setState({ cameraAuto: e.target.checked }); savePref('cameraAuto', e.target.checked); }} /> En mode tournage, la caméra suit l’action toute seule</label>
      </div>
      <p className="small muted">L’équipe ne travaille que dans le dossier de la demande (ou du projet), et ne lance jamais rien hors du bureau sans te demander.</p>
      {claude?.found && <p className="small muted">Claude Code {claude.version} · {tilde(dir)}</p>}
      <div className="keys">
        <b>Raccourcis</b>
        <span><kbd>V</kbd> cadre vertical (reel)</span>
        <span><kbd>F</kbd> mode tournage</span>
        <span><kbd>C</kbd> caméra auto</span>
        <span><kbd>T</kbd> visite guidée</span>
        <span><kbd>J</kbd> jukebox</span>
        <span><kbd>N</kbd> jour, soir, nuit</span>
        <span><kbd>M</kbd> son</span>
        <span><kbd>H</kbd> missions précédentes</span>
        <span><kbd>Échap</kbd> fermer, sortir du tournage</span>
        <span>🥚 Il y a un code secret… (pense aux vieux jeux vidéo)</span>
      </div>
    </>
  );
}
