# 🎬 Cloud-Surgeon — Guide d'enregistrement vidéo OBS
**Durée cible : < 3 min | Format : 1920×1080 | Audio : voix off MP3 intégrée**

---

## AVANT DE COMMENCER — Checklist réseau & stabilité

> ⚠️ Fais tout ça **avant** d'ouvrir OBS. Un problème réseau pendant l'enregistrement = tout recommencer.

- [ ] Branche-toi en **filaire (Ethernet)** si possible — évite le Wi-Fi
- [ ] Ferme tous les onglets inutiles, Slack, Teams, notifications
- [ ] Désactive les notifications Windows/Mac : **Ne pas déranger** activé
- [ ] Teste la démo une fois en live AVANT d'enregistrer :
  - [ ] Ouvre `https://d3ddnpg3hz3st4.cloudfront.net/` → connexion OK ?
  - [ ] Login avec `cloudsurgeon-demo` → tableau de bord visible ?
  - [ ] Trigger un incident test → il passe bien TRIGGERED → RESOLVED ?
  - [ ] CDC Audit Stream scroll en bas de page → logs en temps réel ?
- [ ] Le fichier `cloud-surgeon-voiceover.mp3` est sur ton bureau ou dans un dossier accessible
- [ ] Résolution écran : **1920×1080** (si ton écran est plus grand, fixe à 1080p dans les paramètres d'affichage)

---

## ÉTAPE 1 — Configurer OBS

### 1.1 Sources à créer (dans l'ordre)

**Source 1 : Capture d'écran**
- Clic droit dans la zone Sources → Ajouter → **Capture d'écran** (ou "Display Capture")
- Sélectionne l'écran où sera le dashboard
- Nom : `Dashboard`

**Source 2 : Fichier audio (voix off)**
- Clic droit → Ajouter → **Source média** (Media Source)
- Nom : `Voix off`
- Décocher "Boucle locale"
- Cocher **"Lecture locale"**
- Fichier : sélectionne `cloud-surgeon-voiceover.mp3`
- ✅ Désactiver la relecture automatique au démarrage

**Source 3 : Désactiver le micro**
- Dans le Mélangeur Audio en bas d'OBS
- Clique sur l'icône 🔇 sur la piste **Mic/Aux** → la couper complètement
- Seule la piste **Source média** doit rester active

### 1.2 Paramètres d'enregistrement
- Aller dans **Paramètres → Sortie → Enregistrement**
  - Format : `mp4`
  - Encodeur : `x264` (ou NVENC si tu as une carte Nvidia)
  - Débit vidéo : `6000 kbps`
- **Paramètres → Vidéo**
  - Résolution de base : `1920×1080`
  - Résolution de sortie : `1920×1080`
  - FPS : `30`

### 1.3 Test audio avant enregistrement
- Dans la zone Sources, fais un clic droit sur **Voix off** → Propriétés
- Clique **Lire** → tu dois voir le niveau audio bouger dans le Mélangeur
- Si rien ne bouge : vérifie que le fichier MP3 est bien sélectionné
- Stop, remets à zéro (Propriétés → décocher puis recocher "Lecture locale")

---

## ÉTAPE 2 — Préparer le navigateur

1. Ouvre **Google Chrome** en plein écran sur l'écran capturé
2. Va sur `https://d3ddnpg3hz3st4.cloudfront.net/`
3. Connecte-toi : `cloudsurgeon-demo`
4. Navigue vers la page **Guide** (1er élément du menu gauche)
5. Dans le panneau **Controls** (droite) :
   - Scenario → `ECS service checkout: payment 5xx spike`
   - Chaos Engineering → `None`
6. Vérifie que le point vert **API Online** est visible en haut à gauche
7. Zoom navigateur : **100%** (Ctrl+0)
8. Ouvre un **2ème onglet** sur la même URL (pour naviguer vite entre les pages)

---

## ÉTAPE 3 — Lancement synchronisé

> La règle d'or : **tu lances OBS Record et Source Média dans les 2 secondes qui suivent.**

1. Clique **Démarrer l'enregistrement** dans OBS
2. Immédiatement : clic droit sur **Voix off** dans Sources → **Lire**
3. La voix démarre — tu suis le script ci-dessous

---

## ÉTAPE 4 — Script de tournage (ce que tu fais à chaque phrase)

### 🕐 [0:00 – 0:18] — Page Guide, ne touche à rien
> *"It's 2 AM… Cloud-Surgeon never sleeps."*
> *"Cloud-Surgeon is an autonomous AI DevOps agent…"*

👉 Reste immobile sur la page Guide. Laisse la narration poser le contexte.
👉 Si le point vert API Online clignote ou est rouge → **arrête tout** (voir section Problèmes)

---

### 🕐 [0:18 – 0:22] — Trigger l'incident
> *"Scenario one: an ECS payment service is throwing 5-x-x errors. We trigger the agent."*

👉 Au mot **"trigger"** : clique le bouton **Trigger Agent** dans le panneau Controls
👉 Un toast apparaît : "Incident Triggered · [id]" — normal

---

### 🕐 [0:22 – 0:55] — Live Diagnostic
> *"The Diagnostician queries CloudWatch…"*

👉 Clique **Live Diagnostic** dans le menu gauche
👉 L'incident apparaît avec une bordure rouge pulsante : TRIGGERED → DIAGNOSING
👉 Le CDC Audit Stream en bas commence à défiler — laisse-le visible

> *"It finds a match: ECS service restart — 74 percent win rate…"*

👉 L'incident passe à REPAIRING puis flash vert → RESOLVED
👉 Si l'incident met plus de 45 secondes : voir section Problèmes

---

### 🕐 [0:55 – 1:10] — Decision Trace
> *"Here is the full decision trace…"*

👉 Clique **Decision Trace** dans le menu gauche
👉 Sélectionne l'incident qui vient de se résoudre dans le dropdown en haut
👉 Fais défiler lentement pour que les étapes de raisonnement soient lisibles

---

### 🕐 [1:10 – 1:30] — Strategy Memory
> *"CockroachDB is not just the database — it is the brain of the system…"*

👉 Clique **Strategy Memory** dans le menu gauche
👉 Montre la table des win-rates : `ecs_service_restart` à 74%, `db_connection_pool_reset` à ~50%

> *"After every incident, the Auditor recalibrates…"*

👉 Clique **Calibration** dans le menu gauche
👉 Montre le tableau calibration brièvement (2-3 secondes suffisent)

---

### 🕐 [1:40 – 2:05] — Crash Resilience (Chaos)
> *"Now, crash resilience. We trigger a new incident…"*

👉 Dans le panneau Controls (droite) :
  - Chaos Engineering → `SIGKILL crash after diagnostic`
  - Clique **Trigger Agent**
👉 Navigue vers **Live Diagnostic**
👉 Attends que l'incident passe à **REPAIRING**

> *"We just killed the server."*

👉 Dans Controls → section **System Ops** → clique **SIGKILL API Server**
👉 Le point vert **API Online** passe rouge (~3 secondes) puis revient vert

> *"On reconnection, the agent resumes exactly where it left off…"*

👉 L'incident reprend et se résout — montre-le dans Live Diagnostic

---

### 🕐 [2:05 – 2:20] — Impact & Cost
> *"Cloud-Surgeon runs on Amazon Bedrock…"*

👉 Clique **Impact & Cost** dans le menu gauche
👉 Laisse les métriques visibles (MTTR reduction, incidents résolus)

---

### 🕐 [2:20 – 2:30] — All Incidents + Fermeture
> *"Cloud-Surgeon: 80 percent reduction…"*
> *"CockroachDB × AWS — infrastructure that never sleeps."*

👉 Clique **All Incidents** dans le menu gauche
👉 Maintiens l'affichage jusqu'à la fin de la phrase
👉 Attends 1 seconde de silence → **Arrêter l'enregistrement** dans OBS

---

## ÉTAPE 5 — Après l'enregistrement

1. Le fichier `.mp4` se trouve dans le dossier configuré dans OBS (Paramètres → Sortie → Chemin)
2. Regarde-le une fois en entier — vérifie :
   - [ ] Audio audible et synchronisé avec les clics ?
   - [ ] Durée < 3:00 ?
   - [ ] Toutes les sections visibles (CDC stream, win-rates, crash + reprise) ?
3. Si OK → upload YouTube en **Non répertorié (Unlisted)**
4. Copie le lien YouTube → colle dans Devpost

---

## 🚨 Problèmes fréquents et solutions

### Le dashboard ne charge pas / connexion refusée
- Vérifie ta connexion : ouvre `https://d3ddnpg3hz3st4.cloudfront.net/api/health` dans un autre onglet
- Si timeout : attends 30 secondes, force refresh (Ctrl+Shift+R)
- Si ça persiste : l'API Server sur Replit est peut-être arrêté — va sur Replit et relance le workflow **API Server**
- **Ne lance pas OBS tant que le point vert API Online n'est pas stable**

### L'incident reste bloqué en DIAGNOSING > 45 secondes
- Cause probable : le LLM (Bedrock / Mistral) est lent
- Patience — ne clique pas ailleurs, laisse la caméra rouler
- Si > 90 secondes sans mouvement : arrête l'enregistrement, va dans **All Incidents**, annule l'incident en cours, relance depuis le début

### Le CDC Audit Stream ne défile pas (ligne CONNECTED [cdc] seulement)
- Le changefeed CockroachDB s'est déconnecté
- Va dans l'onglet API Server sur Replit → vérifie les logs pour une erreur CDC
- Souvent résolu en redémarrant le workflow API Server et en attendant 10 secondes

### La voix off et l'image sont décalées
- Tu n'as pas lancé Record et Play dans les 2 secondes → recommence
- Alternative : dans OBS, va dans les paramètres de la Source Média → note le timestamp actuel → ajuste le décalage dans Filtre Audio (Décalage de synchronisation) en post

### OBS ne capture pas l'audio de la Source Média
- Vérifie dans le Mélangeur Audio en bas : la barre de la Source Média bouge-t-elle quand tu cliques Lire ?
- Si non : Paramètres → Audio → vérifie que le périphérique de sortie par défaut est correct
- Parfois il faut redémarrer OBS après avoir ajouté la Source Média

### Le SIGKILL ne redémarre pas (API Online reste rouge > 15 secondes)
- Sur Replit, le workflow **API Server** a un auto-restart — il doit revenir seul
- Si > 20 secondes : va sur Replit → relance manuellement le workflow API Server
- L'incident en cours reprendra dès que le serveur est de retour

### Le fichier MP4 exporté n'a pas de son
- Dans OBS : Paramètres → Sortie → Enregistrement → vérifie que **Audio Track 1** est cochée
- Refais un test de 10 secondes et vérifie avant de faire la vraie prise

---

## Récapitulatif ultra-court (à coller sur un post-it)

```
1. Ethernet branché, notifications coupées
2. Dashboard ouvert, connecté, Guide page visible
3. Controls : Scenario = ECS 5xx | Chaos = None
4. OBS : Record + Play Media dans les 2 secondes
5. Suivre le script — ne pas paniquer si c'est lent
6. SIGKILL quand la voix dit "We just killed the server"
7. Arrêter OBS 1 sec après "infrastructure that never sleeps"
8. Vérifier durée < 3:00 avant upload YouTube
```
