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

1. Les 6 pôles : fait
2. Onglet Équipe : fait
3. Onglet Garde-fou : fait
4. Onglet Suivi, pastilles, historique : fait
5. WSL : fait
6. Projets : fait
7. Carnet de Max : fait
8. Telegram : fait
9. Économie de tokens : fait
10. Vérifications réelles : à faire
