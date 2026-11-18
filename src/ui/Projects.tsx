// Les projets (travailler dans un dossier existant) et le carnet de Max, projet par projet.
import { useEffect, useState } from 'react';
import type { ProjectInfo } from '../../shared/protocol.ts';
import { sfx } from '../audio/sfx.ts';
import { savePref, useOffice } from '../state/store.ts';
import { fmtDate, tilde } from './format.ts';
import { mdToHtml } from './md.ts';

function Frame({ title, sub, children, actions }: { title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  const close = () => useOffice.setState({ modal: null });
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal xl" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="room-title"><b>{title}</b>{sub && <span>{sub}</span>}</div>
          <div className="row">{actions}<button className="close" onClick={close} aria-label="Fermer">×</button></div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ProjectsRoom({ id }: { id?: string }) {
  const projects = useOffice((s) => s.projects);
  const send = useOffice((s) => s.send);
  const connection = useOffice((s) => s.connection);
  const [sel, setSel] = useState<string | undefined>(id ?? projects[0]?.id);
  const [adding, setAdding] = useState(projects.length === 0);
  useEffect(() => { if (connection === 'live') send({ t: 'projects' }); }, [connection, send]);
  useEffect(() => { if (!sel && projects[0]) setSel(projects[0].id); }, [projects, sel]);
  const p = projects.find((x) => x.id === sel);
  if (connection !== 'live') return <Frame title="Projets"><div className="modal-body"><p className="muted">Les projets vivent sur ton ordinateur : lance le bureau avec Claude Code.</p></div></Frame>;
  return (
    <Frame title="Projets" sub="Travailler dans un dossier existant">
      <div className="proj">
        <aside className="proj-list">
          <button className="btn small primary" onClick={() => setAdding(true)}>+ Ajouter</button>
          <nav aria-label="Liste des projets">
            {projects.map((x) => (
              <button key={x.id} className={`proj-item ${x.id === sel && !adding ? 'on' : ''}`} onClick={() => { setSel(x.id); setAdding(false); }}>
                <span><b>{x.name}</b><em className={x.busy ? 'busy' : ''}>{x.busy ? 'Demande en cours' : 'Libre'}</em></span>
                <code>{tilde(x.path)}</code>
              </button>
            ))}
          </nav>
          <p className="small muted">Une seule demande à la fois par projet. Les autres attendent dans le carnet.</p>
        </aside>
        <main className="proj-main">
          {adding || !p ? <AddProject onDone={() => setAdding(false)} /> : <ProjectSheet key={p.id} p={p} />}
        </main>
      </div>
    </Frame>
  );
}

function Picker({ start, onPick }: { start: string; onPick: (path: string) => void }) {
  const browse = useOffice((s) => s.browse);
  const send = useOffice((s) => s.send);
  useEffect(() => { send({ t: 'browse', path: start }); }, [send, start]);
  if (!browse) return <p className="muted small">Chargement…</p>;
  return (
    <div className="picker">
      <div className="row"><code>{tilde(browse.path)}</code><button className="btn small primary" onClick={() => onPick(browse.path)}>Choisir ce dossier</button></div>
      <ul>
        {browse.parent && <li><button onClick={() => send({ t: 'browse', path: browse.parent! })}>↑ Dossier parent</button></li>}
        {browse.dirs.map((d) => <li key={d}><button onClick={() => send({ t: 'browse', path: `${browse.path}/${d}` })}>📁 {d}</button></li>)}
        {!browse.dirs.length && <li className="muted small">Aucun sous-dossier.</li>}
      </ul>
    </div>
  );
}

function AddProject({ onDone }: { onDone: () => void }) {
  const send = useOffice((s) => s.send);
  const [path, setPath] = useState('');
  const [pick, setPick] = useState(false);
  return (
    <div className="proj-body">
      <h3>Ajouter un projet</h3>
      <p className="small muted">Un dossier qui existe déjà sur ton ordinateur (souvent un dépôt git). Le bureau détecte ses branches, ses commandes et ses docs ; tu confirmes ensuite.</p>
      <div className="row grow"><input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/mon-projet" aria-label="Emplacement du projet" /><button className="btn" onClick={() => setPick(!pick)}>Choisir…</button></div>
      {pick && <Picker start={path || '~'} onPick={(p) => { setPath(p); setPick(false); }} />}
      <div className="row"><button className="btn primary" disabled={!path.trim()} onClick={() => { sfx('click'); send({ t: 'project_add', path: path.trim() }); onDone(); }}>Ajouter</button></div>
    </div>
  );
}

const ACCESS: [ProjectInfo['access'], string, string][] = [
  ['read', 'Lecture seule', 'Analyse, plans, maquettes'],
  ['branch', 'Code sur branche', 'Commits locaux, rien poussé'],
  ['push', 'Code + push', 'Pousse sa branche, merge vers la base si tout est vert'],
];

function ProjectSheet({ p }: { p: ProjectInfo }) {
  const send = useOffice((s) => s.send);
  const [d, setD] = useState<ProjectInfo>(p);
  const [pick, setPick] = useState(false);
  const [newForbidden, setNewForbidden] = useState('');
  const [newRead, setNewRead] = useState('');
  useEffect(() => setD(p), [p]);
  const dirty = JSON.stringify({ ...d, busy: 0 }) !== JSON.stringify({ ...p, busy: 0 });
  const save = () => { sfx('click'); send({ t: 'project_update', id: p.id, patch: { name: d.name, path: d.path, access: d.access, base: d.base, forbidden: d.forbidden, commands: d.commands, readFirst: d.readFirst, backlogFile: d.backlogFile } }); };
  const base = d.base;
  return (
    <>
      <div className="proj-head">
        <div><h3>{p.name}</h3><span className="small muted">{p.map ? <>Carte du projet à jour au commit <code>{p.map.commit.slice(0, 7) || '?'}</code> · {fmtDate(p.map.at)}</> : 'Pas encore de carte : Max la fera à la première demande.'}</span></div>
        <div className="row">
          <button className="btn small" disabled={p.busy} onClick={() => { sfx('click'); send({ t: 'map_update', projectId: p.id }); useOffice.setState({ modal: null }); }}>Mettre à jour la carte</button>
          <button className="btn small primary" onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'carnet', projectId: p.id } }); }}>Ouvrir le carnet</button>
        </div>
      </div>
      <div className="proj-body">
        <h4 className="set-sec">Dossier</h4>
        <div className="kv2"><span>Emplacement</span><div className="row grow"><input value={tilde(d.path)} onChange={(e) => setD({ ...d, path: e.target.value })} aria-label="Emplacement du projet" /><button className="btn small" onClick={() => setPick(!pick)}>Choisir…</button></div></div>
        {pick && <Picker start={d.path} onPick={(x) => { setD({ ...d, path: x }); setPick(false); }} />}
        <h4 className="set-sec">Accès de l’équipe</h4>
        <div className="access" role="radiogroup" aria-label="Accès de l’équipe">
          {ACCESS.map(([v, l, sub]) => (
            <label key={v} className={d.access === v ? 'on' : ''}>
              <input type="radio" name={`acc-${p.id}`} checked={d.access === v} disabled={v !== 'read' && !p.isGit} onChange={() => setD({ ...d, access: v })} />
              <span><b>{l}</b><small>{sub}</small></span>
            </label>
          ))}
        </div>
        {!p.isGit && <p className="small muted">Ce dossier n’est pas un dépôt git : lecture seule.</p>}
        {p.isGit && (
          <>
            <h4 className="set-sec">Git</h4>
            <div className="kv2"><span>Branche de base</span><select value={base} onChange={(e) => setD({ ...d, base: e.target.value })}>{[...new Set([base, ...(p.branches ?? [])])].map((b) => <option key={b}>{b}</option>)}</select></div>
            <div className="kv2"><span>Branches de travail</span><span><code>bureau/&lt;demande&gt;</code></span></div>
            <div className="kv2"><span>Interdites</span><span className="chips">
              {d.forbidden.map((b) => <button key={b} className="chip" onClick={() => setD({ ...d, forbidden: d.forbidden.filter((x) => x !== b) })} aria-label={`Retirer ${b}`}>{b} ✕</button>)}
              <input className="mini" value={newForbidden} placeholder="+ ajouter" onChange={(e) => setNewForbidden(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newForbidden.trim()) { setD({ ...d, forbidden: [...d.forbidden, newForbidden.trim()] }); setNewForbidden(''); } }} />
            </span></div>
            {d.forbidden.includes(base) && <p className="small warn-text">La branche de base est interdite : l’équipe ne mergera jamais vers elle.</p>}
            <div className="kv2"><span>Auteur des commits</span><span>{p.author ? `${p.author.replace(/\s*<.*>$/, '')} (repris de git, jamais modifié)` : 'non configuré dans ce dépôt (git config user.name)'}</span></div>
            <div className="kv2"><span>Signatures d’IA</span><span>{p.hookOk ? '✓ Retirées par le hook commit-msg du dépôt' : 'Le bureau installe son hook commit-msg à la première demande'} ; vérifiées avant chaque push</span></div>
          </>
        )}
        <h4 className="set-sec">Commandes détectées <span className="muted small">(coche celles que tu confirmes)</span></h4>
        <div className="cmds">
          {d.commands.map((c, i) => (
            <label key={i} className="cmd">
              <input type="checkbox" checked={c.confirmed} onChange={(e) => setD({ ...d, commands: d.commands.map((x, j) => (j === i ? { ...x, confirmed: e.target.checked } : x)) })} />
              <span>{c.name}</span>
              <input value={c.cmd} onChange={(e) => setD({ ...d, commands: d.commands.map((x, j) => (j === i ? { ...x, cmd: e.target.value } : x)) })} aria-label={`Commande ${c.name}`} />
            </label>
          ))}
          {!d.commands.length && <p className="small muted">Aucune commande trouvée dans package.json, composer.json, Makefile ou scripts/.</p>}
          <button className="btn small ghost" onClick={() => setD({ ...d, commands: [...d.commands, { name: 'Tests', cmd: '', confirmed: false }] })}>+ Une commande</button>
        </div>
        <h4 className="set-sec">À lire avant chaque demande</h4>
        <div className="chips">
          {d.readFirst.map((f) => <button key={f} className="chip" onClick={() => setD({ ...d, readFirst: d.readFirst.filter((x) => x !== f) })}>{f} ✕</button>)}
          <input className="mini" value={newRead} placeholder="+ ajouter" onChange={(e) => setNewRead(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newRead.trim()) { setD({ ...d, readFirst: [...d.readFirst, newRead.trim()] }); setNewRead(''); } }} />
        </div>
        <h4 className="set-sec">Fichier carnet</h4>
        <div className="kv2"><span>Carnet</span><input value={d.backlogFile} placeholder="(celui du bureau)" onChange={(e) => setD({ ...d, backlogFile: e.target.value })} aria-label="Fichier carnet dans le dépôt" /></div>
        <p className="small muted">Vide : le carnet du bureau (Projets/{p.name}/carnet.md). Un fichier du dépôt (docs/agent/BACKLOG.md…) : Max le lit et l’écrit dans son format.</p>
        <div className="row proj-save">
          <button className="btn ghost small" onClick={() => { if (window.confirm(`Retirer ${p.name} des projets du bureau ? (Ses fichiers ne sont pas touchés.)`)) send({ t: 'project_remove', id: p.id }); }}>Retirer ce projet</button>
          <button className="btn" disabled={!dirty} onClick={() => setD(p)}>Annuler</button>
          <button className="btn primary" disabled={!dirty || p.busy} onClick={save}>Enregistrer</button>
        </div>
      </div>
    </>
  );
}

const STEPS = ['Questions', 'Recherche', 'Analyse du code', 'Cahier des charges', 'Plan et maquette', 'Code', 'Relecture', 'Ton test'];
const STATE_COLOR = (s: string) => /cours/i.test(s) ? '#3ddc97' : /attend/i.test(s) ? '#4fb3ff' : /pause/i.test(s) ? '#c8a27a' : /bloqu/i.test(s) ? '#ff9f43' : '#9aa3b5';

export function CarnetRoom({ projectId }: { projectId: string }) {
  const carnet = useOffice((s) => (s.carnet?.projectId === projectId ? s.carnet : null));
  const project = useOffice((s) => s.projects.find((p) => p.id === projectId));
  const send = useOffice((s) => s.send);
  const busy = useOffice((s) => s.busySince !== null);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [modify, setModify] = useState('');
  useEffect(() => {
    send({ t: 'carnet', projectId });
    const t = setInterval(() => send({ t: 'carnet', projectId }), 5000);
    return () => clearInterval(t);
  }, [projectId, send]);
  const stepIndex = carnet?.current ? Math.max(0, STEPS.findIndex((s) => s.toLowerCase() === carnet.current!.step.toLowerCase())) : -1;
  return (
    <Frame title={`Carnet de Max · ${project?.name ?? ''}`} sub={carnet ? <>Lu et écrit dans <code>{carnet.file}</code></> : undefined}
      actions={<button className="btn small primary" onClick={() => setAdding(!adding)}>+ Nouvelle demande</button>}>
      <div className="modal-body carnet">
        {adding && (
          <div className="carnet-new">
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ce que tu veux sur ce projet (Max posera ses questions d’abord)…" />
            <div className="row">
              <span className="small muted">{project?.busy ? 'Une demande est en cours : celle-ci attendra dans le carnet.' : 'Elle démarre tout de suite.'}</span>
              <button className="btn primary" disabled={!text.trim()} onClick={() => { sfx('send'); send({ t: 'carnet_add', projectId, text: text.trim() }); savePref('projectId', projectId); setText(''); setAdding(false); }}>Envoyer à Max</button>
            </div>
          </div>
        )}
        {!carnet ? <p className="muted">Ouverture…</p> : (
          <>
            <h4 className="set-sec">En cours</h4>
            {carnet.current ? (
              <div className="carnet-now">
                <div className="row between"><b>{carnet.current.title}</b><span className="dot-state" style={{ ['--c' as string]: carnet.current.working ? '#3ddc97' : '#4fb3ff' }}>{carnet.current.working ? carnet.current.step : 'Attend ta réponse'}</span></div>
                <ol className="steps8" aria-label="Étapes de la demande">
                  {STEPS.map((s, i) => <li key={s} className={i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''}><i />{s}</li>)}
                </ol>
                {carnet.toValidate && (
                  <div className="validate">
                    <span>À valider : <b>{carnet.toValidate}</b></span>
                    <div className="row grow">
                      <input value={modify} onChange={(e) => setModify(e.target.value)} placeholder="Ce qu’il faut changer (pour « Modifier »)" />
                      <button className="btn small" disabled={!modify.trim() || busy} onClick={() => { send({ t: 'validate', ok: false, text: modify.trim() }); setModify(''); }}>Modifier</button>
                      <button className="btn small primary" disabled={busy} onClick={() => send({ t: 'validate', ok: true })}>Valider</button>
                    </div>
                  </div>
                )}
              </div>
            ) : <p className="small muted">Aucune demande en cours sur ce projet.</p>}
            {(carnet.questions > 0 || carnet.tests > 0) && (
              <div className="carnet-cards">
                {carnet.questions > 0 && <div className="qcard"><b>Max a {carnet.questions} question{carnet.questions > 1 ? 's' : ''}</b><span>Une conseillée pour chaque. Réponds « 1A 2B », ou « OK » pour suivre ses conseils.</span><button className="btn small" onClick={() => { useOffice.setState({ modal: null, draft: ' ' }); }}>Répondre</button></div>}
                {carnet.tests > 0 && <div className="tcard"><b>{carnet.tests} session{carnet.tests > 1 ? 's' : ''} de test à faire</b><span>Ce que Max te demande de vérifier toi-même.</span></div>}
              </div>
            )}
            <h4 className="set-sec">Toutes les demandes</h4>
            {carnet.rows ? (
              <div className="carnet-table" role="table">
                <div className="ct-row ct-head" role="row"><span>N°</span><span>Demande</span><span>Étape</span><span>État</span><span>Attend</span></div>
                {carnet.rows.slice().reverse().map((r) => (
                  <div key={r.id + r.title} className="ct-row" role="row">
                    <code>{r.id}</code><b>{r.title}</b><span>{r.step}</span>
                    <span className="dot-state" style={{ ['--c' as string]: STATE_COLOR(r.state) }}>{r.state}</span>
                    <span>{r.state === 'À faire' && !project?.busy ? <button className="btn small" onClick={() => { send({ t: 'carnet_launch', projectId, id: r.id }); useOffice.setState({ modal: null }); }}>Lancer</button> : r.wait || '—'}</span>
                  </div>
                ))}
                {!carnet.rows.length && <p className="small muted pad">Pas encore de demande.</p>}
              </div>
            ) : carnet.raw ? (
              <>
                <p className="small warn-text">Ce carnet n’a pas de tableau que le bureau sait lire : le voici tel quel. Max le tient dans son format.</p>
                <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(carnet.raw) }} />
              </>
            ) : <p className="small muted">Le carnet est vide : il se remplira à la première demande.</p>}
          </>
        )}
      </div>
    </Frame>
  );
}
