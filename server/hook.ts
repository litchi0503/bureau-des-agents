// Le garde-fou du bureau, côté Claude Code : un hook PreToolUse (passé par --settings, il reste actif en
// mode restreint). Claude Code le lance avant chaque appel d'outil surveillé ; il transmet la demande au
// serveur du bureau (127.0.0.1, avec un jeton secret propre à la séance) et applique sa réponse :
//   - exit 0 sans rien : rien à dire, Claude Code continue comme d'habitude (permissions comprises) ;
//   - exit 0 avec du JSON : l'appel est autorisé, éventuellement modifié (le modèle d'un agent, par exemple) ;
//   - exit 2 : l'appel est refusé, et le message dit pourquoi à l'agent.
// Si le bureau ne répond pas, on refuse : mieux vaut un agent bloqué qu'un push non surveillé.
import http from 'node:http';

const url = process.env.BUREAU_HOOK_URL ?? '';
const token = process.env.BUREAU_HOOK_TOKEN ?? '';

function refuse(msg: string): never {
  process.stderr.write(msg);
  process.exit(2);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (!url || !token) refuse('Le bureau ne surveille pas cette séance : appel refusé.');
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bureau-hook': token } }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const r = JSON.parse(body) as { exit: number; stdout?: string; stderr?: string };
        if (r.exit === 2) refuse(r.stderr || 'Refusé par le bureau.');
        if (r.stdout) process.stdout.write(r.stdout);
        process.exit(0);
      } catch {
        refuse('Réponse illisible du bureau : appel refusé.');
      }
    });
  });
  req.on('error', () => refuse('Le bureau ne répond pas : appel refusé.'));
  req.end(input);
});
