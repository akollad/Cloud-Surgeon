# Cloud-Surgeon — Demo Script
**Durée cible : 2 min 30 sec**  
**Outil : screen recording du dashboard live**

---

## SETUP avant de commencer
- Ouvre le dashboard : `/dashboard/`
- Panneau droit visible (Controls)
- Onglet **GUIDE** actif
- Scénario sélectionné : **"ECS service checkout: payment 5xx spike"**

---

## [0:00 – 0:20] — LE PROBLÈME

> *Narration (voix ou texte à l'écran) :*

**"Il est 2h du matin. Ton service de paiement est en train de tomber.
Chaque seconde coûte de l'argent. Personne n'est réveillé.
Cloud-Surgeon, lui, ne dort jamais."**

👉 **Montre le dashboard — "API ONLINE" en vert en haut à gauche.**

> *"Cloud-Surgeon est un agent DevOps autonome.
> Il détecte, diagnostique, et répare les incidents AWS —
> sans intervention humaine — grâce à CockroachDB comme mémoire persistante."*

---

## [0:20 – 1:00] — SCÉNARIO A : RÉSOLUTION AUTONOME (haute confiance)

> *"Scénario 1 : l'agent reconnaît l'incident depuis sa mémoire vectorielle."*

**Actions à l'écran :**

1. Panneau droit → **SCENARIO** : sélectionner **"ECS service checkout: payment 5xx spike"**
2. Cliquer **TRIGGER AGENT**
3. Aller immédiatement sur **LIVE DIAGNOSTIC** dans le menu gauche

> *"Le Diagnosticien interroge CloudWatch, consulte l'état ECS,
> puis effectue une recherche vectorielle dans CockroachDB —
> il cherche dans la mémoire les incidents similaires passés."*

4. Montrer les logs qui défilent en temps réel

> *"Il trouve une correspondance : 'ECS Fargate Redeploy' — win-rate 92%.
> Confiance suffisante : le Remediateur agit sans demander d'approbation."*

5. Aller sur **DECISION TRACE**

> *"Voici la trace de décision complète : le vecteur de l'incident,
> la stratégie sélectionnée, et le raisonnement de chaque agent —
> tout est persisté transactionnellement dans CockroachDB."*

---

## [1:00 – 1:30] — LA MÉMOIRE COCKROACHDB

👉 **Cliquer sur STRATEGY MEMORY dans le menu gauche**

> *"CockroachDB n'est pas juste la base de données — c'est le cerveau du système.*
>
> *Quatre couches de mémoire :*
> *— Vecteurs VECTOR(1024) avec index C-SPANN pour le RAG*
> *— État JSONB transactionnel pour la résilience aux crashes*
> *— CDC (Change Data Capture) pour streamer les événements en temps réel*
> *— MCP Server de CockroachDB Cloud pour les diagnostics live du cluster"*

👉 **Cliquer sur CALIBRATION**

> *"Et après chaque incident, l'Auditeur recalibre les win-rates.
> Si la prédiction s'écarte de la réalité de plus de 15%,
> le multiplicateur est ajusté automatiquement.
> Le système apprend de chaque intervention."*

---

## [1:30 – 2:00] — SCÉNARIO B : CRASH RESILIENCE (Chaos Engineering)

> *"Maintenant, une démo de résilience aux crashes."*

**Actions à l'écran :**

1. Retourner sur **GUIDE** → section **Scenario C: Chaos / Crash Recovery**
2. Panneau droit → **CHAOS ENGINEERING** → sélectionner **"SIGKILL mid-repair"**
3. Cliquer **TRIGGER AGENT** pour démarrer une réparation
4. Attendre 5 secondes → déclencher le chaos (SIGKILL)

> *"On vient de tuer le serveur en pleine réparation —
> exactement comme un crash en production."*

5. L'API redémarre automatiquement — montrer **"API ONLINE"** revenir en vert

> *"À la reconnexion, l'agent reprend exactement là où il s'est arrêté.
> Pas de perte d'état. Pas de double exécution.
> C'est possible grâce aux transactions SERIALIZABLE de CockroachDB."*

---

## [2:00 – 2:20] — AWS SERVICES

👉 **Aller sur IMPACT & COST**

> *"Côté AWS, Cloud-Surgeon utilise :*
> *— Amazon Bedrock (Mistral Large 3 via bedrock-mantle, Nova Lite en fallback automatique) pour le raisonnement des agents*
> *— ECS Fargate comme cible de réparation live*
> *— CloudWatch + SNS pour l'ingestion d'alertes*
> *— RDS et Lambda comme autres surfaces de remédiation*
> *— S3 + CloudFront pour le dashboard en production"*

---

## [2:20 – 2:30] — CONCLUSION

👉 **Revenir sur GUIDE ou ALL INCIDENTS**

> *"Cloud-Surgeon, c'est :*
> *80% de réduction du MTTR.*
> *Zéro intervention humaine pour les incidents haute confiance.*
> *Une mémoire qui grandit à chaque incident.*
>
> *CockroachDB × AWS — l'infrastructure qui ne dort jamais."*

---

## CHECKLIST hackathon (à couvrir dans la vidéo)

| Requis | Couvert | Timestamp |
|--------|---------|-----------|
| CockroachDB Distributed Vector Indexing | ✅ | 0:40 — recherche vectorielle win-rate |
| CockroachDB MCP Server | ✅ | 0:30 — diagnostics cluster live |
| CDC / Agent Skills | ✅ | 1:05 — streaming état en temps réel |
| AWS Bedrock | ✅ | 2:05 |
| AWS ECS / Lambda / RDS | ✅ | 2:05 |
| CloudWatch + SNS | ✅ | 2:10 |
| Demo app fonctionnelle | ✅ | tout le long |
| Mémoire CockroachDB visible | ✅ | 1:00 — Strategy Memory + Calibration |

---

## CONSEILS POUR L'ENREGISTREMENT

- **Outil recommandé** : OBS Studio (gratuit), QuickTime (Mac), ou Xbox Game Bar (Windows)
- **Résolution** : 1920×1080 minimum
- **Parle lentement** — 2:30 se remplit vite, ne te précipite pas sur les clics
- **Pause d'1 seconde** entre chaque action pour que les changements soient visibles
- **Upload YouTube** : mode "Non répertorié" suffit pour la soumission (accessible par lien)
