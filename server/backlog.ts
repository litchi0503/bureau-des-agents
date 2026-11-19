// Le carnet de Max, par projet : un tableau Markdown, une ligne par demande (N°, Demande, Étape, État, Attend).
// Max le tient à jour pendant le travail ; le bureau le lit pour l'écran « Carnet » et y ajoute les nouvelles
// demandes. Un backlog déjà présent dans le dépôt est lu tel quel : seul Max l'écrit, dans son format.
import type { BacklogRow } from '../shared/protocol.ts';

export const STEPS = ['Questions', 'Recherche', 'Analyse du code', 'Cahier des charges', 'Plan et maquette', 'Code', 'Relecture', 'Ton test'] as const;

export const EMPTY_BACKLOG = (project: string) => `# Carnet de Max · ${project}

Tenu par Max (le chef du Bureau des agents). Une ligne par demande.

| N° | Demande | Étape | État | Attend |
|---|---|---|---|---|
`;

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** Les lignes du carnet, ou null s'il n'y a pas de tableau lisible (N° et Demande au moins). */
export function parseBacklog(text: string): BacklogRow[] | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|') || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const head = cells(lines[i]).map(norm);
    const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
    const id = col('n', 'no', 'num', 'numero', 'id'), title = col('demande', 'tache', 'titre', 'title', 'task');
    if (id < 0 || title < 0) continue;
    const step = col('etape', 'step', 'phase'), state = col('etat', 'statut', 'status', 'state'), wait = col('attend', 'bloquepar', 'waiting', 'dependde');
    const rows: BacklogRow[] = [];
    for (let j = i + 2; j < lines.length && lines[j].includes('|'); j++) {
      const c = cells(lines[j]);
      if (!c[id] && !c[title]) continue;
      rows.push({ id: c[id] ?? '', title: c[title] ?? '', step: step >= 0 ? c[step] ?? '' : '', state: state >= 0 ? c[state] ?? '' : '', wait: wait >= 0 ? c[wait] ?? '' : '' });
    }
    return rows;
  }
  return null;
}

/** Le prochain numéro de demande (D-001, D-002…). */
export function nextId(rows: BacklogRow[] | null): string {
  let max = 0;
  for (const r of rows ?? []) { const n = /^D-(\d+)/i.exec(r.id)?.[1]; if (n) max = Math.max(max, Number(n)); }
  return `D-${String(max + 1).padStart(3, '0')}`;
}

const esc = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** Ajoute une demande au carnet du bureau (sous le tableau). */
export function addRow(text: string, row: BacklogRow): string {
  const line = `| ${esc(row.id)} | ${esc(row.title)} | ${esc(row.step)} | ${esc(row.state)} | ${esc(row.wait) || '—'} |`;
  const lines = text.replace(/\n+$/, '').split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith('|')) last = i;
  if (last < 0) return `${text.replace(/\n+$/, '')}\n\n| N° | Demande | Étape | État | Attend |\n|---|---|---|---|---|\n${line}\n`;
  lines.splice(last + 1, 0, line);
  return lines.join('\n') + '\n';
}

/** Change l'état d'une demande (par son N°) dans le carnet du bureau. */
export function setRow(text: string, id: string, patch: Partial<BacklogRow>): string {
  return text.split('\n').map((l) => {
    const c = cells(l);
    if (!l.trim().startsWith('|') || c[0] !== id) return l;
    const r = { id: c[0], title: c[1] ?? '', step: c[2] ?? '', state: c[3] ?? '', wait: c[4] ?? '', ...patch };
    return `| ${esc(r.id)} | ${esc(r.title)} | ${esc(r.step)} | ${esc(r.state)} | ${esc(r.wait) || '—'} |`;
  }).join('\n');
}

/** « Chef, j'ai 3 questions » dans le dernier message de Max : combien ? */
export function questionCount(text: string): number {
  const m = /j[’']ai\s+(\d+|une|deux|trois|quatre|cinq|six)\s+questions?/i.exec(text);
  if (!m) return 0;
  const w: Record<string, number> = { une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6 };
  return Number(m[1]) || w[m[1].toLowerCase()] || 0;
}
