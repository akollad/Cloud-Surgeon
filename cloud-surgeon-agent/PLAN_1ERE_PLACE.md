# Plan sur 1 mois — viser la 1ère place (CockroachDB x AWS 2026)

Objectif : ne plus seulement "cocher" les 5 critères, mais dominer sur au
moins 2-3 d'entre eux, en particulier Creativity & Originality — c'est le
seul critère que le travail technique de ce mois ne peut pas racheter s'il
n'est pas explicitement construit pour.

## Le pari central : arrêter d'utiliser CockroachDB comme "un Postgres avec
des vecteurs" et l'utiliser pour ce qui le rend unique — une base SQL
**distribuée**. Trois angles d'originalité en découlent, tous nouveaux par
rapport à l'état actuel :

### Originalité #1 — Mémoire active, pas juste consultable
Aujourd'hui : le RAG retrouve un incident similaire, mais ça ne sert qu'à
être loggé/affiché. Nouveau : le score de similarité vectorielle devient un
**vrai signal de décision**.
- Similarité > seuil haut → l'agent exécute la stratégie de résolution qui a
  fonctionné la dernière fois, en autonomie complète.
- Similarité moyenne → l'agent propose un plan mais attend une approbation
  humaine avant d'exécuter une action corrective.
- Aucun match → l'agent explore avec plus de prudence (plus de tours de
  diagnostic avant toute action).
- Chaque résolution (succès ou échec) est réinjectée comme nouvel embedding
  avec son résultat — la base de connaissance de l'agent s'auto-enrichit à
  chaque incident réel. C'est un vrai closed-loop learning, pas un simple
  historique.

### Originalité #2 — Coordination multi-agents via transactions CockroachDB
Aujourd'hui : un seul agent scripté à deux tours fixes. Nouveau : 3 agents
spécialisés tournant en parallèle (Diagnostician, Remediator, Auditor), qui
se coordonnent en se disputant/cédant des incidents via de vraies
transactions SQL sérialisables sur CockroachDB (`SELECT ... FOR UPDATE`,
retry sur conflits de sérialisation). C'est la démonstration la plus fidèle
à ce qu'un jury CockroachDB veut voir : la base de données comme **couche de
consensus multi-agents**, pas comme un simple entrepôt de state. Très peu de
projets de hackathon vont jusque-là — la plupart restent single-agent.

### Originalité #3 — La mémoire de l'agent survit à la panne de la base
elle-même
Le twist le plus "meta" et le plus aligné sponsor : pendant une démo live,
on tue volontairement un nœud/une région du cluster CockroachDB pendant
qu'un incident est en cours de traitement, et on montre que l'agent continue
sans perdre son état — parce que CockroachDB répartit les données sur
plusieurs nœuds/régions par conception. L'histoire devient : "notre agent
auto-réparateur a une mémoire qui, elle-même, s'auto-répare." Ça relie
directement le pitch produit du sponsor (résilience distribuée) au pitch du
projet (agent résilient) — exactement le genre d'insight que le critère
Creativity demande ("qu'est-ce qui rend les systèmes agentiques différents").

---

## Semaine 1 — Débloquer le vrai raisonnement + élargir le scénario
Objectif : ne plus jamais montrer de fallback simulé pendant une démo.

- [ ] Débloquer Bedrock réellement : tester depuis un déploiement publié
      (la géo-restriction peut différer du container de dev) ; si toujours
      bloqué, basculer sur le proxy IA d'intégration Replit (Anthropic
      direct) en étant transparent dans le pitch que ce n'est plus Bedrock
      littéralement, ou évaluer un modèle Bedrock non-Anthropic (Titan,
      Nova) qui n'a pas cette restriction géographique.
- [ ] Remplacer le script fixe à 2 tours par une vraie boucle de
      planification : l'agent choisit le prochain outil à partir du contexte
      + de l'historique récupéré par RAG, pas d'un tableau `SCRIPT` codé en
      dur.
- [ ] Ajouter 4-5 scénarios d'incidents réalistes et distincts (fuite
      mémoire, connexion DB saturée, latence réseau cross-région, credential
      AWS expiré, disque plein) pour que la démo prouve une généralisation,
      pas un unique chemin scripté.
- [ ] Remplacer l'action AWS simulée par une vraie action AWS **non
      destructive** (ex. lecture réelle d'état de service) pour prouver
      l'intégration AWS sans risque, tout en gardant les actions correctives
      destructives derrière une approbation humaine documentée comme choix
      de sécurité.

## Semaine 2 — Construire les 3 originalités
Objectif : transformer le projet d'"agent DevOps avec RAG" en démonstration
distinctive de ce que CockroachDB permet.

- [ ] Originalité #1 : implémenter le routage par score de confiance
      (autonome / approbation / exploration prudente) + réinjection des
      résultats de résolution comme nouveaux embeddings.
- [ ] Originalité #2 : implémenter les 3 agents spécialisés + le mécanisme
      de claim/handoff transactionnel sur CockroachDB (gérer les conflits de
      sérialisation avec retry, journaliser les handoffs).
- [ ] Originalité #3 : préparer et scripter le scénario de panne de
      nœud/région CockroachDB en live, avec vérification automatisée
      (script) que l'état de l'incident en cours reste lisible/cohérent
      pendant la panne partielle.
- [ ] Tableau de bord Streamlit : ajouter une vue "pourquoi l'agent a décidé
      ça" — afficher le score de similarité, l'agent qui a pris la main, et
      le statut du cluster en direct pendant la démo de panne.

## Semaine 3 — Production readiness (le critère le plus facile à
maximiser avec du travail discipliné, pas de créativité)
- [ ] Rate limiting par clé API (protection contre l'abus/coût incontrôlé).
- [ ] Suite de tests automatisés (unitaires sur la logique de décision,
      intégration sur le flux complet trigger→resolve, test de reprise
      après crash en CI — automatiser `real-crash-test.sh`).
- [ ] Observabilité : dashboard de métriques (latence par outil, taux de
      résolution autonome vs. escaladée, distribution des scores de
      similarité) — Cockroach a des vues système exploitables (`crdb_internal`)
      pour montrer la charge réelle du cluster en live.
- [ ] Déploiement réel du serveur API (pas seulement en dev) + vérification
      que l'auth, le MCP, et l'accès CockroachDB fonctionnent en production.
- [ ] Revue de sécurité (secrets, injection SQL, validation des entrées de
      l'API, permissions du service account CockroachDB Cloud au principe du
      moindre privilège).

## Semaine 4 — Pitch, preuve, répétition
- [ ] Rédiger le narratif de pitch autour des 3 originalités (pas une liste
      de fonctionnalités) : "un agent dont la mémoire influence ses
      décisions, coordonné en multi-agents via des transactions
      CockroachDB, et dont la résilience va jusqu'à survivre à la panne de
      sa propre base."
- [ ] Vidéo de démo (2-3 min) qui montre en live : incident résolu en
      autonomie grâce à un match mémoire fort, un handoff multi-agents
      visible, et la coupure de nœud CockroachDB pendant un incident en
      cours sans perte d'état.
- [ ] Diagramme d'architecture clair (agents, MCP, CockroachDB, AWS) pour le
      README/soumission.
- [ ] Répétition à blanc chronométrée du pitch + questions anticipées du
      jury (notamment : "pourquoi CockroachDB et pas juste Postgres +
      pgvector ?" — la réponse doit être Originalité #2 et #3, pas juste
      "il a des vecteurs aussi").
- [ ] Nettoyage final du code, README à jour, vérification que rien ne
      montre un fallback simulé non annoncé pendant la démo.

---

## Priorisation si le temps manque
Si tout n'est pas faisable en un mois, ordre de priorité par impact sur le
classement :
1. Originalité #2 (multi-agents + transactions) — le plus différenciant et
   le plus "CockroachDB-natif", impossible à répliquer avec une base
   classique sans effort équivalent.
2. Originalité #1 (mémoire active) — renforce Agentic Memory Design ET
   Creativity en même temps.
3. Semaine 3 (production readiness) — gain fiable et mesurable, peu de
   risque d'échec en cours de route.
4. Originalité #3 (panne de nœud live) — le plus spectaculaire en démo mais
   aussi le plus risqué à faire tourner sans accroc le jour J ; à ne
   tenter que si le reste est solide et qu'il reste du temps pour répéter.
