/**
 * Routes de chaos engineering
 *
 * POST /api/chaos/sigkill
 *   Tue le process Node en cours avec SIGKILL après un court délai.
 *   Utilisé par le dashboard pour déclencher un vrai crash de process depuis
 *   l'UI, sans manipulation manuelle du terminal — identique à ce que ferait
 *   un OOMKiller ou un orchestrateur ECS/Lambda qui force-kill une tâche.
 *
 *   Workflow manager Replit redémarre automatiquement le service (comme
 *   l'orchestrateur Lambda redémarrerait une fonction après un crash).
 *   Le dashboard peut ensuite re-déclencher le même incident et prouver
 *   que la reprise depuis CockroachDB est sans perte de contexte.
 *
 * SÉCURITÉ : cette route est protégée par apiKeyAuth (même clé que toutes
 *   les routes incidents). En production elle serait désactivée ou restreinte
 *   à un réseau interne.
 */
import { Router, type IRouter } from "express";
import { apiKeyAuth } from "../middleware/apiKeyAuth";

const router: IRouter = Router();

router.use(apiKeyAuth);

router.post("/chaos/sigkill", (req, res): void => {
  req.log.warn("CHAOS: SIGKILL requested via dashboard — process will die in 300ms");

  // Répondre immédiatement avant de mourir, pour que le dashboard reçoive
  // la confirmation avant la coupure de connexion.
  res.status(202).json({
    message: "SIGKILL scheduled — process will die in ~300ms. Workflow manager will restart it.",
    pid: process.pid,
    note: "Re-trigger the same incident after restart to prove stateful resumption from CockroachDB.",
  });

  // Tuer le process après le délai de réponse
  setTimeout(() => {
    process.kill(process.pid, "SIGKILL");
  }, 300);
});

export default router;
