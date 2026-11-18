# Refonte du Bureau des agents : où on en est

Branche : `bureau/reglages-suivi` (partie de `reprise/garde-fou-existant`).

## Ce que Claude Code 2.1.327 permet vraiment (vérifié à la main)

- `--agents` : chaque sous-agent accepte `model` et `effort` (`low`, `medium`, `high`, `xhigh`, `max`).
  Une valeur fausse est refusée au lancement (`testeur.effort: Invalid input`) : le champ existe bien.
- L'outil `Agent` accepte, à chaque appel, `model` (sonnet, opus, haiku, fable) et `effort` (low… max).
- Le chef : `--model` et `--effort`.
- Les limites arrivent dans `rate_limit_event` : `unifiedWindows.five_hour`, `seven_day`, et parfois
  `seven_day_overage_included` ; `rateLimitType` peut valoir `seven_day_opus` ou `seven_day_sonnet`
  (limite propre à un modèle). Pas de type propre à Fable dans cette version.
- Les hooks passés par `--settings` restent actifs en `--restricted` : c'est par eux que le serveur
  fait respecter les places et les interdits git (hook `PreToolUse`).

## Étapes

1. Les 6 pôles (rôles, consignes, plan du bureau, anciennes missions) : à faire
2. Onglet Équipe : à faire
3. Onglet Garde-fou : à faire
4. Onglet Suivi, pastilles, historique : à faire
5. WSL : à faire
6. Projets : à faire
7. Carnet de Max : à faire
8. Telegram : à faire
9. Économie de tokens : à faire
10. Vérifications réelles : à faire
