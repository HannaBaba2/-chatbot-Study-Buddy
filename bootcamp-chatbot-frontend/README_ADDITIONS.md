## Nouveautés (devoir session 4)

- **Streaming** : la réponse s'affiche au fil de la génération (`fetch` + `response.body.getReader()` dans `src/api.ts`, fonction `streamMessage`).
- **Sélecteur de modèle** : la liste vient de `GET /api/models` ; le modèle choisi est envoyé avec chaque message.
- **Rôle custom `note`** : case « Note personnelle » au-dessus du champ de saisie ; la note est affichée avec un style distinct et n'est jamais envoyée à l'IA.
- **Bouton Arrêter** pendant la génération : rien n'est enregistré en base si on interrompt.

## Endpoints utilisés (ajouts)

| Méthode | Route                              | Usage                           |
| ------- | ---------------------------------- | ------------------------------- |
| `GET`   | `/models`                          | Liste des modèles autorisés     |
| `POST`  | `/conversations/{id}/notes`        | Ajouter une note personnelle    |
| `POST`  | `/chat`                            | Maintenant en streaming (SSE)   |
