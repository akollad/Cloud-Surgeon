import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Dashboard auth gate.
 *
 * On submit the password is sent to POST /api/auth/token — the server
 * validates it and returns a short-lived JWT (1 h).  The JWT is stored in
 * sessionStorage and injected into every API request via setAuthTokenGetter
 * (configured in main.tsx).  The long-lived CLOUD_SURGEON_API_KEY never
 * reaches the browser.
 *
 * If DASHBOARD_PASSWORD is not set server-side the endpoint returns a token
 * without checking the password (dev / demo no-op).
 */

const SESSION_KEY = 'cs-dashboard-token';

function getStoredToken(): string | null {
  return sessionStorage.getItem(SESSION_KEY);
}

async function fetchToken(password: string): Promise<string | null> {
  try {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
    const res = await fetch(`${base}/api/auth/token`, {
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

  if (unlocked) return <>{children}</>;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(false);
    const token = await fetchToken(value);
    setLoading(false);
    if (token) {
      sessionStorage.setItem(SESSION_KEY, token);
      setUnlocked(true);
    } else {
      setError(true);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-mono text-sm uppercase tracking-tight text-primary">
            &gt; Cloud-Surgeon
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <p className="text-xs text-muted-foreground font-mono">
              Enter the dashboard password to continue.
            </p>
            <Input
              type="password"
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(false);
              }}
              placeholder="Password"
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
