## Frontend
Dépôt du frontend : [LIEN-A-REMPLACER]

## Nouveautés de cette version
- Rôle custom `note` : note personnelle de l'étudiant (`POST /conversations/{id}/notes`).
- Prompt système spécialisé (tuteur Python débutant) dans `prompts/system.md`.
- Streaming de la réponse (Server-Sent Events) sur `POST /chat`.
- Choix du modèle : `GET /models` + champ `model` dans `POST /chat`.

## Configuration
```
uv sync
cp .env.example .env   # renseigner RODIUMAI_API_KEY, RODIUMAI_MODEL, ALLOWED_MODELS
uv run alembic upgrade head
uv run fastapi dev main.py
```

## Rôle custom `note` : choix de traitement
Une note est enregistrée en base comme les autres messages (rôle `note`, avec son `seq`) et affichée dans l'interface avec un style distinct.
Au moment de construire l'historique (`build_llm_history`), elle est **filtrée** : elle n'est jamais envoyée au LLM. J'ai préféré filtrer plutôt que transformer en `user`, car une note personnelle (« revoir les boucles demain ») n'est pas une question posée au tuteur : l'envoyer lui ferait répondre à un message qui ne lui est pas adressé et consommerait des tokens pour rien.

## Fiche de test du prompt
Générée avec `uv run python scripts/compare_prompts.py` (résultat dans `prompt_test_results.md`) :
[COLLER ICI LE CONTENU DE prompt_test_results.md ET COMMENTER EN 2 LIGNES CHAQUE SCÉNARIO]

## Questions
**1. Pourquoi l'historique stocké en base n'est-il pas forcément celui envoyé au LLM ? Où se fait ce traitement ?**
La base contient tout ce qui s'affiche dans l'interface (messages user et assistant, notifications système, notes), alors que le LLM n'accepte que certains rôles (`user`, `assistant`, `system`) et ne doit recevoir que ce qui lui est utile. Le tri se fait dans `build_llm_history` (`main.py`), juste avant de construire la requête : les notes et notifications sont écartées, et le prompt système est ajouté en tête à chaque tour car le LLM n'a pas de mémoire.

**2. Que se passe-t-il quand on change de modèle au milieu d'une conversation, et pourquoi est-ce possible ?**
La conversation continue normalement avec le nouveau modèle. C'est possible parce que le LLM est sans état : à chaque tour on renvoie le prompt système et tout l'historique, stockés par notre application et non par le modèle. Le nouveau modèle reçoit donc le même contexte et poursuit, avec son propre style.

**3. À quel moment enregistrez-vous la réponse streamée en base, et que se passe-t-il si le flux est interrompu ?**
Uniquement après la fin complète du flux (`[DONE]`) sans erreur, dans une seule transaction qui écrit le message de l'utilisateur et la réponse assistant ensemble. Si l'API échoue au milieu du flux, ou si le client coupe la connexion, rien n'est écrit : pas de message utilisateur orphelin ni de réponse tronquée. Le client reçoit un événement `error` et peut renvoyer son message.

**4. Comment garantir que la clé API ne fuit jamais côté navigateur ?**
La clé n'est lue que dans le backend (`os.environ["RODIUMAI_API_KEY"]`, fichier `.env` ignoré par git). Le navigateur ne parle qu'à notre API (`/chat`, `/models`...), jamais à RodiumAI, et aucune réponse de notre API ne contient la clé. Le frontend n'a aucune variable `VITE_*` contenant un secret.
