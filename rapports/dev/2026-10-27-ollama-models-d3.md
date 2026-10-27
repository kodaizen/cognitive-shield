# Modèles Ollama d3 dans le provider Ollama — 2026-10-27

## Objectif
Ajouter les modèles de décision [d3 de la bibliothèque Ollama](https://ollama.com/library/d3)
(vLLM Semantic Router) comme choix du provider « Ollama (local) », à côté de Clef.

## Modèles ajoutés
| Tag | Taille | Package | Contexte | Entrée |
| --- | --- | --- | --- | --- |
| `d3:2b` | 2B | ~3,1–3,2 Go | 256K | texte + image |
| `d3:4b` | 4B | ~5,6–5,8 Go | 256K | texte + image |
| `d3:9b` | 9B | ~10 Go | 256K | texte + image |
| `d3:27b` | 27B | ~29–30 Go | 256K | texte + image |

- Prérequis : Ollama ≥ 0.40.9. Les packages Ollama par défaut utilisent un contexte de 4 096 tokens à l'exécution (MXFP8 sur Apple Silicon, Q8_0 ailleurs).
- Licence Apache 2.0. Les checkpoints sont publiés par vLLM Semantic Router ; d3 est une famille de modèles de décision non génératifs (renvoie des probabilités directes).
- Le pipeline `threshold`/`keep` existant s'applique tel quel : même protocole System One, réponse parsée via `answers.keep.noul`.

## Fichiers modifiés

### `options.html`
- Select `#ollamaModel` : ajout de `d3:2b`, `d3:4b`, `d3:9b`, `d3:27b` (en plus de `clef-flash` / `clef`).
- Hint mis à jour : prérequis `ollama pull <modèle>` + version Ollama requise pour clef (≥ 0.35.1) et pour d3 (≥ 0.40.9), tailles des packages, lien vers la page bibliothèque Ollama d3.

## Notes de conception
- Aucune autre modification requise : endpoint, headers (règle `Origin`) et parsing de réponse sont génériques au protocole System One.
- Le modèle par défaut du provider Ollama reste `clef-flash` pour ne pas perturber les réglages existants ; `d3` est proposé en option.
- Les anciens réglages personnalisés sont préservés (option « (modèle personnalisé) » réinjectée par `options.js`).

## Comment tester
1. `ollama pull d3:2b` (ou une autre taille).
2. Recharger l'extension (chrome://extensions), ouvrir les réglages, provider « Ollama (local) », choisir `d3:2b`.
3. « Tester la connexion » : attendu `probabilite_vrai` > seuil par défaut ; comparer le temps de réponse avec `clef-flash`.
