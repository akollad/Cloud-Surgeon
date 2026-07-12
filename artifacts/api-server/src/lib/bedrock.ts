import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { logger } from "./logger";

// ----------------------------------------------------------------------------
// Vrai appel à Amazon Bedrock (Claude 3.5 Haiku) pour générer le
// raisonnement ("thought") de chaque tour de l'agent, à la place du texte
// français figé. Le choix de l'outil et son exécution restent déterministes
// (voir cloud-surgeon.ts) — seule la partie "réflexion" est déléguée à un
// vrai LLM, ce qui est déjà suffisant pour prouver l'appel Bedrock réel sans
// rendre la démo imprévisible ou dangereuse.
//
// Si AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY ne sont pas configurées, ou si
// l'appel échoue (ex: accès au modèle non activé dans la console Bedrock),
// on renvoie `null` et l'appelant retombe sur le texte simulé — de façon
// transparente, jamais silencieuse (voir le champ `thoughtSource`).
// ----------------------------------------------------------------------------

const MODEL_ID = "anthropic.claude-3-5-haiku-20241022-v1:0";

let client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient | null {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }
  if (!client) {
    client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
  }
  return client;
}

export async function invokeBedrockThought(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
): Promise<string | null> {
  const bedrock = getClient();
  if (!bedrock) return null;

  const prompt =
    turnIndex === 0
      ? `Tu es un agent DevOps autonome. Une alerte d'infrastructure vient d'arriver : "${alertText}". ` +
        `En une phrase en français, explique ton raisonnement pour décider de vérifier l'état du cluster avant toute action corrective.`
      : `Tu es un agent DevOps autonome. Après diagnostic (résultat: ${JSON.stringify(priorToolOutput)}), ` +
        `en une phrase en français, explique ton raisonnement pour décider de déclencher une action de réparation.`;

  try {
    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const response = await bedrock.send(command);
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const text: string | undefined = payload?.content?.[0]?.text;
    return text?.trim() || null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Bedrock invocation failed, falling back to simulated thought",
    );
    return null;
  }
}
