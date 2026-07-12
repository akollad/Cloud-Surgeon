// Script simple pour tester Bedrock directement
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les variables d'environnement depuis .env
const envPath = join(__dirname, '.env');
let envContent = '';
try {
  envContent = readFileSync(envPath, 'utf8');
} catch (err) {
  console.error('Impossible de lire le fichier .env:', err.message);
  process.exit(1);
}

// Parser les variables d'environnement
const envVars = {};
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
      envVars[key] = value;
    }
  }
});

// Configurer les variables d'environnement pour ce script
Object.assign(process.env, envVars);

// Tester Bedrock
const REGION = process.env.BEDROCK_REGION || 'us-east-1';
const BEDROCK_API_KEY = process.env.BEDROCK_API_KEY;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

console.log('=== Test Bedrock Configuration ===');
console.log(`Région Bedrock: ${REGION}`);
console.log(`BEDROCK_API_KEY défini: ${!!BEDROCK_API_KEY}`);
console.log(`AWS_ACCESS_KEY_ID défini: ${!!AWS_ACCESS_KEY_ID}`);
console.log(`AWS_SECRET_ACCESS_KEY défini: ${!!AWS_SECRET_ACCESS_KEY}`);

// Construire la requête de test
const MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
const ENDPOINT = `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(MODEL_ID)}/invoke`;

const requestBody = JSON.stringify({
  anthropic_version: "bedrock-2023-05-31",
  max_tokens: 10,
  messages: [{ role: "user", content: "Say 'Hello World'" }],
});

console.log('\n=== Test avec BEDROCK_API_KEY ===');
if (BEDROCK_API_KEY) {
  try {
    console.log(`Endpoint: ${ENDPOINT}`);
    console.log('Tentative de connexion...');
    
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${BEDROCK_API_KEY}`,
      },
      body: requestBody,
    });

    console.log(`Status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Erreur détaillée: ${errorText.substring(0, 500)}`);
    } else {
      const result = await response.json();
      console.log('Success! Réponse:', JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('Erreur de connexion:', error.message);
    console.error('Stack:', error.stack);
  }
} else {
  console.log('BEDROCK_API_KEY non défini, test ignoré.');
}

console.log('\n=== Test avec AWS Credentials ===');
if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
  try {
    // Essayer d'importer le SDK AWS
    const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    
    const client = new BedrockRuntimeClient({ region: REGION });
    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: requestBody,
    });

    console.log('Tentative avec AWS SDK...');
    const response = await client.send(command);
    console.log('Success! Réponse reçue via AWS SDK');
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    console.log('Contenu:', JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error('Erreur AWS SDK:', error.message);
    console.error('Stack:', error.stack);
    
    // Vérifier si c'est une erreur d'authentification
    if (error.name === 'CredentialsProviderError') {
      console.error('Problème avec les credentials AWS');
    } else if (error.name === 'ThrottlingException') {
      console.error('Limite de requêtes dépassée (throttling)');
    } else if (error.name === 'AccessDeniedException') {
      console.error('Accès refusé - vérifiez les permissions IAM');
    }
  }
} else {
  console.log('AWS credentials non définis, test ignoré.');
}

console.log('\n=== Résumé ===');
console.log('Si les deux méthodes échouent, Bedrock n\'est probablement pas accessible depuis votre environnement.');
console.log('Le "geo-block from container" signifie généralement que:');
console.log('1. Votre IP est bloquée par AWS');
console.log('2. Vous êtes dans une région non supportée');
console.log('3. Le service Bedrock n\'est pas activé sur votre compte AWS');
console.log('4. Les credentials sont invalides ou expirés');