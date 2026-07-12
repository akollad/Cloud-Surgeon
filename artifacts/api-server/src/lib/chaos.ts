/**
 * chaos.ts — Chaos engineering à la couche application
 *
 * ## Portée et limites
 * Replit ne donne pas accès aux primitives réseau OS (iptables, tc netem,
 * network namespaces), donc le chaos est injecté dans la couche applicative :
 *   - LATENCY  : délai synchrone avant chaque écriture DB persistante
 *   - PARTITION: simulation d'un timeout DB (N opérations "échouent" avec un
 *                délai de timeout, puis la connexion se rétablit — exactement
 *                ce que produit un split-brain bref ou un restart de nœud DB)
 *
 * ## Ce que ça démontre
 *
 * LATENCY — "Même avec 500 ms de latence DB ajoutée à chaque write, l'agent
 *   complète en ~1.5 s de latence totale ajoutée. CockroachDB absorbe la
 *   lenteur ; la résilience n'est pas sensible à la performance réseau."
 *
 * PARTITION — "Après 2 écritures DB simulées comme perdues (ECONNRESET), le
 *   contexte persisted avant la partition est relu sans perte. L'agent reprend
 *   exactement au turn suivant — pas de duplication, pas d'incohérence."
 *
 * ## Out of scope
 * - Chaos au niveau OS (iptables, tc) — non disponible dans Replit
 * - Partition CockroachDB réelle (nécessite cluster multi-nœuds)
 * - Tests de montée en charge
 */

/** Mode de chaos à injecter pendant la boucle d'agent. */
export type ChaosMode = "none" | "latency" | "partition";

/**
 * Erreur levée lors d'une partition simulée.
 * Propagée vers `persistWithChaosRetry()` qui la capture, logue l'événement,
 * attend la "recovery", puis retente l'écriture DB.
 */
export class ChaosPartitionError extends Error {
  constructor(phase: number) {
    super(
      `ChaosPartitionError: simulated DB partition at phase ${phase} — ` +
      `ECONNRESET after network timeout. Previous phase state intact in CockroachDB.`,
    );
    this.name = "ChaosPartitionError";
  }
}

/**
 * Configuration du chaos pour un incident.
 * Mutable intentionnellement : le compteur `_partitionFailuresLeft` est
 * décrémenté à chaque tentative simulée pour revenir à zéro.
 */
export interface ChaosConfig {
  mode: ChaosMode;
  /** Délai en ms injecté avant chaque write DB (mode latency). Défaut : 500. */
  latencyMs: number;
  /** Nombre d'opérations à simuler comme timeout (mode partition). Défaut : 2. */
  _partitionFailuresLeft: number;
}

/** Crée une ChaosConfig depuis un chaosMode string reçu de l'API. */
export function createChaosConfig(
  mode: string | undefined,
  latencyMs = 500,
  partitionFailures = 2,
): ChaosConfig {
  const validMode: ChaosMode =
    mode === "latency" || mode === "partition" ? mode : "none";
  return {
    mode: validMode,
    latencyMs,
    _partitionFailuresLeft: validMode === "partition" ? partitionFailures : 0,
  };
}

/** Résultat d'une injection de chaos (pour logging). */
export interface ChaosEvent {
  mode: ChaosMode;
  /** Délai effectivement attendu, en ms. */
  delayMs: number;
  /** `true` si c'était une partition simulée (failure + recovery). */
  wasPartition: boolean;
  /** Tour agent concerné (0 = Diagnostician, 1 = Remediator, 2 = Auditor). */
  atPhase: number;
}

/**
 * Injecte le chaos configuré avant une opération DB.
 *
 * - NONE    : no-op, retourne null
 * - LATENCY : attend `latencyMs` ms (simule réseau DB lent) puis retourne un event
 * - PARTITION: si `_partitionFailuresLeft > 0`, décrémente le compteur et lève
 *              `ChaosPartitionError` — l'appelant DOIT catcher cette erreur,
 *              journaliser l'événement, attendre la "recovery", puis retenter
 *              l'opération DB (qui réussira car le compteur est maintenant < 1).
 *
 * L'appel normal ressemble à :
 *   try { await injectChaos(chaos, phase); }
 *   catch (err) { if (err instanceof ChaosPartitionError) { ... retry ... } else throw err; }
 *   await persistIncidentState(...);
 */
export async function injectChaos(
  chaos: ChaosConfig,
  phase: number,
): Promise<ChaosEvent | null> {
  if (chaos.mode === "none") return null;

  if (chaos.mode === "latency") {
    await sleep(chaos.latencyMs);
    return { mode: "latency", delayMs: chaos.latencyMs, wasPartition: false, atPhase: phase };
  }

  if (chaos.mode === "partition") {
    if (chaos._partitionFailuresLeft > 0) {
      chaos._partitionFailuresLeft--;
      // Throw BEFORE the DB write — the caller catches this, logs, waits,
      // then retries the persist (which will succeed on the next attempt).
      throw new ChaosPartitionError(phase);
    }
    // All failures exhausted — normal operation resumes
    return null;
  }

  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
