import { useState, useEffect, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Logo } from '@/components/brand/Logo';

/**
 * Dashboard auth gate.
 *
 * On submit the password is sent to POST /api/auth/token — the server
 * validates it and returns a short-lived JWT (1 h).  The JWT is stored in
 * localStorage so it persists across page refreshes.  It is injected into
 * every API request via setAuthTokenGetter (configured in main.tsx).
 * The long-lived CLOUD_SURGEON_API_KEY never reaches the browser.
 *
 * If DASHBOARD_PASSWORD is not set server-side the endpoint returns a token
 * without checking the password (dev / demo no-op).
 */

const SESSION_KEY = 'cs-dashboard-token';

/** Decode JWT payload without verifying signature (browser-side check only). */
function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function isTokenValid(token: string): boolean {
  const exp = jwtExpiry(token);
  if (exp === null) return true; // no exp claim → treat as valid
  return exp * 1000 > Date.now();
}

export function clearStoredToken(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

function getStoredToken(): string | null {
  // Migrate from sessionStorage if still present (users who logged in before
  // the localStorage switch keep their session without re-entering the password).
  try {
    const legacy = sessionStorage.getItem(SESSION_KEY);
    if (legacy) {
      localStorage.setItem(SESSION_KEY, legacy);
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {}
  const token = localStorage.getItem(SESSION_KEY);
  if (token && !isTokenValid(token)) {
    // Token exists but is expired — purge it so the login form shows.
    clearStoredToken();
    return null;
  }
  return token;
}

async function fetchToken(password: string): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.token === 'string' ? data.token : null;
  } catch {
    return null;
  }
}

export function LoginGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(() => Boolean(getStoredToken()));
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  // Lock the gate whenever an API call returns 401 (e.g. expired JWT).
  useEffect(() => {
    function handleExpired() {
      clearStoredToken();
      setUnlocked(false);
    }
    window.addEventListener('cs-auth-expired', handleExpired);
    return () => window.removeEventListener('cs-auth-expired', handleExpired);
  }, []);

  if (unlocked) return <>{children}</>;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(false);
    const token = await fetchToken(value);
    setLoading(false);
    if (token) {
      localStorage.setItem(SESSION_KEY, token);
      setUnlocked(true);
    } else {
      setError(true);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center pb-2 pt-6">
          <Logo variant="horizontal" theme="brand" size="lg" />
        </CardHeader>
        <CardContent className="pt-4">
          <form onSubmit={handleSubmit} className="space-y-3">
            <p className="text-xs text-muted-foreground font-mono text-center">
              Password:{" "}
              <button
                type="button"
                className="font-semibold text-primary underline-offset-2 hover:underline cursor-pointer"
                onClick={() => { setValue("cloudsurgeon-demo"); setError(false); }}
              >
                cloudsurgeon-demo
              </button>
            </p>
            <Input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(false);
              }}
              placeholder="cloudsurgeon-demo"
              data-testid="input-dashboard-password"
              disabled={loading}
            />
            {error && (
              <p className="text-xs text-destructive font-mono" data-testid="text-password-error">
                Incorrect password.
              </p>
            )}
            <Button type="submit" className="w-full" data-testid="button-unlock" disabled={loading}>
              {loading ? 'Verifying…' : 'Unlock'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
