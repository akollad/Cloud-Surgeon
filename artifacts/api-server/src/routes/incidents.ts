import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, executionLogsTable, incidentStateTable } from "@workspace/db";
import {
  TriggerIncidentBody,
  TriggerIncidentResponse,
  ListIncidentsResponse,
  GetIncidentParams,
  GetIncidentResponse,
  ListExecutionLogsQueryParams,
  ListExecutionLogsResponse,
} from "@workspace/api-zod";
import {
  findSimilarIncident,
  getIncidentById,
  getOrCreateIncident,
  pseudoEmbedding,
  runAgentLoop,
} from "../lib/cloud-surgeon";
import { apiKeyAuth } from "../middleware/apiKeyAuth";

const router: IRouter = Router();

// Toutes les routes incidents/logs exigent la clé API partagée avec le
// dashboard — voir middleware/apiKeyAuth.ts.
router.use(apiKeyAuth);

router.post("/incidents/trigger", async (req, res): Promise<void> => {
  const parsed = TriggerIncidentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { alertText, simulateCrash } = parsed.data;

  const incident = await getOrCreateIncident(alertText);
  req.log.info(
    { incidentId: incident.incidentId, status: incident.status },
    "Incident triggered",
  );

  const alreadyTerminal =
    incident.status === "RESOLVED" || incident.status === "FAILED";

  if (!alreadyTerminal) {
    const embedding = pseudoEmbedding(alertText);
    const similar = await findSimilarIncident(embedding);
    if (similar) {
      req.log.info(
        { distance: similar.distance },
        "Found similar historical incident via RAG lookup",
      );
    }
  }

  const result = await runAgentLoop(incident, alertText, simulateCrash);

  res.json(TriggerIncidentResponse.parse(result));
});

router.get("/incidents", async (_req, res): Promise<void> => {
  const incidents = await db
    .select()
    .from(incidentStateTable)
    .orderBy(desc(incidentStateTable.updatedAt))
    .limit(50);

  res.json(ListIncidentsResponse.parse(incidents));
});

router.get("/incidents/:incidentId", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const incident = await getIncidentById(params.data.incidentId);
  if (!incident) {
    res.status(404).json({ error: "Incident not found" });
    return;
  }

  res.json(GetIncidentResponse.parse(incident));
});

router.get("/logs", async (req, res): Promise<void> => {
  const query = ListExecutionLogsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = query.data.incidentId
    ? await db
        .select()
        .from(executionLogsTable)
        .where(eq(executionLogsTable.incidentId, query.data.incidentId))
        .orderBy(desc(executionLogsTable.createdAt))
        .limit(100)
    : await db
        .select()
        .from(executionLogsTable)
        .orderBy(desc(executionLogsTable.createdAt))
        .limit(100);

  res.json(ListExecutionLogsResponse.parse(rows));
});

export default router;
