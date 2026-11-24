# Orkas

**Une équipe open source d'agents IA sur votre ordinateur — elle transforme vos objectifs en travail abouti et fait avancer les choses.**

Orkas est une application de bureau multi-agents open source (MIT) qui privilégie le local — un assistant IA qui travaille en équipe. Dites au **Commander** ce dont vous avez besoin : il accomplit seul de nombreuses tâches et, pour les travaux plus importants, il planifie les étapes et fait appel à des agents spécialisés ainsi qu'aux agents de codage et aux agents personnels que vous utilisez déjà — **Claude Code, Codex, OpenCode, OpenClaw et Hermes-Agent** — pour qu'ils y travaillent ensemble.

Orkas est conçu pour faire avancer un projet, pas seulement pour répondre à une requête isolée. Un **projet** réunit l'objectif, les règles, la mémoire et les fichiers, si bien que chaque nouvelle conversation reprend là où la précédente s'est arrêtée. La liste **À faire** répartit le travail entre humains et agents, la **Progression automatique** permet à l'équipe de prendre d'elle-même la tâche suivante, et les **automatisations planifiées** répètent le travail de routine toutes les heures, tous les jours, toutes les semaines ou tous les mois. Toutes vos données restent sur votre ordinateur, et le travail terminé vous est soumis pour vérification — vous pouvez donc confier à Orkas, dans la durée, le travail de votre entreprise.

**[⬇ Télécharger Orkas pour macOS et Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — gratuit, avec 500 crédits pour le modèle Orkas intégré : pas besoin de clé API pour commencer. Vous préférez vos propres clés ? Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao, ou un point de terminaison local compatible OpenAI.

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Website: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Application de bureau Orkas — conversation d'une tâche et livrables](./resources/app-ui/task-en.png)

---

## Ce que l'équipe livre

- **Vidéos, voix off et images** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio), VoiceStudio, ImageStudio
- **Rapports de recherche, audits SEO et analyses de marché** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Publications, articles, newsletters et présentations** — ContentWriter, PptMaker
- **Sites web, interfaces et code** — UIDesigner, ProductDeveloper
- **Fichiers Word, Excel, PowerPoint et PDF** — OfficeWorker
- **E-commerce** — recherche de produits, fiches produits, analyse des avis, analyse des ventes et modifications du catalogue, assurées par cinq agents e-commerce
- **Travaux complexes qui demandent plusieurs agents** — le Commander les découpe, confie chaque partie à l'agent adapté et rassemble les résultats ; par exemple, une étude de marché qui devient un rapport, une présentation et une vidéo de lancement

16 spécialistes sont fournis avec l'application, chacun avec ses propres skills, sa mémoire et ses outils. Parcourez plus de 30 agents sur la [Marketplace des Agents](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas), ou décrivez le rôle dont vous avez besoin et le Commander crée pour vous un agent sur mesure.

<details>
<summary><b>Les 16 agents intégrés</b></summary>

| Domaine | Agent | Ce qu'il livre |
| --- | --- | --- |
| Recherche & analyse | **DeepResearcher** | Recherche fondée sur des preuves, avec sources vérifiées, contradictions signalées et rapport auditable |
| | **SeoGeoAgent** | Donnez-lui une URL — audit technique, qualité du contenu, Core Web Vitals, citabilité dans les réponses d'IA (GEO), liste de corrections classées par priorité |
| | **StockAnalyser** | Analyse d'actions, filtres factoriels, backtests et contrôles du risque de portefeuille, avec des tableaux de bord traçables |
| Contenu & médias | **ContentWriter** | Publications, articles, newsletters et études de cas prêts à publier, à partir d'un objectif, de sources ou d'un brouillon |
| | **PptMaker** | Présentations PPTX modifiables et faciles à relire, à partir d'un sujet, d'un plan ou d'un document |
| | **ImageStudio** | Affiches, couvertures, visuels pour les réseaux sociaux et infographies |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | Narration, présentateurs IA, sous-titres et doublage, extraits des meilleurs moments, localisation, et recréation de vidéos de référence avec vos propres contenus et séquences |
| | **VoiceStudio** | Narration, audio à plusieurs voix, transcriptions et sous-titres, montage et mixage audio |
| | **UIDesigner** | Interfaces modifiables, construites autour du HTML, à partir d'objectifs produit, de PRD, de captures d'écran ou d'éléments Figma |
| Développement & bureautique | **ProductDeveloper** | Développement qui tient compte de votre dépôt — implémenter un PRD, corriger des bugs, refactoriser, relire le code, avec des résultats vérifiables |
| | **OfficeWorker** | Créer, modifier, vérifier et livrer des fichiers Word / Excel / PowerPoint / PDF, un par un ou par lots |
| E-commerce | **ECommerceResearcher** | Sélection de produits selon le budget, le marché et les contraintes d'approvisionnement — candidats, motifs de rejet, plans de validation |
| | **ECommerceWriter** | Titres, pages produit, FAQ, textes pour les visuels et scripts vidéo dans le ton de votre marque |
| | **ECommerceReviewer** | Analyse des avis et de la réputation — thèmes récurrents chez les clients, causes profondes des avis négatifs, priorités |
| | **ECommerceAnalyzer** | Ventes, marges, publicités, remboursements et stocks à partir de vos exports — indicateurs rapprochés et décisions |
| | **ECommerceOperator** | Planifie les modifications de catalogue, de prix, de promotions et de stocks ; n'exécute qu'au moyen des outils que vous connectez |

En savoir plus sur chaque agent → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### Recréer une vidéo de référence avec vos propres contenus

**VideoStudio** peut reproduire la structure narrative, le style visuel et le rythme de montage d'une vidéo virale avec votre propre produit, votre script et vos séquences. Fournissez un fichier vidéo de référence et vos ressources : l'agent analyse l'accroche, l'ordre des informations, les temps forts visuels et l'appel à l'action, puis propose ce qu'il faut conserver et ce qu'il faut remplacer avant la production.

Cela fonctionne au mieux avec les vidéos explicatives en motion design, les démos de SaaS ou d'applications et les publicités produit construites à partir de vos séquences existantes. Les textes, sous-titres, narrations et clips créés localement peuvent être révisés séparément ; le texte incrusté dans des séquences générées par IA ne peut être modifié qu'en changeant ces séquences.

> « Utilise reference.mp4 comme référence pour une vidéo promo verticale de 30 secondes. Garde son accroche, sa typographie et son rythme, remplace le contenu par mon produit et mes enregistrements d'écran, et montre-moi d'abord l'analyse et le plan. »

Commencez par un fichier vidéo que l'agent peut lire ; le téléchargement à partir de liens de partage des réseaux sociaux n'est pas intégré. Les mouvements de caméra exacts, le jeu des personnes à l'écran et la correspondance image par image ne sont pas garantis. Consultez le [processus de recréation à partir d'une référence](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md).

---

## Faire avancer le travail

Une tâche, c'est un bon début. Orkas est conçu pour le travail qui se poursuit.

- **Projets** — objectifs & règles, mémoire et fichiers dont part chaque conversation du projet : vous n'avez jamais à tout réexpliquer depuis le début.
- **À faire et Progression automatique** — chaque projet a une liste de tâches à faire pour les humains et les agents ; quand la Progression automatique est activée, l'équipe prend d'elle-même l'élément suivant et vous soumet le travail terminé pour vérification.
- **Automatisations planifiées** — exécutez n'importe quelle tâche toutes les heures, tous les jours, toutes les semaines ou tous les mois. Orkas fonctionne sur votre ordinateur. À partir de la v1.9, au réveil de l'ordinateur ou au démarrage d'Orkas, chaque automatisation rattrape sa dernière exécution manquée si celle-ci remonte à moins de 12 heures.
- **Connecteurs** — Gmail, Google Calendar, Sheets et Drive, Notion, Slack, Shopify, Stripe et bien d'autres. Par défaut, Orkas demande votre accord avant d'envoyer, de publier ou de supprimer quoi que ce soit.
- **Applications** — décrivez un outil et Orkas le construit sous forme d'application locale au sein de l'application de bureau. Dans l'application installable, les offres payantes permettent aussi de la publier comme application web avec un lien public.
- **Projets partagés** *(application installable)* — invitez un coéquipier ou un assistant virtuel, et attribuez chaque tâche à faire à une personne ou à un agent.

> [!NOTE]
> Les projets partagés, la synchronisation cloud et la publication d'applications web sont réservés à l'application installable — la version open source ne les prend pas encore en charge. Pour les utiliser, **[téléchargez Orkas pour macOS et Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (gratuit, avec 500 crédits pour commencer).

La saisie vocale fonctionne aussi dans la version source. Configurez une **Orkas API Key** dans **Paramètres → Modèles**, puis cliquez sur le micro à côté de la zone de saisie. Autorisez l'accès au micro lorsque le système vous le demande. L'audio est envoyé à Orkas pour la reconnaissance et consomme les crédits Orkas du propriétaire de la clé. Cliquez à nouveau pour arrêter, relisez le texte, puis envoyez-le vous-même. Si vous avez refusé l'accès, activez le micro dans les réglages de votre système.

---

## Faire travailler ensemble Claude Code, Codex, OpenCode, OpenClaw et Hermes-Agent

Orkas exécute les agents CLI que vous avez déjà installés sous forme de sessions locales, aux côtés de ses propres spécialistes — les agents de codage **Claude Code, Codex et OpenCode**, et les agents personnels **OpenClaw et Hermes-Agent**. Le Commander confie à chacun la partie où il excelle et maintient un plan unique pour tous, si bien qu'une seule conversation peut corriger le bug, relire la modification et rédiger les notes de version. Les outils open source comme HyperFrames s'intègrent de la même façon.

[Utiliser Claude Code et Codex ensemble →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Pourquoi Orkas

- **Un Commander qui planifie, délègue et fait le reste** — il décompose les objectifs, choisit les bons agents, skills, connecteurs et outils, et se charge lui-même de l'analyse, de la rédaction, de la recherche et du travail sur les fichiers quand aucun spécialiste n'est mieux adapté.
- **Conçu pour privilégier le local** — conversations, fichiers, bases de connaissances et agents personnalisés restent par défaut sur votre disque. La synchronisation cloud est facultative dans l'application installable. Avec vos propres clés, les appels aux modèles vont directement de votre machine au fournisseur ; le modèle Orkas intégré passe par le service de modèles géré par Orkas.
- **N'importe quel modèle, modifiable à tout moment** — le Commander et les agents intégrés partagent un même réglage de modèle : le modèle Orkas intégré, votre propre fournisseur ou un point de terminaison local. Les agents CLI externes conservent leurs propres réglages de modèle.
- **Des agents qui s'améliorent** — chaque agent dispose de skills et d'une mémoire qui lui sont propres. Des revues en arrière-plan examinent la nouvelle activité quand l'application est inactive et peuvent affiner l'auto-évaluation, les méthodes réutilisables et les skills acquis.
- **Open source, sans boîte noire** — sous licence MIT. Lisez exactement ce que font Orkas, chaque agent et chaque skill.

> ⭐ Si Orkas vous est utile, une étoile aide davantage de personnes à découvrir le projet.

---

## Téléchargement

| | Application installable (recommandée) | Exécution depuis les sources |
| --- | --- | --- |
| Plateformes | macOS 12+ (Apple Silicon et Intel), Windows 10+ | macOS, Windows, Linux x64/arm64 avec glibc 2.34+ |
| Compte | Connexion — 500 crédits gratuits | Aucun |
| Modèles | Modèle Orkas intégré ou vos propres clés | Vos propres clés ou un point de terminaison local |
| Inclut aussi | Collaboration sur les projets, publication d'applications, synchronisation cloud, et plus encore | — |
| Obtenir | **[Télécharger Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Démarrage rapide](#démarrage-rapide) |

Le lien de téléchargement détecte votre système et lance le bon programme d'installation.

---

## Ce que les utilisateurs en font

- **Contenu marketing** — vidéos de lancement, pages produit, publications et newsletters dans votre ton. [Rédaction de contenu](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Vidéos](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Gestion de boutique** — bilans hebdomadaires des ventes, réponses aux avis, fiches produits et veille concurrentielle. [E-commerce](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Recherche et rapports** — rapports et présentations sourcés, à la demande ou chaque semaine. [Recherche](https://orkas.ai/use/researchers/?source=gh-orkas) · [Analyse de données](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Discuter avec vos documents** — des réponses fondées sur vos propres fichiers, avec des citations qui renvoient aux passages sources. [Discuter avec des documents](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Travail pour vos clients** — notes de préparation de réunion, rapports clients mensuels et présentations de suivi selon votre modèle. [Modèle de rapport client mensuel](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Lancement de produit** — pages de destination, corrections de bugs avec tests, changelogs et publications de lancement. [Développeurs](https://orkas.ai/use/developers/?source=gh-orkas)
- **Créer une application** — calculateurs de devis, formulaires de réservation, outils internes. [Créer des applications](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Petites équipes** — un seul projet pour les humains et les agents. [Petites équipes](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas face aux autres outils

| Outil | Ce que c'est | En quoi Orkas se distingue |
| --- | --- | --- |
| **Claude Code** | L'outil de développement agentique d'Anthropic — dans le terminal, l'IDE, sur ordinateur et sur le web, basé sur les modèles Claude. | Pas besoin de choisir : Orkas exécute Claude Code comme l'un de ses agents. Autour de lui, Orkas ajoute une équipe indépendante du modèle pour le travail au-delà du code — recherche, contenu, vidéo et plus encore — avec des projets, des tâches à faire et des automatisations qui font avancer le travail. [Orkas vs Claude Code →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | L'agent de codage d'OpenAI — dans le terminal, votre éditeur et le cloud. | Pas besoin de choisir : Orkas exécute Codex comme l'un de ses agents, aux côtés de Claude Code et d'OpenCode. Le Commander peut confier le code à Codex et la relecture à un autre agent, puis prendre en charge la moitié d'une sortie qui ne relève pas du code — documentation, publications de lancement et vidéos. [Orkas vs Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | L'agent d'Anthropic pour le travail quotidien, désormais intégré à Claude — sur ordinateur, sur le web et sur mobile avec un abonnement Claude payant. Il s'exécute par défaut dans le cloud d'Anthropic et utilise les modèles Claude. | Une alternative open source (MIT) à Claude Cowork, gratuite pour commencer, avec 500 crédits. Orkas exécute ses agents sur votre ordinateur et garde vos données en local par défaut, avec le modèle Orkas intégré, vos propres clés de fournisseur ou un point de terminaison local. Le Commander peut aussi faire appel à Claude Code, à Codex et à d'autres agents CLI. La contrepartie : Orkas a besoin que votre ordinateur ne soit pas en veille, alors que les tâches cloud de Cowork peuvent continuer sans lui. [Alternatives à Claude Cowork →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | Un agent IA qui, par défaut, planifie et exécute les tâches dans le cloud de Manus. L'application de bureau Manus Studio (macOS et Windows) peut aussi travailler dans un dossier de votre choix, les tâches restant planifiées dans le cloud. | Une alternative open source (MIT) à Manus. Orkas exécute ses agents sur votre ordinateur et garde vos données en local par défaut, avec le modèle Orkas intégré, vos propres clés de fournisseur ou un point de terminaison local. Les projets, les tâches à faire et les automatisations font avancer le travail. La contrepartie : Orkas a besoin que votre ordinateur ne soit pas en veille, alors que les tâches cloud de Manus peuvent continuer sans lui. [Alternative open source à Manus →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | Un framework (ou bibliothèque) pour développeurs servant à créer des applications et des agents LLM — centré sur le code, intégré à votre propre application Python/JS. | Orkas est une application de bureau que vous pilotez par la conversation, sans écrire de code d'orchestration. Les données restent en local par défaut. |
| **CrewAI** | Un framework Python pour orchestrer des agents autonomes qui jouent chacun un rôle — vous définissez les équipes (crews) et les agents dans le code. | Orkas apporte l'orchestration multi-agents dans une application de bureau, avec projets, tâches à faire, automatisations et auto-amélioration de chaque agent intégrés. |
| **OpenClaw** | Une plateforme d'agents personnels avec intégrations de messagerie, routage multi-agents et sous-agents. | Orkas fournit un espace de travail de bureau pour obtenir des livrables finis, avec des spécialistes intégrés et une coordination entre Claude Code, Codex, OpenCode et d'autres agents CLI. OpenClaw peut rejoindre ce flux de travail en tant qu'agent CLI. |
| **Hermes-Agent** | L'agent auto-améliorant de Nous Research — un seul agent doté d'une mémoire et de skills, disponible en CLI, en passerelle de messagerie et en application de bureau. | Orkas coordonne une équipe : le Commander dirige de nombreux spécialistes et d'autres agents CLI, et Hermes-Agent s'y intègre comme l'un d'eux. |

**Orkas est fait pour vous si** vous voulez une équipe d'agents plutôt qu'un seul assistant, un travail qui avance sur plusieurs jours, et vos données, vos clés et vos agents sur votre propre disque.

**Pas pour vous si** vous voulez seulement un chatbot généraliste unique, ou une simple bibliothèque de code à intégrer dans votre propre application.

**Vous hésitez entre plusieurs agents de codage ?** [Codex vs OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs Codex vs OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Alternatives à Claude Code](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Comparaisons détaillées côte à côte →** [vs Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [vs Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [vs Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## Démarrage rapide

Vous préférez un programme d'installation tout prêt ? Voir [Téléchargement](#téléchargement) plus haut. Pour exécuter Orkas depuis les sources — c'est actuellement ainsi qu'on l'utilise sous Linux :

**Prérequis** : Node 22.12+ · macOS / Windows 10+ / glibc 2.34+ Linux x64 ou arm64. Gardez Python 3 et une chaîne de compilation C/C++ à disposition pour le cas, peu fréquent, où les modules natifs doivent être compilés depuis les sources.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Sous Linux, l'exécution depuis les sources nécessite glibc 2.34+. Alpine et les autres distributions basées sur musl ne sont pas prises en charge. Pour la transcription vocale locale, le runtime whisper.cpp natif de la plateforme cible et le modèle multilingue sont téléchargés et vérifiés lors du premier lancement depuis les sources.

`run.sh` / `run.cmd` installe l'arborescence de dépendances npm verrouillée et prépare, au premier lancement, les ressources aux versions figées : Python, uv, Node, modèle d'embedding (~95 MB), OfficeCLI, FFmpeg, whisper.cpp et modèle vocal multilingue. Sous Linux, le démarrage vérifie ensuite les modules natifs de la plateforme et le runtime Whisper avec l'ABI d'Electron avant d'ouvrir l'application. Les paquets Python propres à l'OCR et à certains skills sont installés dans des environnements locaux isolés lors de la première utilisation de ces fonctions. Le premier lancement crée un espace de travail sous `~/.orkas/` (macOS / Linux) ou `<smallest non-system drive>:\.orkas\` (Windows). Ouvrez ensuite **Paramètres → Fournisseurs d'IA** pour ajouter une clé API ou une connexion OAuth.

Erreurs de dépendances natives : utilisez Node.js 24 LTS (minimum 22.12.0), puis exécutez
`npm run native:repair` depuis cette copie du dépôt. Cette commande restaure les paquets optionnels,
répare SQLite pour Electron, prépare le Node fourni pour le traitement d'images isolé,
et vérifie SQL, sqlite-vec et sharp avant de signaler la réussite.
Utilisez `npm run native:check` pour une simple vérification, sans installation.
Consultez le [script de vérification des dépendances natives](./scripts/verify-native-dependencies.cjs) pour connaître les vérifications effectuées.

---

## Fonctionnement

### Routage des tâches

Le Commander traite lui-même le travail général et délègue le travail spécialisé au moyen de trois outils :

- **`dispatch_to`** exécute un agent désigné par son nom et renvoie son résultat pour la suite du travail. Il peut attendre le résultat, ou s'exécuter de manière asynchrone et prévenir le Commander lorsque la tâche est terminée.
- **`hand_off_to`** transfère le travail restant à un agent désigné par son nom et met fin au tour actuel du Commander. L'agent fournit sa propre réponse ; une continuation facultative permet ensuite au Commander de reprendre une tâche plus large.
- **`run_worker`** exécute une sous-tâche anonyme et isolée et renvoie un résultat privé. Il ne reçoit ni l'historique de la conversation ni les skills d'un agent désigné.

Les tâches des agents désignés et les workers anonymes disposent de contrôles de concurrence distincts. Voir l'[implémentation du dispatch](./src/main/features/group_chat/bus.ts) et les [verrous d'exécution](./src/main/util/locks.ts).

### Gestion du contexte

Le runtime calcule le budget de contexte en fonction de la capacité d'entrée utilisable du modèle sélectionné, en tenant compte des prompts, des outils et de l'état persistant du runtime. Les dialogues terminés utilisent une fenêtre d'historique récent limitée ; les longues tâches en cours utilisent des points de contrôle pour condenser les messages de processus antérieurs tout en conservant le travail récent. Les lectures de fichiers, les modifications de fichiers et les exécutions de commandes disposent aussi d'enregistrements structurés qui peuvent survivre à la compaction du contexte.

Voir [budgets de contexte](./src/core-agent/src/agent/context-budget.ts), [historique de session et points de contrôle](./src/core-agent/src/agent/session.ts) et [enregistrements de l'espace de travail](./src/core-agent/src/agent/workspace-state.ts).

### Mémoire et Bibliothèque

Des notes durables conservent les préférences de l'utilisateur, les informations sur le projet et les connaissances réutilisables de chaque agent dans des périmètres séparés. Ces notes sont distinctes de l'index documentaire de la Bibliothèque et de l'historique des conversations enregistré.

La Bibliothèque découpe les documents en passages et stocke un index vectoriel SQLite local. Son modèle d'embedding s'exécute sur votre machine ; l'outil `library` peut lister des fichiers, rechercher des passages pertinents et lire le contenu source depuis la Bibliothèque globale ou celle du projet en cours. Les conversations antérieures sont récupérées séparément via `chat_history`.

Voir [mémoire par périmètre](./src/main/features/memory.ts), [extraction de documents](./src/main/util/file_to_chunks.ts), [outils de la Bibliothèque](./src/main/model/core-agent/kb-tools.ts) et [récupération des conversations](./src/main/model/core-agent/chat-history-tools.ts).

### Limites d'exécution et reprise

Les verrous de session et les limites de concurrence encadrent le travail en parallèle. Les budgets de tours d'outils, les points de contrôle de progression, la détection des appels répétés et des watchdogs d'inactivité adaptés à chaque phase aident à contenir les exécutions qui se bloquent ou répètent du travail. Les tâches des agents désignés peuvent être suivies et annulées individuellement ; une tâche acceptée ou en file d'attente n'est pas considérée comme un résultat terminé.

Voir les [budgets par acteur](./src/main/features/group_chat/actor-budgets.ts), le [runtime des agents](./src/core-agent/src/agent/runner.ts) et l'[adaptateur de modèle de l'application de bureau](./src/main/model/core-agent/client.ts).

### Apprendre de l'activité

Des revues en arrière-plan examinent la nouvelle activité des agents quand l'application est inactive, sous réserve de délais d'attente entre deux revues et de limites d'exécution. Une revue peut mettre à jour l'auto-évaluation d'un agent (`COMPETENCE.md`), ses méthodes réutilisables (`LEARNING_STRATEGIES.md`) ou ses skills acquis. Les revues dépendent de la nouvelle activité plutôt que du nombre de tâches, et peuvent conclure que rien ne mérite d'être conservé.

Voir le [planificateur de réflexion](./src/main/features/reflection-orchestrator.ts) et le [prompt de revue](./src/core-agent/src/evolution/metacognition.ts).

---

## Questions fréquentes

**Qu'est-ce qu'Orkas ?**
Orkas est une application de bureau multi-agents open source (MIT) qui privilégie le local. Son Commander transforme votre objectif en tâches à faire et coordonne 16 agents spécialisés intégrés — ainsi que Claude Code, Codex, OpenCode, OpenClaw et Hermes-Agent — pour livrer des fichiers finis. Ce n'est ni un chatbot unique, ni un framework de code, ni un SaaS hébergé.

**Ai-je besoin d'une clé API ?**
Non. L'application installable inclut 500 crédits pour le modèle Orkas intégré. Ensuite, vous pouvez acheter des crédits, choisir une offre payante ou ajouter vos propres clés de fournisseur ; les frais des fournisseurs sont facturés à part.

**Orkas est-il un LLM local ?**
Non. Orkas s'exécute sur votre machine et appelle les modèles que vous choisissez — le modèle Orkas intégré, vos propres clés API ou un point de terminaison de modèle local. Il orchestre des agents et des outils ; il n'est pas lui-même un modèle.

**Orkas peut-il répondre à des questions à partir de mes documents, avec des citations ?**
Oui. Ajoutez des PDF et des documents à votre Bibliothèque locale ; Orkas peut y effectuer des recherches et répondre en citant les passages sources, pour que vous puissiez ouvrir l'original et vérifier. L'index est construit sur votre machine.

**Puis-je utiliser des modèles locaux comme Ollama ou LM Studio ?**
Oui. Ouvrez **Paramètres du compte → Modèles → Conversation → Ajouter un modèle → Personnalisé**, sélectionnez **Compatible OpenAI** ou **Compatible Anthropic**, puis saisissez l'URL de base, l'ID exact du modèle et la clé API. Choisissez ensuite le modèle enregistré dans le sélecteur de modèle de la tâche.

**Où sont stockées mes clés API et mes données ?**
Sur votre disque, par défaut. Vos propres clés de fournisseur sont chiffrées localement et exclues de la synchronisation cloud. Avec vos propres clés, les appels aux modèles vont directement de votre machine au fournisseur ; le modèle Orkas intégré utilise le service géré d'Orkas. La synchronisation cloud facultative et les projets partagés de l'application installable stockent les données sélectionnées sur les serveurs d'Orkas. [Sécurité et traitement des données →](https://orkas.ai/security/?source=gh-orkas)

**Orkas fonctionne-t-il hors ligne ?**
La version source peut fonctionner entièrement hors ligne avec un point de terminaison de modèle local. L'application installable nécessite de se connecter à un compte, et les modèles cloud ont besoin d'une connexion réseau.

**Orkas continue-t-il de travailler quand mon ordinateur est éteint ?**
Non — Orkas fonctionne sur votre ordinateur : la Progression automatique et les automatisations nécessitent que l'ordinateur ne soit pas en veille et qu'Orkas soit lancé. À partir de la v1.9, au réveil de l'ordinateur ou au démarrage d'Orkas, chaque automatisation rattrape sa dernière exécution manquée si celle-ci remonte à moins de 12 heures.

**Puis-je créer et publier des applications ?**
Oui. Les applications locales qui s'exécutent dans Orkas sont gratuites. Publier une application web sur un lien public nécessite une offre payante (Lite 5, Pro 8, Max 15 applications), et les applications web publiées n'offrent pas toutes les fonctionnalités disponibles dans Orkas.

**Ai-je besoin d'un compte Orkas ?**
L'application de bureau installable vous demande de vous connecter au premier lancement. La version source de ce dépôt n'a aucune couche de compte — elle démarre directement dans l'application.

**Orkas peut-il piloter Claude Code et d'autres agents CLI ?**
Oui. Orkas peut piloter cinq agents CLI externes sous forme de sous-processus locaux — les agents de codage Claude Code, Codex et OpenCode, ainsi que les agents personnels OpenClaw et Hermes-Agent — et intégrer des projets open source comme HyperFrames, le tout depuis la même conversation.

**En quoi Orkas diffère-t-il de Claude Code / Codex / CrewAI / LangChain ?**
Claude Code et Codex sont des agents de codage — Orkas les exécute tous deux comme membres de son équipe, vous n'avez donc pas à choisir entre eux ; CrewAI et LangChain sont des frameworks centrés sur le code. Orkas est une application de bureau open source dans laquelle un Commander coordonne une équipe d'agents spécialisés et vos agents CLI, avec n'importe quel fournisseur de modèles, et garde les données et les clés en local. Voir les [comparaisons complètes](https://orkas.ai/compare/?source=gh-orkas).

**Quelles plateformes Orkas prend-il en charge ?**
macOS 12+ (Apple Silicon et Intel) et Windows 10+ disposent de programmes d'installation. Linux x64/arm64 avec glibc 2.34+ fonctionne aujourd'hui depuis les sources, sans programme d'installation pour l'instant. La transcription vocale locale est prise en charge sous Linux grâce au runtime whisper.cpp à version figée, préparé au premier lancement. Alpine et les autres distributions basées sur musl ne sont pas prises en charge. Le démarrage depuis les sources nécessite Node 22.12+ ; Python 3 et une chaîne de compilation C/C++ ne sont nécessaires que lorsqu'un paquet npm natif n'a pas de binaire précompilé compatible et doit être recompilé localement.

**Orkas est-il gratuit et open source ?**
Oui — l'application est sous licence MIT et son utilisation est gratuite. L'application installable inclut 500 crédits pour le modèle Orkas intégré ; les offres payantes, à partir de $11.99/mois, ajoutent des crédits mensuels, la synchronisation cloud, davantage de projets partagés et la publication d'applications. Avec vos propres clés, l'utilisation des modèles est facturée par votre fournisseur ; Orkas n'ajoute aucune marge. [Tarifs →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Licence

[MIT](./LICENSE)
