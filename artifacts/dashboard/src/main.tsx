import { createRoot } from 'react-dom/client';
import { setBaseUrl, setAuthTokenGetter } from '@workspace/api-client-react';

import App from './App';
import './index.css';

// In dev, relative /api/* paths are routed to the API server by the Replit proxy.
// In production (AWS ALB), ALB routes /api/* to Express — same relative paths work.
// Only set a base URL if explicitly provided (e.g. cross-origin staging API).
const apiBase = import.meta.env.VITE_API_BASE_URL;
if (apiBase) setBaseUrl(apiBase);

// Authenticate all API requests with the session JWT stored in localStorage.
// The JWT is obtained by LoginGate via POST /api/auth/token (password exchange).
// The long-lived CLOUD_SURGEON_API_KEY never reaches the browser bundle.
setAuthTokenGetter(() => localStorage.getItem('cs-dashboard-token'));

createRoot(document.getElementById('root')!).render(<App />);
