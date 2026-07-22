/**
 * Provides a global muted state and runs the sound notification watcher.
 * Mount once at the app level (inside QueryClientProvider).
 */
import { createContext, useContext, useState, ReactNode } from "react";
import { useSoundNotifications } from "@/hooks/use-sound-notifications";

interface SoundContextValue {
  muted: boolean;
  toggle: () => void;
}

const SoundContext = createContext<SoundContextValue>({
  muted: false,
  toggle: () => {},
});

export function useSoundContext() {
  return useContext(SoundContext);
}

function SoundWatcher({ muted }: { muted: boolean }) {
  useSoundNotifications(muted);
  return null;
}

const LS_KEY = "cs-sound-muted";

function readMuted(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "true";
  } catch {
    return false;
  }
}

export function SoundNotificationsProvider({ children }: { children: ReactNode }) {
  const [muted, setMuted] = useState(readMuted);

  function toggle() {
    setMuted((v) => {
      const next = !v;
      try {
        localStorage.setItem(LS_KEY, String(next));
      } catch {}
      return next;
    });
  }

  return (
    <SoundContext.Provider value={{ muted, toggle }}>
      <SoundWatcher muted={muted} />
      {children}
    </SoundContext.Provider>
  );
}
