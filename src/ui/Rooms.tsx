// Les fenêtres qu'on ouvre en cliquant dans le bureau. Tout y vient de Claude Code, pour de vrai :
// la fiche d'un agent (sa mission, chacune de ses actions, son rapport), le plan de Max et son
// historique, l'équipe et ses outils, la machine, les rendus et l'aperçu des sites créés.
import { useEffect, useMemo, useState } from 'react';
import { POLES, ROLE_TOOLS, ROLES, TOOL_INFO } from '../../shared/activity.ts';
import { effortLabel, modelLabel } from '../../shared/settings.ts';
import type { HistLine } from '../../shared/protocol.ts';
import { PASTILLE } from './pastille.ts';
import type { PlanItem, Role } from '../../shared/protocol.ts';
import { jukebox, TRACKS } from '../audio/music.ts';
import { sfx } from '../audio/sfx.ts';
import { world } from '../engine/instance.ts';
import { savePref, teamList, useOffice, type ActView, type Tod } from '../state/store.ts';
import { useShallow } from 'zustand/react/shallow';
import { fileIcon, fmtClock, fmtDate, fmtDuration, fmtSize, plural, readable, tilde } from './format.ts';
import { party } from './interact.ts';
import { mdToHtml } from './md.ts';
import { Avatar } from './Panel.tsx';
import { tidy } from './tidy.ts';

const ICON: Record<string, string> = {
  search: '🔎', web: '🌐', read: '📖', write: '✍️', edit: '✏️', bash: '💻', plan: '📋', skill: '🎓', mcp: '🔌', other: '⚙️',
};

function Shell({ title, sub, wide, children, onClose }: { title: React.ReactNode; sub?: React.ReactNode; wide?: boolean; children: React.ReactNode; onClose?: () => void }) {
  const close = onClose ?? (() => useOffice.setState({ modal: null }));
  return (
    <div className="modal-back" onClick={close}>
      <div className={`modal room ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="room-title"><b>{title}</b>{sub && <span>{sub}</span>}</div>
          <button className="close" onClick={close} aria-label="Fermer">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Les fenêtres du bureau (une seule ouverte à la fois). */
export function Rooms() {
  const modal = useOffice((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'agent': return <AgentRoom id={modal.id} missionId={modal.missionId} />;
    case 'board': return <BoardRoom />;
    case 'clock': return <ClockRoom />;
    case 'machine': return <MachineRoom />;
    case 'jukebox': return <JukeboxRoom />;
    case 'team': return <TeamRoom role={modal.role} />;
    case 'files': return <FilesRoom />;
    case 'preview': return <PreviewRoom missionId={modal.missionId} file={modal.file} />;
  }
}

// ── La fiche d'un agent (ou de Max) : son état, son modèle, sa frise, son journal, sa mission, son rapport, ses fichiers ──
const FILTERS: [string, string, (t: HistLine['type']) => boolean][] = [
  ['all', 'Tout', () => true],
  ['act', 'Actions', (t) => t === 'action' || t === 'rapport' || t === 'message'],
  ['err', 'Erreurs', (t) => t === 'erreur'],
  ['state', 'États', (t) => t === 'état' || t === 'mission' || t === 'note'],
  ['model', 'Modèle', (t) => t === 'modèle'],
];
const LINE_COLOR: Record<HistLine['type'], string> = {
  action: '#7CF0B4', rapport: '#7CF0B4', message: '#c9c9d2', erreur: '#ff6b6b', état: '#4FB3FF', mission: '#9aa3b5', note: '#ffb27a', modèle: '#c4b5fd',
};

function AgentRoom({ id, missionId: mid }: { id: string; missionId?: string }) {
  const mission = useOffice((s) => s.mission);
  const missionId = mid ?? mission?.id ?? '';
  const live = useOffice((s) => (s.mission?.id === missionId ? (id === 'chef' ? null : s.agents[id]) : undefined));
  const track = useOffice((s) => (s.mission?.id === missionId ? s.track[id] : undefined));
  const log = useOffice((s) => s.agentLogs[`${missionId}|${id}`]);
  const files = useOffice(useShallow((s) => (s.mission?.id === missionId ? s.files.filter((f) => f.by === id) : [])));
  const order = useOffice((s) => s.order);
  const agents = useOffice((s) => s.agents);
  const chef = useOffice((s) => s.chef);
  const send = useOffice((s) => s.send);
  const connection = useOffice((s) => s.connection);
  const replaying = useOffice((s) => s.replaying);
  const working = useOffice((s) => s.busySince !== null);
  const [tab, setTab] = useState<'log' | 'brief' | 'report' | 'files'>('log');
  const [filter, setFilter] = useState('all');
  const now = useNow(1000);
  // le journal vient du serveur (l'historique sur disque) ; tant que l'agent travaille, on le relit de temps en temps
  useEffect(() => {
    if (connection !== 'live' || replaying || !missionId) return;
    send({ t: 'agent_log', missionId, who: id });
    if (!working) return;
    const t = setInterval(() => send({ t: 'agent_log', missionId, who: id }), 4000);
    return () => clearInterval(t);
  }, [connection, replaying, missionId, id, working, send]);
  const entry = log?.entry ?? null;
  const isChef = id === 'chef';
  const role: Role = isChef ? 'chef' : live?.role ?? entry?.role ?? 'renfort';
  const info = ROLES[role];
  const name = isChef ? 'Max' : live?.name ?? entry?.name ?? 'Un agent';
  const task = isChef ? (mission?.id === missionId ? mission?.title : entry?.missionTitle) ?? '' : live?.task ?? entry?.task ?? '';
  const prompt = isChef ? (mission?.id === missionId ? mission?.prompt : entry?.prompt) ?? '' : live?.prompt ?? entry?.prompt ?? '';
  const report = isChef ? (mission?.id === missionId ? mission?.final : '') ?? '' : live?.report || entry?.report || '';
  const html = useMemo(() => (report ? mdToHtml(tidy(report)) : ''), [report]);
  // le poste : son rang parmi les agents du même pôle dans cette demande
  const post = isChef ? 1 : Math.max(1, order.filter((k) => agents[k]?.role === role).indexOf(id) + 1);
  const crashed = track?.state === 'crashed' || live?.status === 'failed' || entry?.status === 'crashed';
  const crashLine = log?.lines.find((l) => l.type === 'erreur');
  const since = isChef ? (track?.timeline[0]?.at ?? entry?.at ?? 0) : live?.hiredAt ?? entry?.at ?? 0;
  const until = isChef ? (working ? now : entry?.endAt ?? now) : live?.leftAt ?? (live ? now : entry?.endAt ?? now);
  const model = track?.model || entry?.model || '';
  const switched = track?.switched ?? (entry?.switched ? { from: entry.switched.split(' → ')[0], to: entry.switched.split(' → ')[1], at: 0 } : null);
  const effort = track?.effort || entry?.effort || '';
  const tokens = live?.tokens || entry?.tokens || 0;
  const lines = (log?.lines ?? []).filter((l) => FILTERS.find((f) => f[0] === filter)![2](l.type));
  // la frise : la durée passée dans chaque état
  const timeline = track?.timeline ?? [];
  const segs = timeline.map((x, i) => ({ state: x.state, w: Math.max(1, (timeline[i + 1]?.at ?? until) - x.at) }));
  const total = segs.reduce((a, x) => a + x.w, 0) || 1;
  const canRelaunch = !isChef && crashed && !replaying && connection === 'live' && mission?.id === missionId;
  const acts = isChef ? chef.acts : live?.acts ?? [];
  return (
    <Shell title={<>{info.icon} {isChef ? 'Max · chef' : `${info.label} · poste ${post}`} <span className="muted">· {name}</span></>} sub={task ? `Demande : ${task}` : undefined} wide>
      {crashed && (
        <div className="crash-banner" role="alert">
          <i aria-hidden="true" />
          <div>
            <b>Planté{track?.crashedAt ? ` à ${new Date(track.crashedAt).toLocaleTimeString('fr-FR')}` : ''}</b>
            <span>{tidy(track?.reason || crashLine?.detail || 'Il n’a pas pu finir son travail.')}</span>
          </div>
          <button className="btn small" onClick={() => { setTab('log'); setFilter('err'); }}>Voir le journal</button>
          {canRelaunch && <button className="btn small primary" onClick={() => { sfx('click'); send({ t: 'relaunch', who: id }); }}>Relancer</button>}
        </div>
      )}
      <div className="agent-facts">
        <div><span>Modèle</span><b>{switched ? `${modelLabel(switched.from)} → ${modelLabel(switched.to)}` : model ? modelLabel(model.replace(/^claude-|-\d.*$/g, '')) : '—'}</b>{switched?.at ? <small>bascule à {new Date(switched.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</small> : null}</div>
        <div><span>Puissance</span><b>{effort ? effortLabel(effort) : '—'}</b></div>
        <div><span>Durée</span><b>{since ? fmtDuration(until - since) : '—'}</b></div>
        <div><span>Consommation</span><b>{tokens ? `${tokens.toLocaleString('fr-FR')} jetons` : '—'}</b></div>
      </div>
      {segs.length > 0 && (
        <div className="frise-wrap">
          <span className="k">Frise des états</span>
          <div className="frise" role="img" aria-label={segs.map((x) => PASTILLE[x.state].label).join(', ')}>
            {segs.map((x, i) => <span key={i} title={PASTILLE[x.state].label} style={{ flex: x.w / total, background: PASTILLE[x.state].color }} />)}
          </div>
        </div>
      )}
      <nav className="sheet-tabs" aria-label="Onglets de la fiche">
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Journal</button>
        <button className={tab === 'brief' ? 'on' : ''} onClick={() => setTab('brief')}>{isChef ? 'Ta demande' : 'Mission de Max'}</button>
        <button className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')}>Rapport</button>
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>Fichiers{files.length ? ` (${files.length})` : ''}</button>
      </nav>
      {tab === 'log' && (
        <>
          <div className="chips">{FILTERS.map(([k, l]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
          {connection !== 'live' || replaying ? (acts.length ? <ActList acts={acts} /> : <p className="muted small">Le journal complet vit sur ton ordinateur (lance le bureau avec Claude Code).</p>)
            : !log ? <p className="muted small">Chargement…</p>
              : !lines.length ? <p className="muted small">Rien à montrer pour ce filtre.</p>
                : (
                  <ol className="journal">
                    {lines.slice(0, 300).map((l, i) => (
                      <li key={i}>
                        <time>{new Date(l.at).toLocaleTimeString('fr-FR')}</time>
                        <i style={{ background: LINE_COLOR[l.type] }} aria-hidden="true" />
                        <span className={l.type === 'erreur' ? 'err' : ''}>{tidy(l.detail)}{l.model ? <small> · {l.model}</small> : null}</span>
                      </li>
                    ))}
                  </ol>
                )}
        </>
      )}
      {tab === 'brief' && <p className="brief">{prompt ? tidy(prompt) : '—'}</p>}
      {tab === 'report' && (html ? <div className="md report" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="muted small">Pas encore de rapport.</p>)}
      {tab === 'files' && (files.length && mission ? <FileActions files={files} missionId={mission.id} disabled={replaying} send={send} /> : <p className="muted small">Aucun fichier rangé par {name}.</p>)}
    </Shell>
  );
}

function useNow(every: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}

function ActList({ acts }: { acts: ActView[] }) {
  return (
    <ul className="act-list">
      {acts.slice(-40).map((x) => (
        <li key={x.id} className={x.ok === false ? 'fail' : ''}>
          <i>{ICON[x.kind]}</i>
          <div>
            <span>{x.label}</span>
            {x.detail && x.detail !== x.label && <code>{(() => { const d = tidy(x.detail); return d.length > 160 ? d.slice(0, 159) + '…' : d; })()}</code>}
          </div>
          <time>{new Date(x.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        </li>
      ))}
    </ul>
  );
}

// ── Le tableau : le plan, qui fait quoi, et l'historique du plan ──
function planChanges(prev: PlanItem[] | null, next: PlanItem[]): string[] {
  if (!prev) return [`Max écrit le plan : ${plural(next.length, 'étape', 'étapes')}`];
  const out: string[] = [];
  for (const it of next) {
    const before = prev.find((p) => p.text === it.text);
    if (!before) out.push(`+ ${it.text}`);
    else if (before.status !== it.status && it.status === 'completed') out.push(`✓ ${it.text}`);
    else if (before.status !== it.status && it.status === 'in_progress') out.push(`▶ ${it.text}`);
  }
  return out;
}

function BoardRoom() {
  const plan = useOffice((s) => s.plan);
  const history = useOffice((s) => s.planHistory);
  const team = useOffice(useShallow(teamList));
  const done = plan.filter((p) => p.status === 'completed').length;
  const steps = useMemo(() => history.map((h, i) => ({ at: h.at, lines: planChanges(i ? history[i - 1].items : null, h.items) })).filter((x) => x.lines.length), [history]);
  return (
    <Shell title="Le tableau de Max" sub={plan.length ? `${done} étape${done > 1 ? 's' : ''} faite${done > 1 ? 's' : ''} sur ${plan.length}` : 'Le plan de la mission, et qui fait quoi'}>
      {plan.length > 0 ? (
        <>
          <div className="progress"><i style={{ width: `${(done / plan.length) * 100}%` }} /></div>
          <ul className="plan big">{plan.map((p, i) => <li key={i} className={p.status}><i />{p.text}</li>)}</ul>
        </>
      ) : <p className="muted">Pas encore de plan : Max en écrit un dès qu’une mission a plusieurs étapes.</p>}
      <section className="room-sec">
        <h4>Qui fait quoi <span className="count">{plural(team.length, 'agent', 'agents')}</span></h4>
        {team.length ? (
          <div className="who">
            {team.map((a) => (
              <button key={a.id} className={`who-row ${a.status}`} style={{ ['--c' as string]: ROLES[a.role].color }} onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'agent', id: a.id } }); }}>
                <Avatar role={a.role} size={26} />
                <b>{a.name}</b>
                <span className="who-task">{a.task}</span>
                <span className="who-state">{a.status === 'done' ? '✓ rapport rendu' : a.status === 'failed' ? '✕ pas fini' : a.status === 'reporting' ? '📄 rend son rapport' : '… au travail'}</span>
              </button>
            ))}
          </div>
        ) : <p className="muted small">Personne pour l’instant.</p>}
      </section>
      {steps.length > 0 && (
        <section className="room-sec">
          <h4>L’historique du plan</h4>
          <ol className="timeline">
            {steps.map((s, i) => (
              <li key={i}>
                <time>{new Date(s.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                <div>{s.lines.map((l, j) => <span key={j}>{l}</span>)}</div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </Shell>
  );
}

// ── L'horloge ──
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return now;
}

const TODS: [Tod, string][] = [['auto', 'Comme ton Mac'], ['day', '☀️ Jour'], ['evening', '🌇 Soir'], ['night', '🌙 Nuit']];

function ClockRoom() {
  const now = useClock();
  const tod = useOffice((s) => s.tod);
  const busySince = useOffice((s) => s.busySince);
  const workMs = useOffice((s) => s.workMs);
  const mission = useOffice((s) => s.mission);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return (
    <Shell title="L’horloge du bureau" sub={now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}>
      <div className="big-clock"><span>{hh}</span><i>:</i><span>{mm}</span><small>{ss}</small></div>
      {mission && (busySince
        ? <p className="center">Mission en cours depuis <b>{fmtClock(workMs + (now.getTime() - busySince))}</b> · {mission.title}</p>
        : <p className="center">Dernière mission : <b>{fmtClock(workMs)}</b> de travail · {mission.title}</p>)}
      <p className="center muted small">Ton équipe ne dort jamais : elle travaille à 3 h du matin comme à midi.</p>
      <div className="seg">
        {TODS.map(([v, l]) => (
          <button key={v} className={tod === v ? 'on' : ''} onClick={() => { sfx('click'); useOffice.setState({ tod: v }); savePref('tod', v); }}>{l}</button>
        ))}
      </div>
    </Shell>
  );
}

// ── La machine (le serveur) : Claude Code, le modèle, l'abonnement ──
function MachineRoom() {
  const claude = useOffice((s) => s.claude);
  const settings = useOffice((s) => s.settings);
  const mission = useOffice((s) => s.mission);
  const quota = useOffice((s) => s.quota);
  const dir = useOffice((s) => s.dir);
  const connection = useOffice((s) => s.connection);
  const rows: [string, React.ReactNode][] = [
    ['Claude Code', claude?.found ? `${claude.version} · ${claude.path}` : connection === 'demo' ? 'Démo (rediffusion d’une vraie mission)' : 'introuvable'],
    ['Connexion', 'ton abonnement Claude (aucune clé API, aucune facturation à l’usage)'],
    ['Cerveau de Max', `${mission?.model ?? modelLabel(settings.team.chef.model)} · puissance ${effortLabel(settings.team.chef.effort).toLowerCase()}`],
    ['L’équipe', POLES.filter((p) => p !== 'chef').map((p) => `${ROLES[p].label} : ${modelLabel(settings.team[p].model)}`).join(' · ')],
    ['Permissions', settings.permission === 'auto' ? 'automatiques : l’agent lève la main pour les gestes risqués' : 'demandées avant chaque commande'],
    ['Énergie (5 h)', quota ? `${Math.round(quota.fiveHour * 100)} % utilisés${quota.resetsAt ? `, rechargée à ${new Date(quota.resetsAt * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : ''}` : 'pas encore mesurée'],
    ['Dossier du bureau', dir ? tilde(dir) : '—'],
    ['Mission en cours', mission ? tilde(mission.folder) : 'aucune'],
  ];
  return (
    <Shell title="La machine" sub="Ce qui tourne derrière le bureau">
      <dl className="kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <section className="room-sec">
        <h4>Comment ça marche</h4>
        <p className="small">Max est une vraie séance Claude Code, lancée sans fenêtre dans le dossier de la mission. Son équipe, ce sont de vrais sous-agents Claude Code, chacun avec ses consignes et seulement les outils de son métier. Chaque fois qu’un agent utilise un outil (une recherche, une page lue, un fichier écrit), Claude Code le raconte au bureau, qui le montre aussitôt : un robot qui tape, une bulle, un rapport posé sur le bureau du chef.</p>
        <p className="small muted">Mode restreint : l’équipe ne sort jamais du dossier de la mission, et ni tes réglages ni tes autres agents ne s’invitent dans le bureau.</p>
      </section>
    </Shell>
  );
}

// ── Le jukebox ──
function JukeboxRoom() {
  const music = useOffice((s) => s.music);
  const tr = TRACKS[music.index];
  return (
    <Shell title="Le jukebox" sub="De la house pour bosser (ou pour l’afterwork)">
      <div className="now-playing">
        <div className={`vinyl ${music.playing ? 'spin' : ''}`}><i /></div>
        <div>
          <b>{tr.title}</b>
          <span>{tr.mood}</span>
          <div className="row">
            <button className="btn small" onClick={() => jukebox.prev()} aria-label="Morceau précédent">⏮</button>
            <button className="btn primary small" onClick={() => jukebox.toggle()}>{music.playing ? '⏸ Pause' : '▶ Lecture'}</button>
            <button className="btn small" onClick={() => jukebox.next()} aria-label="Morceau suivant">⏭</button>
          </div>
        </div>
      </div>
      <label className="field volume">
        <span>Volume</span>
        <input type="range" min={0} max={1} step={0.01} value={music.volume} onChange={(e) => jukebox.setVolume(Number(e.target.value))} />
      </label>
      <ul className="tracks">
        {TRACKS.map((t, i) => (
          <li key={t.id}>
            <button className={i === music.index ? 'on' : ''} onClick={() => jukebox.play(i)}>
              <span>{i === music.index && music.playing ? '♪' : i + 1}</span>
              <b>{t.title}</b>
              <em>{t.mood}</em>
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="btn" onClick={() => { useOffice.setState({ modal: null }); party(); }}>🪩 Mode soirée</button>
        <span className="small muted">Morceaux originaux, composés pour le bureau avec ElevenLabs Music et Google Lyria.</span>
      </div>
    </Shell>
  );
}

// ── Toute l'équipe : les métiers et leurs outils, la mission en cours, l'historique ──
function TeamRoom({ role }: { role?: Role }) {
  const [tab, setTab] = useState<'roles' | 'now' | 'history'>(role ? 'roles' : 'now');
  const team = useOffice(useShallow(teamList));
  const settings = useOffice((s) => s.settings);

  const working = (r: Role) => [...world.actors.values()].filter((a) => a.role === r && a.seated).length;
  const roles: Role[] = POLES;
  return (
    <Shell title="Toute l’équipe" sub="De vrais agents Claude Code, chacun avec son métier et ses outils" wide>
      <div className="seg tabs">
        <button className={tab === 'now' ? 'on' : ''} onClick={() => setTab('now')}>Cette mission</button>
        <button className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}>Les métiers</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>L’historique</button>
      </div>
      {tab === 'now' && (team.length ? (
        <div className="who">
          {team.map((a) => (
            <button key={a.id} className={`who-row ${a.status}`} style={{ ['--c' as string]: ROLES[a.role].color }} onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'agent', id: a.id } }); }}>
              <Avatar role={a.role} size={26} />
              <b>{a.name}</b>
              <span className="who-task">{ROLES[a.role].icon} {a.task}</span>
              <span className="who-state">{a.status === 'done' ? '✓ rapport rendu' : a.status === 'failed' ? '✕ pas fini' : a.act ? a.act.label : '… au travail'}</span>
            </button>
          ))}
        </div>
      ) : <p className="muted">Personne au bureau pour l’instant. Donne une mission à Max : il appellera les bons agents.</p>)}
      {tab === 'roles' && (
        <div className="roles">
          {roles.map((r) => (
            <div key={r} className={`role-card ${role === r ? 'focus' : ''}`} style={{ ['--c' as string]: ROLES[r].color }}>
              <div className="role-head"><Avatar role={r} size={34} /><div><b>{ROLES[r].icon} {ROLES[r].label}</b><span>{r === 'chef' ? 'le chef' : `agent « ${ROLES[r].type} »`} · {modelLabel(settings.team[r as Exclude<Role, 'renfort'>].model)}, puissance {effortLabel(settings.team[r as Exclude<Role, 'renfort'>].effort).toLowerCase()}{r !== 'chef' ? ` · ${settings.team[r as Exclude<Role, 'renfort'>].places} place${settings.team[r as Exclude<Role, 'renfort'>].places > 1 ? 's' : ''}` : ''}</span></div>{working(r) > 0 && <em>{working(r)} au travail</em>}</div>
              <p>{ROLES[r].what}</p>
              <div className="tools">{ROLE_TOOLS[r].map((t) => <span key={t} title={TOOL_INFO[t] ?? t}>{t}<small>{TOOL_INFO[t] ?? ''}</small></span>)}</div>
            </div>
          ))}
        </div>
      )}
      {tab === 'history' && <TeamHistory />}
    </Shell>
  );
}

// ── L'historique de toute l'équipe (sur le disque) : recherche et pagination, jamais tout d'un coup ──
function TeamHistory() {
  const page = useOffice((s) => s.historyPage);
  const send = useOffice((s) => s.send);
  const connection = useOffice((s) => s.connection);
  const [q, setQ] = useState('');
  const [p, setP] = useState(0);
  useEffect(() => {
    if (connection !== 'live') return;
    const t = setTimeout(() => send({ t: 'history_search', q, page: p }), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, p, connection, send]);
  if (connection !== 'live') return <p className="muted">L’historique vit sur ton ordinateur : lance le bureau avec Claude Code pour le voir.</p>;
  const pages = page ? Math.max(1, Math.ceil(page.total / 25)) : 1;
  return (
    <div className="hist-team">
      <input className="search" type="search" placeholder="Chercher un agent, un pôle, une demande, « planté »…" value={q} onChange={(e) => { setQ(e.target.value); setP(0); }} aria-label="Chercher dans l’historique" />
      {!page ? <p className="muted">Chargement…</p> : !page.entries.length ? <p className="muted">Rien trouvé.</p> : (
        <>
          <p className="small muted">{plural(page.total, 'passage', 'passages')} d’agents · page {page.page + 1} sur {pages}</p>
          {page.entries.map((e) => (
            <button key={`${e.missionId}|${e.id}`} className={`hist-row2 ${e.status}`} style={{ ['--c' as string]: ROLES[e.role]?.color ?? '#999' }} onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'agent', id: e.id, missionId: e.missionId } }); }}>
              <Avatar role={e.role} size={22} />
              <b>{e.name}</b>
              <span>{ROLES[e.role]?.label} · {e.task}<small>{e.missionTitle} · {fmtDate(e.at)}{e.model ? ` · ${modelLabel(e.model)}` : ''}{e.switched ? ` (bascule ${e.switched})` : ''}</small></span>
              <em className={`st-${e.status}`}>{e.status === 'done' ? '✓ Terminé' : e.status === 'crashed' ? '✕ Planté' : '… en cours'}{e.ms ? ` · ${fmtDuration(e.ms)}` : ''}</em>
            </button>
          ))}
          <div className="row pager">
            <button className="btn small" disabled={p <= 0} onClick={() => setP(p - 1)}>← Plus récents</button>
            <button className="btn small" disabled={p + 1 >= pages} onClick={() => setP(p + 1)}>Plus anciens →</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── L'imprimante : les rendus de la mission ──
function FilesRoom() {
  const files = useOffice((s) => s.files);
  const mission = useOffice((s) => s.mission);
  const send = useOffice((s) => s.send);
  const replaying = useOffice((s) => s.replaying);
  if (!mission || !files.length) {
    return <Shell title="Les rendus" sub="L’imprimante du bureau"><p className="muted">Rien d’imprimé pour l’instant : les fichiers de l’équipe arriveront ici.</p></Shell>;
  }
  return (
    <Shell title="Les rendus" sub={`${plural(files.length, 'fichier', 'fichiers')} · ${mission.title}`}>
      <FileActions files={files} missionId={mission.id} disabled={replaying} send={send} />
    </Shell>
  );
}

export function FileActions({ files, missionId, disabled, send }: { files: ReturnType<typeof useOffice.getState>['files']; missionId: string; disabled: boolean; send: ReturnType<typeof useOffice.getState>['send'] }) {
  const agents = useOffice((s) => s.agents);
  return (
    <div className="files">
      {files.map((f) => (
        <div key={f.path} className="file">
          <span className="file-icon">{fileIcon(f.ext)}</span>
          <div className="file-id">
            <b title={f.path}>{f.name}</b>
            <span className="small muted">{fmtSize(f.size)} · par {f.by === 'chef' ? 'Max' : agents[f.by]?.name ?? 'l’équipe'}</span>
          </div>
          {!disabled && (f.ext === 'html' || f.ext === 'htm') && (
            <button className="btn small primary" onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'preview', missionId, file: f.path } }); }}>Voir le site</button>
          )}
          {!disabled && readable(f.ext) && (
            <button className="btn small" onClick={() => { sfx('open'); useOffice.setState({ modal: null, viewer: { missionId, file: f.path } }); send({ t: 'read', missionId, file: f.path }); send({ t: 'versions', missionId, file: f.path }); }}>Lire</button>
          )}
          {!disabled && <button className="btn small ghost" onClick={() => send({ t: 'open', missionId, file: f.path })}>Ouvrir</button>}
        </div>
      ))}
    </div>
  );
}

// ── L'aperçu d'un site fait par l'équipe, dans un écran (bac à sable : il ne peut rien toucher) ──
function PreviewRoom({ missionId, file }: { missionId: string; file: string }) {
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [nonce, setNonce] = useState(0);
  const send = useOffice((s) => s.send);
  const src = `/apercu/${encodeURIComponent(missionId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
  const close = () => useOffice.setState({ modal: null });
  return (
    <div className="modal-back" onClick={close}>
      <div className="monitor" onClick={(e) => e.stopPropagation()}>
        <div className="monitor-bar">
          <span className="dots"><i /><i /><i /></span>
          <span className="addr">🔒 {file}</span>
          <div className="seg small">
            <button className={device === 'desktop' ? 'on' : ''} onClick={() => setDevice('desktop')}>💻 Ordinateur</button>
            <button className={device === 'phone' ? 'on' : ''} onClick={() => setDevice('phone')}>📱 Téléphone</button>
          </div>
          <button className="btn small" onClick={() => setNonce((n) => n + 1)} title="Recharger">↻</button>
          <button className="btn small" title="Le code de la page, et ses versions successives" onClick={() => { useOffice.setState({ modal: null, viewer: { missionId, file } }); send({ t: 'read', missionId, file }); send({ t: 'versions', missionId, file }); }}>&lt;/&gt; Code et versions</button>
          <button className="btn small" onClick={() => send({ t: 'open', missionId, file })}>Ouvrir dans le navigateur</button>
          <button className="close" onClick={close} aria-label="Fermer">×</button>
        </div>
        <div className={`monitor-screen ${device}`}>
          <iframe key={nonce} title={file} src={src} sandbox="allow-scripts allow-forms allow-popups allow-modals" referrerPolicy="no-referrer" />
        </div>
      </div>
    </div>
  );
}
