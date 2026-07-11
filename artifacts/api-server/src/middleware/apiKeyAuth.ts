import type { NextFunction, Request, Response } from "express";

// Authentification simple par clé API partagée entre le dashboard Streamlit
// et ce service. Sans ça, n'importe qui connaissant l'URL du service peut
// déclencher/lire des incidents — inacceptable même pour une démo, et
// explicitement pointé comme un manque de "production readiness".
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.CLOUD_SURGEON_API_KEY;
  if (!expected) {
    // Si la clé n'est pas configurée, on fail-closed plutôt que d'ouvrir
    // l'API sans protection.
    res.status(503).json({ error: "API key not configured on server" });
    return;
  }

  const provided = req.header("x-api-key");
  if (provided !== expected) {
    res.status(401).json({ error: "Unauthorized: missing or invalid x-api-key header" });
    return;
  }

  next();
}
