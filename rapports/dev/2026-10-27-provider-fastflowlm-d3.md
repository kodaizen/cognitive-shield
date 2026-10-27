# Ajout du provider FastFlowLM (d3:nano) — 2026-10-27

## Objectif
Ajouter à l'extension Cognitive Shield la possibilité d'utiliser les modèles de décision
[d3 de FastFlowLM](https://fastflowlm.com/docs/models/d3/) (serveur local sur NPU AMD,
API System One identique à Clef/Ollama), par défaut `d3:nano` sur `http://localhost:52625`.

## Fichiers modifiés

### `background.js`
- `DEFAULT_SETTINGS` : `fastflowlmEndpoint` (`http://localhost:52625`) et `fastflowlmModel` (`d3:nano`) ; provider élargi à `cloudflare | ollama | fastflowlm`.
- `activeProvider()` : tolère les trois valeurs.
- Nouvelle fonction `localEndpoint(settings)` : renvoie l'endpoint local du provider courant (ollama ou fastflowlm).
- `resolveOllamaEndpoint()` renommée `resolveSystemOneEndpoint()` (elle est générique, non spécifique à Ollama) ; normalise base → `/v1/systemone`.
- `syncOriginRule(provider, endpoint)` généralisée : règle declarativeNetRequest d'écrasement d'en-tête `Origin` appliquée à tout serveur local (Ollama **et** FastFlowLM), supprimée pour Cloudflare.
- `classify()` : branche unifiée pour les deux serveurs System One locaux (pas de token, endpoint partagé).
- `getSettings()` : normalisation/valeurs par défaut des nouveaux champs.
- Handlers `classify` / `test` / `storage.onChanged` : passent `localEndpoint()` au lieu de `s.ollamaEndpoint` ; le listener écoutait aussi `fastflowlmEndpoint`.

### `options.html`
- Nouvelle option dans le select provider : « FastFlowLM (local, décision d3) ».
- Nouvelle section `#fastflowlmSection` : URL backend (placeholder `http://localhost:52625`), champ modèle (`d3:nano`), hints (`flm serve --decision d3:nano`, `flm pull d3:nano`, ~2 Go, max 32 768 tokens, images acceptées, lien doc du jour page FastFlowLM).

### `options.js`
- `FASTFLOWLM_FIELDS`, `LOCAL_PROVIDERS`, `PROVIDER_SECTIONS` ; `syncProviderUI()` rendu générique (une section par provider).
- `fillForm`/`readForm` : gestion des deux nouveaux champs.
- `validate()` : endpoint + modèle locaux obligatoires pour les deux providers locaux.
- `save()`/`test()` : demande de permission host pour l'endpoint local courant ; résumé du test et messages d'erreur adaptés (suggestion `flm serve` / `flm pull` pour FastFlowLM).

### `manifest.json`
- Host permissions ajoutées : `http://localhost:52625/*` et `http://127.0.0.1:52625/*` (port par défaut de `flm serve`).

## Notes de conception
- FastFlowLM sert exactement la même API System One (`POST /v1/systemone`, corps `{state, questions, images?}`) ; aucun changement de parsing côté réponse (`answers.keep.noul`).
- Le provider n'est **pas** un modèle génératif : d3 renvoie des probabilités directes ; le pipeline `threshold`/`keep` existant s'applique tel quel.
- La règle `Origin` (declarativeNetRequest) est réutilisée pour FastFlowLM : un serveur local peut refuser `chrome-extension://` comme Ollama (403).

## Comment tester
1. `flm pull d3:nano` puis `flm serve --decision d3:nano` (attendre « Decision model ready »).
2. Recharger l'extension (chrome://extensions), ouvrir les réglages, choisir « FastFlowLM (local, décision d3) ».
3. « Tester la connexion » : attendu `probability` > seuil par défaut, ~0,5 s (Q4_K 2B).
