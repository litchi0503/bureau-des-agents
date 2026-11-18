// Relier Max à Telegram, en 4 étapes : créer le bot (@BotFather), coller son token, envoyer /start, message de test.
// Le token ne revient jamais à l'écran une fois enregistré : le bureau ne montre que « relié » ou « non relié ».
import { useState } from 'react';
import { sfx } from '../audio/sfx.ts';
import { useOffice } from '../state/store.ts';

const STEPS = ['Créer le bot', 'Coller le token', 'Envoyer /start', 'Message de test'];

export function TelegramRoom() {
  const status = useOffice((s) => s.telegram);
  const send = useOffice((s) => s.send);
  const connection = useOffice((s) => s.connection);
  const serverStep = !status ? 0 : status.step === 'token' || status.step === 'none' ? 1 : status.step === 'start' ? 2 : status.step === 'test' ? 3 : 4;
  const [view, setView] = useState<number>(serverStep >= 2 ? serverStep : 0);
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  // l'étape affichée : celle du serveur dès que le token est enregistré (sauf retour en arrière)
  const shown = serverStep >= 2 ? (view === 1 ? 1 : Math.max(serverStep, Math.min(view, 3))) : Math.min(view, 1);
  const close = () => useOffice.setState({ modal: null });
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal tg" role="dialog" aria-label="Relier Max à Telegram" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row"><span className="tg-logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M21 4 3 11l6 2 2 6 3-4 5 4z" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" /><path d="m9 13 8-6" fill="none" stroke="#fff" strokeWidth="2" /></svg></span><b>Relier Max à Telegram</b></div>
          <button className="close" onClick={close} aria-label="Fermer">×</button>
        </div>
        {connection !== 'live' ? <div className="modal-body"><p className="muted">Telegram se relie depuis le bureau qui tourne sur ton ordinateur (npm start).</p></div> : status?.linked ? (
          <div className="modal-body">
            <p className="tg-ok">✓ Relié{status.botName ? ` à ${status.botName}` : ''}. Max t’écrit selon les cases de l’onglet Suivi.</p>
            {status.error && <p className="tg-err">{status.error}</p>}
            <Help />
            <div className="row"><button className="btn" onClick={() => { if (window.confirm('Délier Telegram ? Le token sera effacé de ton PC.')) send({ t: 'tg_unlink' }); }}>Délier</button></div>
          </div>
        ) : (
          <div className="tg-wiz">
            <ol className="tg-steps">
              {STEPS.map((s, i) => (
                <li key={s} className={i < shown ? 'done' : i === shown ? 'now' : ''}>
                  <i>{i < shown ? '✓' : i + 1}</i><span>{s}</span>
                </li>
              ))}
            </ol>
            <div className="tg-main">
              <span className="set-sec">Étape {Math.min(shown, 3) + 1} sur 4</span>
              {shown === 0 && (
                <>
                  <h3>Crée ton bot avec @BotFather</h3>
                  <ol className="small tg-tuto">
                    <li>Dans Telegram, cherche <b>@BotFather</b> (le compte officiel, avec la coche bleue) et ouvre la conversation.</li>
                    <li>Envoie <code>/newbot</code>.</li>
                    <li>Donne-lui un nom (par exemple « Max du bureau »), puis un identifiant qui finit par <code>bot</code>.</li>
                    <li>@BotFather te répond avec un long token : garde ce message ouvert.</li>
                  </ol>
                  <div className="row"><button className="btn primary" onClick={() => setView(1)}>C’est fait, continuer</button></div>
                </>
              )}
              {shown === 1 && (
                <>
                  <h3>Colle le token de ton bot</h3>
                  <p className="small muted">@BotFather t’a envoyé « Use this token to access the HTTP API ». Copie la longue suite de chiffres et de lettres, et colle-la ici.</p>
                  <label className="small" htmlFor="tg-tok"><b>Token du bot</b></label>
                  <div className="row grow">
                    <input id="tg-tok" type={show ? 'text' : 'password'} autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…" />
                    <button className="btn small" onClick={() => setShow(!show)} aria-label={show ? 'Masquer le token' : 'Afficher le token'}>{show ? 'Masquer' : 'Afficher'}</button>
                  </div>
                  <span className="small muted">Gardé seulement sur ton PC, hors des projets et des missions. Jamais renvoyé à Claude ni affiché en clair après.</span>
                  <div className="set-info"><i aria-hidden="true">i</i><span>Un bot ne peut être lu que par un seul programme. Arrête l’ancien programme avant, ou crée un nouveau bot pour le bureau.</span></div>
                  {status?.error && <p className="tg-err">{status.error}</p>}
                  <div className="row"><button className="btn" onClick={() => setView(0)}>Retour</button><button className="btn primary" disabled={!token.trim()} onClick={() => { sfx('click'); send({ t: 'tg_token', token: token.trim() }); setToken(''); setView(2); }}>Vérifier et continuer</button></div>
                </>
              )}
              {shown === 2 && (
                <>
                  <h3>Envoie /start à ton bot</h3>
                  <p className="small muted">Ouvre la conversation avec {status?.botName ?? 'ton bot'} dans Telegram et envoie <code>/start</code>. Le bureau repère ton chat tout seul : seul ce chat pourra parler à Max.</p>
                  <p className="small">{serverStep >= 3 ? '✓ Ton chat est repéré.' : '⏳ En attente de ton /start…'}</p>
                  {status?.error && <p className="tg-err">{status.error}</p>}
                  <div className="row"><button className="btn" onClick={() => setView(1)}>Retour</button><button className="btn primary" disabled={serverStep < 3} onClick={() => setView(3)}>Continuer</button></div>
                </>
              )}
              {shown >= 3 && (
                <>
                  <h3>Le message de test</h3>
                  <p className="small muted">Max t’envoie un message : s’il arrive sur ton téléphone, c’est relié.</p>
                  <div className="row"><button className="btn primary" onClick={() => { sfx('click'); send({ t: 'tg_test' }); }}>Envoyer le message de test</button></div>
                </>
              )}
              <Help />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Help() {
  return (
    <div className="tg-help">
      <b className="small">Une fois relié, depuis ton téléphone</b>
      <div className="small"><span><code>/demande projet texte</code> nouvelle demande</span><span><code>/status</code> état des agents</span><span><code>1A 2B</code>, <code>OK</code>, <code>KO 3 : …</code> répondre à Max</span><span><code>/stop</code> tout arrêter</span></div>
    </div>
  );
}
