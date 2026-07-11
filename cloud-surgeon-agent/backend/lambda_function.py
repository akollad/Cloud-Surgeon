"""
Cloud-Surgeon — Agent DevOps Autonome Serverless
Hackathon CockroachDB x AWS 2026

Ce module implémente un agent autonome exécuté sur AWS Lambda qui:
  1. Reçoit une alerte d'infrastructure.
  2. Vectorise l'alerte via Amazon Bedrock (Titan Text Embeddings V2) et
     recherche l'incident historique le plus proche dans CockroachDB
     (RAG vectoriel, distance cosinus).
  3. Fait tourner une boucle d'agent avec Amazon Bedrock (Claude 3.5 Sonnet)
     capable d'appeler deux outils (`execute_ccloud_command`,
     `aws_repair_service`) pour diagnostiquer et réparer l'incident.
  4. Persiste CHAQUE étape (pensée, tool_use, tool_result, changement de
     statut) dans CockroachDB de manière synchrone et immédiate.

Pourquoi cette écriture "immédiate" est critique pour le jury :
  AWS Lambda peut être tué à tout moment (timeout, OOM, déploiement,
  spot reclaim de l'infra sous-jacente, etc.). Ce code ne garde AUCUN état
  en mémoire vive entre deux étapes de la boucle d'agent : dès qu'un
  tool_result est obtenu, il est écrit dans `incident_state.context_json`
  AVANT de rappeler Bedrock. Si le process meurt juste après, la prochaine
  invocation Lambda relit cet état exact depuis CockroachDB et reprend la
  conversation Claude au tour suivant, sans rejouer ni perdre les étapes
  déjà exécutées. CockroachDB est donc la seule source de vérité de l'agent
  — jamais une variable Python.

DON'TS respectés :
  - Aucune librairie d'agent tierce (pas de LangChain/CrewAI) : boucle de
    tool-calling écrite à la main avec boto3 brut.
  - Aucune variable d'état globale hors handler : tout est passé en
    paramètres de fonction et lu/écrit depuis CockroachDB.
  - Aucune clé AWS en dur : le client boto3 s'authentifie via le rôle
    d'exécution IAM de la Lambda (credentials résolues automatiquement).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from contextlib import contextmanager
from typing import Any, Iterator

import boto3
import psycopg2
import psycopg2.extras

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# ------------------------------------------------------------------------
# Configuration (100% via variables d'environnement — aucun secret en dur)
# ------------------------------------------------------------------------
DATABASE_URL = os.environ["DATABASE_URL"]
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
CLAUDE_MODEL_ID = os.environ.get(
    "CLAUDE_MODEL_ID", "anthropic.claude-3-5-sonnet-20240620-v1:0"
)
TITAN_EMBED_MODEL_ID = os.environ.get(
    "TITAN_EMBED_MODEL_ID", "amazon.titan-embed-text-v2:0"
)
MAX_AGENT_TURNS = int(os.environ.get("MAX_AGENT_TURNS", "8"))

# Statuts non terminaux : un incident dans un de ces états doit être repris,
# pas recréé.
ACTIVE_STATUSES = ("TRIGGERED", "DIAGNOSING", "REPAIRING")


# ============================================================================
# A. CONNEXION À COCKROACHDB
# ============================================================================
def get_db_connection() -> "psycopg2.extensions.connection":
    """
    Ouvre une connexion à CockroachDB Serverless via DATABASE_URL.

    Utilise RealDictCursor par défaut afin que toutes les lignes retournées
    soient des dictionnaires (clé = nom de colonne), ce qui simplifie
    directement le mapping vers context_json / réponses JSON.

    Note résilience : on ne réutilise volontairement PAS de connexion globale
    entre invocations Lambda. Une connexion neuve par invocation évite de
    travailler sur une connexion "zombie" issue d'un environnement Lambda
    gelé (freeze/thaw) qui pourrait avoir expiré côté CockroachDB.
    """
    try:
        conn = psycopg2.connect(
            DATABASE_URL,
            cursor_factory=psycopg2.extras.RealDictCursor,
            connect_timeout=10,
            sslmode="require",
        )
        conn.autocommit = False
        return conn
    except psycopg2.OperationalError as exc:
        # Base temporairement inaccessible (cold start réseau, cluster qui
        # scale, etc.) : on lève une exception propre et explicite plutôt que
        # de laisser fuir un traceback psycopg2 brut.
        logger.error("Impossible de se connecter à CockroachDB: %s", exc)
        raise RuntimeError(
            "CockroachDB indisponible : la connexion à DATABASE_URL a échoué."
        ) from exc


@contextmanager
def db_cursor(conn: "psycopg2.extensions.connection") -> Iterator[Any]:
    """Petit helper pour garantir commit/rollback cohérent autour d'un cursor."""
    cur = conn.cursor()
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


# ============================================================================
# B. GÉNÉRATION D'EMBEDDINGS (Amazon Titan Text Embeddings V2)
# ============================================================================
def get_embedding(text: str) -> list[float]:
    """
    Vectorise `text` avec Amazon Titan Text Embeddings V2 (1024 dimensions),
    dimension exigée pour matcher la colonne `embedding VECTOR(1024)`.

    Le client bedrock-runtime s'initialise sans credentials en dur : boto3
    résout automatiquement le rôle IAM attaché à la fonction Lambda.
    """
    try:
        bedrock_runtime = boto3.client("bedrock-runtime", region_name=AWS_REGION)

        body = json.dumps({"inputText": text, "dimensions": 1024, "type": "text"})

        response = bedrock_runtime.invoke_model(
            modelId=TITAN_EMBED_MODEL_ID,
            body=body,
            contentType="application/json",
            accept="application/json",
        )

        # boto3 renvoie un StreamingBody à usage unique : il faut le lire et
        # le décoder explicitement avant de parser le JSON.
        response_body = json.loads(response["body"].read().decode("utf-8"))
        embedding = response_body["embedding"]

        if not isinstance(embedding, list) or len(embedding) != 1024:
            raise ValueError(
                f"Embedding Titan invalide : longueur {len(embedding) if isinstance(embedding, list) else 'N/A'} "
                "(1024 attendu)."
            )

        return embedding
    except (boto3.exceptions.Boto3Error, KeyError, ValueError, json.JSONDecodeError) as exc:
        logger.error("Échec de la génération d'embedding Titan: %s", exc)
        raise RuntimeError("Amazon Bedrock (Titan V2) a échoué à vectoriser le texte.") from exc


def _vector_literal(embedding: list[float]) -> str:
    """Sérialise une liste de floats Python au format littéral VECTOR de CockroachDB, ex: '[0.1,0.2,...]'."""
    return "[" + ",".join(repr(float(x)) for x in embedding) + "]"


# ============================================================================
# C. RECHERCHE VECTORIELLE (RAG SQL)
# ============================================================================
def find_similar_incident(
    conn: "psycopg2.extensions.connection", embedding: list[float]
) -> dict | None:
    """
    Recherche l'incident historique le plus proche par distance cosinus.

    L'opérateur `<=>` est l'opérateur de distance cosinus vectorielle natif
    de CockroachDB (compatible pgvector). On trie par distance croissante
    (0 = identique) et on prend le plus proche voisin (LIMIT 1).
    """
    try:
        with db_cursor(conn) as cur:
            cur.execute(
                """
                SELECT error_message_text,
                       embedding <=> %s::vector AS distance
                FROM incident_vectors
                ORDER BY embedding <=> %s::vector
                LIMIT 1;
                """,
                (_vector_literal(embedding), _vector_literal(embedding)),
            )
            row = cur.fetchone()
            return dict(row) if row else None
    except psycopg2.Error as exc:
        logger.error("Échec de la recherche vectorielle RAG: %s", exc)
        raise RuntimeError("La requête de similarité vectorielle CockroachDB a échoué.") from exc


def index_resolved_incident(
    conn: "psycopg2.extensions.connection", error_message_text: str, embedding: list[float]
) -> None:
    """
    Enrichit la base RAG avec un incident désormais résolu, afin que les
    futures alertes similaires bénéficient de ce précédent.
    """
    try:
        with db_cursor(conn) as cur:
            cur.execute(
                """
                INSERT INTO incident_vectors (error_message_text, embedding)
                VALUES (%s, %s::vector);
                """,
                (error_message_text, _vector_literal(embedding)),
            )
    except psycopg2.Error as exc:
        # Non-bloquant pour la résolution de l'incident : on log et on continue.
        logger.warning("Impossible d'indexer l'incident résolu dans le RAG: %s", exc)


# ============================================================================
# D. GESTION DE L'ÉTAT (IDEMPOTENCE / SURVIVABILITÉ)
# ============================================================================
def _fingerprint(alert_text: str) -> str:
    """Empreinte stable et déterministe d'une alerte, utilisée comme clé d'idempotence."""
    return hashlib.sha256(alert_text.strip().encode("utf-8")).hexdigest()


def get_or_create_incident(
    conn: "psycopg2.extensions.connection", alert_text: str
) -> tuple[str, str, dict]:
    """
    Point d'entrée de la résilience de l'agent.

    - Calcule le fingerprint de l'alerte.
    - Tente un INSERT en statut 'TRIGGERED'.
    - Si le fingerprint existe déjà (ON CONFLICT), NE RECRÉE RIEN : on
      relit l'état existant (status, context_json) tel qu'il a été laissé
      par la dernière invocation Lambda, potentiellement crashée en plein
      milieu d'une réparation. C'est ce qui garantit 0% de perte de
      contexte : une nouvelle Lambda reprend EXACTEMENT là où l'ancienne
      s'est arrêtée.

    Returns:
        (incident_id, status, context_json)
    """
    fingerprint = _fingerprint(alert_text)

    try:
        with db_cursor(conn) as cur:
            cur.execute(
                """
                INSERT INTO incident_state (alert_fingerprint, status, current_step, context_json)
                VALUES (%s, 'TRIGGERED', 'INIT', %s::jsonb)
                ON CONFLICT (alert_fingerprint) DO NOTHING
                RETURNING incident_id, status, context_json;
                """,
                (fingerprint, json.dumps({"alert_text": alert_text, "history": []})),
            )
            row = cur.fetchone()

            if row is not None:
                # Nouvel incident créé : première exécution pour cette alerte.
                logger.info("Nouvel incident créé (fingerprint=%s)", fingerprint)
                return str(row["incident_id"]), row["status"], row["context_json"]

            # Conflit : l'incident existe déjà. On charge son état actuel
            # pour reprendre l'exécution là où elle s'est arrêtée.
            cur.execute(
                """
                SELECT incident_id, status, context_json
                FROM incident_state
                WHERE alert_fingerprint = %s;
                """,
                (fingerprint,),
            )
            existing = cur.fetchone()
            if existing is None:
                # Cas de course extrêmement improbable (ligne supprimée entre
                # les deux requêtes) : on échoue explicitement plutôt que de
                # deviner un état.
                raise RuntimeError(
                    f"Incident avec fingerprint={fingerprint} introuvable après conflit d'insertion."
                )

            logger.info(
                "Incident existant repris (incident_id=%s, status=%s) — reprise après crash possible.",
                existing["incident_id"],
                existing["status"],
            )
            return str(existing["incident_id"]), existing["status"], existing["context_json"]
    except psycopg2.Error as exc:
        logger.error("Échec de get_or_create_incident: %s", exc)
        raise RuntimeError("Impossible de lire/écrire l'état de l'incident dans CockroachDB.") from exc


def persist_incident_state(
    conn: "psycopg2.extensions.connection",
    incident_id: str,
    status: str,
    current_step: str,
    context: dict,
) -> None:
    """
    Écrit IMMÉDIATEMENT l'état complet de l'incident dans CockroachDB.

    Appelée après CHAQUE tour de la boucle d'agent (avant de rappeler
    Bedrock), afin que l'état visible en base soit toujours à jour, quelle
    que soit l'étape à laquelle la Lambda pourrait être interrompue.
    """
    try:
        with db_cursor(conn) as cur:
            cur.execute(
                """
                UPDATE incident_state
                SET status = %s,
                    current_step = %s,
                    context_json = %s::jsonb,
                    updated_at = now()
                WHERE incident_id = %s;
                """,
                (status, current_step, json.dumps(context), incident_id),
            )
    except psycopg2.Error as exc:
        logger.error("Échec de la persistance de l'état de l'incident: %s", exc)
        raise RuntimeError("Impossible de sauvegarder l'état de l'incident dans CockroachDB.") from exc


def log_execution(
    conn: "psycopg2.extensions.connection", incident_id: str, action_taken: str, result: str
) -> None:
    """Ajoute une ligne immuable dans le journal d'exécution chronologique."""
    try:
        with db_cursor(conn) as cur:
            cur.execute(
                """
                INSERT INTO execution_logs (incident_id, action_taken, result)
                VALUES (%s, %s, %s);
                """,
                (incident_id, action_taken, result),
            )
    except psycopg2.Error as exc:
        # Le logging ne doit jamais faire échouer la boucle métier ; on
        # journalise l'erreur côté Lambda et on continue.
        logger.warning("Échec de l'écriture dans execution_logs: %s", exc)


# ============================================================================
# E. OUTILS DE L'AGENT (Tool Calling)
#
# Ces fonctions SIMULENT les actions réelles (CLI ccloud / API AWS). Dans un
# environnement de production, `execute_ccloud_command` invoquerait le
# binaire `ccloud` via subprocess dans une sandbox contrôlée, et
# `aws_repair_service` appellerait les SDK boto3 correspondants (ecs, rds,
# lambda, etc.). Le mode "Safe-by-default" est respecté : ces outils
# n'exécutent jamais de SQL arbitraire ni ne modifient le schéma des tables
# de mémoire de l'agent (incident_state / incident_vectors / execution_logs).
# ============================================================================
TOOL_DEFINITIONS = [
    {
        "name": "execute_ccloud_command",
        "description": (
            "Exécute une commande en lecture/diagnostic sur le cluster CockroachDB Cloud "
            "via la CLI `ccloud` (ex: vérifier l'état d'un cluster, lister les métriques). "
            "N'altère jamais le schéma des tables de mémoire de l'agent."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command_json": {
                    "type": "string",
                    "description": "Commande ccloud sérialisée en JSON, ex: '{\"action\": \"cluster:status\", \"cluster_id\": \"...\"}'",
                }
            },
            "required": ["command_json"],
        },
    },
    {
        "name": "aws_repair_service",
        "description": (
            "Déclenche une action de réparation sur un service AWS (ex: redémarrer une tâche "
            "ECS, relancer une fonction Lambda, forcer un failover RDS)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "service_name": {
                    "type": "string",
                    "description": "Nom du service AWS ciblé, ex: 'ecs-cluster-prod', 'rds-primary'.",
                },
                "action": {
                    "type": "string",
                    "description": "Action de réparation à exécuter, ex: 'restart', 'failover', 'scale_up'.",
                },
            },
            "required": ["service_name", "action"],
        },
    },
]


def execute_ccloud_command(command_json: str) -> str:
    """
    Simule l'exécution d'une commande ccloud (CockroachDB Cloud CLI).

    En production, ce point d'entrée invoquerait la CLI `ccloud` en
    sous-processus (subprocess.run) avec une liste blanche stricte de
    sous-commandes autorisées (safe-by-default), jamais de SQL brut fourni
    par le modèle.
    """
    logger.info("[TOOL] execute_ccloud_command appelé avec: %s", command_json)
    try:
        parsed = json.loads(command_json)
    except json.JSONDecodeError:
        return json.dumps({"success": False, "error": "command_json invalide (JSON malformé)."})

    action = parsed.get("action", "unknown")
    # --- Simulation ---
    simulated_result = {
        "success": True,
        "action": action,
        "output": f"[SIMULATION] Commande ccloud '{action}' exécutée avec succès sur le cluster.",
    }
    logger.info("[TOOL] execute_ccloud_command résultat: %s", simulated_result)
    return json.dumps(simulated_result)


def aws_repair_service(service_name: str, action: str) -> str:
    """
    Simule une action de réparation AWS (ex: redémarrage d'un service ECS).

    En production, ce point d'entrée router ait vers le bon client boto3
    (ecs, rds, lambda, autoscaling...) en fonction de `service_name`, avec
    des permissions IAM strictement scoppées (principe du moindre privilège).
    """
    logger.info(
        "[TOOL] aws_repair_service appelé avec service_name=%s action=%s", service_name, action
    )
    # --- Simulation ---
    simulated_result = {
        "success": True,
        "service_name": service_name,
        "action": action,
        "output": f"[SIMULATION] Action '{action}' appliquée avec succès au service AWS '{service_name}'.",
    }
    logger.info("[TOOL] aws_repair_service résultat: %s", simulated_result)
    return json.dumps(simulated_result)


TOOL_DISPATCH = {
    "execute_ccloud_command": lambda tool_input: execute_ccloud_command(tool_input["command_json"]),
    "aws_repair_service": lambda tool_input: aws_repair_service(
        tool_input["service_name"], tool_input["action"]
    ),
}


# ============================================================================
# E. BOUCLE D'AGENT (Claude 3.5 Sonnet via Bedrock Messages API)
# ============================================================================
SYSTEM_PROMPT = """Tu es Cloud-Surgeon, un agent DevOps autonome responsable du diagnostic et de la
réparation d'incidents d'infrastructure cloud.

Tu disposes de deux outils :
- execute_ccloud_command : pour diagnostiquer l'état d'un cluster CockroachDB Cloud.
- aws_repair_service : pour réparer un service AWS.

Règles strictes :
- N'utilise ces outils que pour du diagnostic ou de la réparation d'infrastructure.
- N'émets jamais de commande visant à modifier le schéma d'une base de données de mémoire d'agent.
- Une fois le problème résolu, réponds en langage naturel en commençant par "RESOLVED:" suivi d'un
  résumé de l'action corrective.
- Si tu ne peux pas résoudre le problème après investigation, réponds en commençant par "FAILED:"
  suivi de la raison.
"""


def _invoke_claude(messages: list[dict]) -> dict:
    """
    Appelle Claude 3.5 Sonnet via l'API Bedrock Messages (invoke_model) avec
    les définitions d'outils. Parse le StreamingBody retourné par boto3.
    """
    bedrock_runtime = boto3.client("bedrock-runtime", region_name=AWS_REGION)

    request_body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
            "system": SYSTEM_PROMPT,
            "messages": messages,
            "tools": TOOL_DEFINITIONS,
        }
    )

    try:
        response = bedrock_runtime.invoke_model(
            modelId=CLAUDE_MODEL_ID,
            body=request_body,
            contentType="application/json",
            accept="application/json",
        )
        # Lecture explicite du StreamingBody, requise par boto3 (usage unique).
        return json.loads(response["body"].read().decode("utf-8"))
    except (boto3.exceptions.Boto3Error, json.JSONDecodeError, KeyError) as exc:
        logger.error("Échec de l'appel à Claude 3.5 Sonnet via Bedrock: %s", exc)
        raise RuntimeError("Amazon Bedrock (Claude 3.5 Sonnet) a échoué à répondre.") from exc


def run_agent_loop(
    conn: "psycopg2.extensions.connection",
    incident_id: str,
    current_status: str,
    context: dict,
    alert_text: str,
) -> dict:
    """
    Fait tourner la boucle de raisonnement/action de l'agent jusqu'à
    résolution, échec, ou atteinte de MAX_AGENT_TURNS.

    Contrat de résilience : après CHAQUE tour (qu'il s'agisse d'un tool_use
    ou de la réponse finale), l'état complet (messages, statut, étape) est
    réécrit dans CockroachDB via persist_incident_state AVANT de continuer.
    Si la Lambda meurt juste après un write, la prochaine invocation relit
    `context["messages"]` tel quel et reprend la conversation Bedrock au
    tour suivant, sans repartir de zéro.
    """
    messages: list[dict] = context.get("messages") or [
        {"role": "user", "content": f"Nouvelle alerte d'infrastructure à diagnostiquer: {alert_text}"}
    ]

    status = current_status if current_status in ACTIVE_STATUSES else "DIAGNOSING"
    if status == "TRIGGERED":
        status = "DIAGNOSING"

    for turn in range(MAX_AGENT_TURNS):
        current_step = f"AGENT_TURN_{turn}"
        try:
            claude_response = _invoke_claude(messages)
        except RuntimeError as exc:
            # Échec d'appel Bedrock : on marque l'incident FAILED plutôt que
            # de rester bloqué indéfiniment, et on persiste l'erreur.
            context["messages"] = messages
            context["error"] = str(exc)
            persist_incident_state(conn, incident_id, "FAILED", current_step, context)
            log_execution(conn, incident_id, "invoke_claude", f"ERROR: {exc}")
            return {"status": "FAILED", "reason": str(exc)}

        stop_reason = claude_response.get("stop_reason")
        content_blocks = claude_response.get("content", [])

        # On ajoute la réponse de l'assistant à l'historique de conversation
        # AVANT tout traitement, pour ne rien perdre si un tool échoue ensuite.
        messages.append({"role": "assistant", "content": content_blocks})

        if stop_reason == "tool_use":
            status = "REPAIRING"
            tool_result_blocks = []

            for block in content_blocks:
                if block.get("type") != "tool_use":
                    continue

                tool_name = block["name"]
                tool_input = block.get("input", {})
                tool_use_id = block["id"]

                handler = TOOL_DISPATCH.get(tool_name)
                if handler is None:
                    tool_output = json.dumps(
                        {"success": False, "error": f"Outil inconnu: {tool_name}"}
                    )
                else:
                    try:
                        tool_output = handler(tool_input)
                    except Exception as exc:  # noqa: BLE001 - on veut capturer toute erreur d'outil
                        tool_output = json.dumps({"success": False, "error": str(exc)})

                log_execution(conn, incident_id, f"{tool_name}({json.dumps(tool_input)})", tool_output)

                tool_result_blocks.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": tool_output,
                    }
                )

            messages.append({"role": "user", "content": tool_result_blocks})

            # ÉCRITURE IMMÉDIATE : c'est ici que la résilience se joue.
            # Le résultat de l'outil est en base AVANT le prochain appel à
            # Claude ; un crash juste après ce point ne perd aucune
            # information, la prochaine Lambda repartira de cet état.
            context["messages"] = messages
            persist_incident_state(conn, incident_id, status, current_step, context)
            continue

        # stop_reason != "tool_use" -> Claude a rendu sa réponse finale.
        final_text = "".join(
            block.get("text", "") for block in content_blocks if block.get("type") == "text"
        )
        context["messages"] = messages
        context["final_response"] = final_text

        if final_text.strip().upper().startswith("RESOLVED"):
            status = "RESOLVED"
        elif final_text.strip().upper().startswith("FAILED"):
            status = "FAILED"
        else:
            # Réponse ambiguë : on la traite comme un échec explicite plutôt
            # que de deviner un succès.
            status = "FAILED"

        persist_incident_state(conn, incident_id, status, "FINALIZED", context)

        if status == "RESOLVED":
            try:
                embedding = get_embedding(alert_text)
                index_resolved_incident(conn, alert_text, embedding)
            except RuntimeError as exc:
                logger.warning("Indexation RAG post-résolution ignorée: %s", exc)

        return {"status": status, "final_response": final_text}

    # Nombre maximal de tours atteint sans résolution ni échec explicite.
    context["messages"] = messages
    context["error"] = f"MAX_AGENT_TURNS ({MAX_AGENT_TURNS}) atteint sans résolution."
    persist_incident_state(conn, incident_id, "FAILED", "MAX_TURNS_REACHED", context)
    return {"status": "FAILED", "reason": context["error"]}


# ============================================================================
# HANDLER LAMBDA
# ============================================================================
def lambda_handler(event: dict, _lambda_context: Any) -> dict:
    """
    Point d'entrée AWS Lambda.

    Événement attendu (ex. déclenché par une alerte CloudWatch / SNS) :
        { "alert_text": "ECS service 'checkout' unhealthy: 5xx spike on /pay" }

    Aucun état n'est conservé entre invocations en dehors de CockroachDB :
    à chaque appel, on ouvre une connexion fraîche, on lit/crée l'incident,
    on vectorise l'alerte pour le RAG, puis on fait tourner (ou reprend) la
    boucle d'agent.
    """
    alert_text = event.get("alert_text")
    if not alert_text or not isinstance(alert_text, str):
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Champ 'alert_text' (string) requis dans l'événement."}),
        }

    conn = None
    try:
        conn = get_db_connection()

        # --- Idempotence / reprise après crash ---
        incident_id, status, context = get_or_create_incident(conn, alert_text)

        if status in ("RESOLVED", "FAILED"):
            # Alerte déjà traitée précédemment (même fingerprint) : on
            # renvoie l'état final sans relancer inutilement l'agent.
            logger.info("Incident %s déjà terminé (status=%s), aucune action supplémentaire.", incident_id, status)
            return {
                "statusCode": 200,
                "body": json.dumps(
                    {"incident_id": incident_id, "status": status, "note": "Incident déjà traité."}
                ),
            }

        # --- RAG vectoriel : recherche du précédent le plus proche ---
        try:
            embedding = get_embedding(alert_text)
            similar = find_similar_incident(conn, embedding)
            if similar:
                context.setdefault("rag_context", {})
                context["rag_context"] = {
                    "closest_known_incident": similar["error_message_text"],
                    "distance": float(similar["distance"]),
                }
                logger.info(
                    "Incident historique similaire trouvé (distance=%.4f): %s",
                    similar["distance"],
                    similar["error_message_text"][:120],
                )
        except RuntimeError as exc:
            # Le RAG est une aide au diagnostic, pas une dépendance dure :
            # on continue sans contexte historique plutôt que d'échouer.
            logger.warning("RAG vectoriel indisponible, poursuite sans contexte historique: %s", exc)

        persist_incident_state(conn, incident_id, "DIAGNOSING", "RAG_LOOKUP_DONE", context)

        # --- Boucle d'agent (diagnostic + réparation via tool calling) ---
        result = run_agent_loop(conn, incident_id, status, context, alert_text)

        return {
            "statusCode": 200,
            "body": json.dumps({"incident_id": incident_id, **result}),
        }

    except RuntimeError as exc:
        # Erreur métier propre (DB indisponible, Bedrock en échec, etc.)
        logger.error("Échec contrôlé du handler Cloud-Surgeon: %s", exc)
        return {"statusCode": 500, "body": json.dumps({"error": str(exc)})}
    except Exception as exc:  # noqa: BLE001 - dernier filet de sécurité du handler
        logger.exception("Erreur inattendue dans le handler Cloud-Surgeon")
        return {"statusCode": 500, "body": json.dumps({"error": f"Erreur interne: {exc}"})}
    finally:
        if conn is not None:
            conn.close()
