import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Phase 1 auth gate (hackathon) — see MIGRATION_REACT.md "Gate d'auth".
// A single shared password protects the dashboard UI. It is NOT a real
// authentication system: there are no per-user accounts, and the password
// travels in the client bundle's env var, so this only deters casual access,
// not a motivated attacker. Phase 2 (post-hackathon) replaces this with
// Cognito/Amplify without touching any other component, since the gate is
// fully isolated here.
const SESSION_KEY = 'cloud-surgeon-dashboard-unlocked';
const PASSWORD = import.meta.env.VITE_DASHBOARD_PASSWORD as string | undefined;

function isUnlocked(): boolean {
  // No password configured → gate is a no-op (dev / demo environments).
  if (!PASSWORD) return true;
  return sessionStorage.getItem(SESSION_KEY) === 'true';
}

export function LoginGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(isUnlocked);
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  if (unlocked) return <>{children}</>;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (value === PASSWORD) {
      sessionStorage.setItem(SESSION_KEY, 'true');
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
            />
            {error && (
              <p className="text-xs text-destructive font-mono" data-testid="text-password-error">
                Incorrect password.
              </p>
            )}
            <Button type="submit" className="w-full" data-testid="button-unlock">
              Unlock
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
