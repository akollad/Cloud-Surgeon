# Plan sur 1 mois — viser la 1ère place (CockroachDB x AWS 2026)
*(v3 — révisé : originalité approfondie, couverture explicite des 5 critères, Bedrock retiré du chemin critique, + 7 renforts ciblés sur les points faibles : impact chiffré, coût réel, sécurité anti-injection, chaos engineering élargi, calibration de la confiance, boucle humain→mémoire, vision multi-cloud/multi-tenant)*

## Pourquoi cette révision
La v1 avait une seule originalité (mémoire "active") suffisamment développée ;
les deux autres angles (multi-agents, panne de nœud) étaient esquissés, pas
conçus jusqu'au bout, et le document ne montrait pas explicitement comment
chaque semaine sert chacun des 5 critères. Cette version corrige les deux :
une originalité unique mais poussée à fond, techniquement précise, et une
table de correspondance explicite critère → livrable pour qu'aucun des 5 ne
soit implicite.

Bedrock est retiré des tâches bloquantes : l'équipe s'en occupe séparément.
Le plan est conçu pour que tout le reste avance indépendamment, et pour que
la connexion Bedrock s'insère proprement dès qu'elle est prête (voir
"Point d'intégration Bedrock" en fin de document).

---

## L'originalité, poussée à fond : "un agent qui n'est pas juste résilient — sa mémoire l'est aussi, et elle apprend"

Le problème du positionnement précédent : "confidence gating + multi-agents +
panne de nœud" sonnait comme trois fonctionnalités juxtaposées. La version
poussée les unifie en **un seul mécanisme cohérent en trois couches**, chacune
dépendant de la précédente — ce n'est plus une liste de features, c'est une
architecture.

### Couche 1 — Mémoire causale et évaluée (pas juste "similaire")
Aujourd'hui, le RAG retourne "l'incident le plus proche" par cosinus, point.
Poussé à fond :
- Chaque vecteur stocké porte la **stratégie de résolution utilisée** et son
  **résultat réel** (succès/échec, temps de résolution, nombre de tours).
- Une requête d'agrégation SQL calcule, pour chaque type d'incident, un
  **taux de succès par stratégie** — un bandit contextuel entièrement porté
  par CockroachDB (`SELECT strategy_name, count(*) FILTER (WHERE outcome_success) * 1.0 / count(*) AS win_rate ...`),
  sans service ML externe.
- Les incidents sont chaînés causalement (`caused_by_incident_id`,
  auto-référence) : un incident B provoqué par les effets de bord de la
  réparation A est retrouvé par une **CTE récursive** (`WITH RECURSIVE`),
  ce que ni un simple vector store ni une base non-relationnelle ne peuvent
  faire aussi naturellement — c'est un usage typiquement CockroachDB/SQL
  qu'aucun concurrent avec Pinecone/Chroma ne pourra revendiquer.
- **Renfort — calibration de la confiance** : le win-rate n'est pas utilisé
  one-shot. Une tâche périodique compare, pour chaque stratégie, le win-rate
  *prédit au moment de la décision* et le win-rate *réel observé depuis* ; si
  l'écart dépasse un seuil, la stratégie est automatiquement rétrogradée
  (moins de poids dans la couche 2) même si son win-rate historique brut
  reste élevé. Ça prouve que la mémoire s'auto-corrige, pas seulement
  qu'elle accumule.

### Couche 2 — La mémoire décide, elle n'affiche pas
Le score de similarité + le taux de succès de la couche 1 pilotent un vrai
embranchement de décision :
- **Score fort + stratégie historiquement fiable (>80% de succès)** →
  exécution autonome immédiate.
- **Score moyen ou stratégie peu fiable** → plan proposé, exécution différée
  jusqu'à approbation humaine (visible sur le dashboard).
- **Aucun match / stratégie jamais tentée** → mode exploratoire : plus de
  tours de diagnostic avant toute action corrective, et la nouvelle
  stratégie tentée est explicitement marquée "expérimentale" dans la base.
Chaque issue (succès/échec) réalimente la couche 1 — boucle fermée,
apprentissage réel sur incidents réels, pas un one-shot.

### Couche 3 — La coordination elle-même passe par CockroachDB, et survit à sa panne
Trois agents spécialisés (Diagnostician, Remediator, Auditor) se relaient sur
un même incident via des **transactions sérialisables** CockroachDB
(réclamation par `UPDATE ... WHERE claimed_by_agent IS NULL RETURNING *`,
retry automatique sur conflit de sérialisation) — la base de données est
littéralement l'arbitre de qui a le droit d'agir. En démo live, on tue un
nœud du cluster CockroachDB **pendant** qu'un incident est en cours de
traitement par ces agents : la réclamation en cours, l'historique causal, et
les statistiques de stratégie restent lisibles et cohérents parce que
CockroachDB réplique et fait consensus au niveau des données — pas parce que
le code de l'agent a un mécanisme de retry maison.

**Le narratif final, en une phrase** : *"Notre agent n'apprend pas seulement
de ses incidents passés — il calcule statistiquement quelles stratégies
fonctionnent, se coordonne avec d'autres agents via de vraies transactions,
et tout cet appareil de décision continue de fonctionner même quand on
débranche une partie de la base qui le porte."* C'est directement la
réponse à "pourquoi CockroachDB et pas Postgres+pgvector ?", et c'est
exactement l'angle "insight sur ce qui rend les systèmes agentiques
différents" que le critère Creativity demande explicitement.

---

## Table de correspondance — aucun critère laissé de côté

| Critère | Ce qui le sert dans ce plan | Semaine |
|---|---|---|
| **Agentic Memory Design** | Couche 1 (mémoire causale + évaluée) ; volumétrie réaliste testée (des centaines d'incidents synthétiques + réels, pas 3 lignes de démo) | S1-S2 |
| **Technical Implementation** | Transactions sérialisables (couche 3), CTE récursive (couche 1), MCP Server, intégration ccloud/Cloud API déjà réelle, gestion propre des conflits de concurrence | S1-S3 |
| **Real-World Impact** | Ingestion réelle depuis une source d'alerte externe (AWS CloudWatch Alarm → SNS → webhook), 5+ scénarios d'incidents distincts, mode "approbation humaine" qui reflète un vrai besoin opérationnel de confiance graduée | S1, S3 |
| **Production Readiness** | Rate limiting, tests automatisés incl. test de crash en CI, observabilité (latence, taux d'autonomie, win-rate par stratégie), déploiement réel, revue de sécurité, moindre privilège du service account | S3 |
| **Creativity & Originality** | L'architecture à 3 couches dans son ensemble — c'est le point culminant de la démo, pas une fonctionnalité annexe | S2, présentée S4 |

---

## Semaine 1 — Fondations : ingestion réelle + scénarios variés + schéma étendu
- [ ] Étendre le schéma (déjà commencé) : `incident_vectors.strategy_name` /
      `outcome_success` / `incident_id`, `incident_state.caused_by_incident_id`
      / `claimed_by_agent`, nouvelle table `agent_handoffs`.
- [ ] Point d'entrée réel : endpoint webhook qui accepte un format d'alarme
      AWS CloudWatch/SNS (pas seulement un `alertText` free-form envoyé à la
      main) — preuve que ça s'intègre dans un vrai pipeline d'ops.
- [ ] 5-6 scénarios d'incidents distincts avec des signatures d'erreur
      réalistes (fuite mémoire, pool de connexions saturé, latence
      cross-région, credential AWS expiré, disque plein, dépendance externe
      down) pour alimenter une vraie base de connaissance, pas un seul cas.
- [ ] Remplacer l'action AWS simulée par une vraie action non destructive
      (lecture d'état réel) pour prouver l'intégration AWS sans risque.

## Semaine 2 — Construire l'architecture à 3 couches
- [ ] Couche 1 : requêtes d'agrégation de win-rate par stratégie + CTE
      récursive de chaînage causal, exposées et testées.
- [ ] Couche 2 : le routage par confiance (autonome / approbation / mode
      exploratoire) branché sur les résultats de la couche 1, avec
      réinjection systématique de l'issue de chaque incident.
- [ ] Couche 3 : les 3 agents spécialisés + réclamation transactionnelle
      (gestion des conflits de sérialisation avec retry), journalisée dans
      `agent_handoffs`.
- [ ] Script de panne de nœud/région CockroachDB en conditions contrôlées,
      avec vérification automatisée que l'état reste cohérent pendant la
      panne partielle.
- [ ] Dashboard : vue "pourquoi cette décision" (score de similarité,
      win-rate de la stratégie choisie, agent en charge, statut du cluster).

## Semaine 3 — Production readiness (rigueur, pas de créativité requise, juste ne rien manquer)
- [ ] Rate limiting par clé API.
- [ ] Suite de tests automatisés : logique de décision, flux complet
      trigger→resolve, reprise après crash réel automatisée en CI
      (industrialiser `real-crash-test.sh`), conflits de réclamation
      concurrents entre agents.
- [ ] Observabilité : latence par outil, taux de résolution autonome vs.
      escaladée, distribution des win-rates, requêtes système CockroachDB
      (`crdb_internal`) affichées pour montrer la charge réelle du cluster.
- [ ] Déploiement réel du serveur API + vérification bout en bout en
      production (auth, MCP, CockroachDB, webhook d'ingestion).
- [ ] Revue de sécurité : secrets, validation des entrées, permissions du
      service account CockroachDB Cloud au moindre privilège, protection
      contre l'abus du webhook public.

## Semaine 4 — Pitch, preuve, répétition
- [ ] Narratif de pitch construit explicitement autour de l'architecture à 3
      couches (voir phrase finale ci-dessus), pas une liste de features.
- [ ] Vidéo de démo (2-3 min) : un incident résolu en autonomie grâce à un
      win-rate élevé, un incident causalement lié retrouvé par CTE
      récursive, un handoff multi-agents visible, puis la coupure de
      nœud/région CockroachDB en plein traitement sans perte d'état.
- [ ] Diagramme d'architecture (3 couches, agents, MCP, CockroachDB, AWS,
      webhook d'ingestion) pour le README et la soumission.
- [ ] Répétition chronométrée + anticipation de la question la plus probable
      du jury : "pourquoi CockroachDB et pas Postgres+pgvector ?" — la
      réponse tient dans la couche 3, pas dans le vector store.
- [ ] Nettoyage final, README à jour, aucune démo montrant un comportement
      non annoncé.

---

## Point d'intégration Bedrock (pas sur le chemin critique)
Dès que la connexion Bedrock est prête côté équipe, elle s'insère sans
retoucher l'architecture : `invokeBedrockThought()` génère déjà le texte de
raisonnement par tour avec fallback transparent (`thoughtSource`) — il suffit
qu'un vrai appel réussisse pour que `thoughtSource: "bedrock"` s'affiche
partout. Aucune dépendance des couches 1-3 sur Bedrock : la décision
(autonome/approbation/exploratoire) et la coordination multi-agents
fonctionnent déjà indépendamment du texte de pensée généré.

## Priorisation si le temps manque
1. Couche 3 (multi-agents + transactions) — la plus différenciante, la plus
   "CockroachDB-native", la plus visuelle en démo.
2. Couche 1 + 2 (mémoire causale/évaluée + décision) — renforce Agentic
   Memory Design et Creativity simultanément.
3. Semaine 3 (production readiness) — gain fiable, faible risque.
4. Démo de panne de nœud en live — la plus spectaculaire mais aussi la plus
   risquée le jour J ; à ne tenter qu'avec le reste solide et du temps de
   répétition.
