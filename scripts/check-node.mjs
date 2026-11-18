// Avant de lancer le bureau : la bonne version de Node, et Claude Code installé (cherché comme le fait le
// serveur : PATH, ~/.local/bin, ~/.claude/local, Homebrew…).
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  console.error(`\n  Le Bureau des agents demande Node.js 22.18 ou plus récent (tu as ${process.versions.node}).`);
  console.error('  Installe la dernière version sur https://nodejs.org, puis relance « npm start ».\n');
  process.exit(1);
}
// importé seulement maintenant : un Node trop vieux ne lirait pas ce fichier TypeScript
const { findClaude } = await import('../server/claude.ts');
if (!(await findClaude())) {
  console.warn('\n  ⚠  Claude Code n’est pas trouvé : le bureau s’ouvrira en démo.');
  console.warn('  Installe-le (https://claude.com/claude-code), connecte-toi avec « claude », puis relance « npm start ».\n');
}
