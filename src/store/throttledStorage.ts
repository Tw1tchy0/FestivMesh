import type { PersistStorage, StorageValue } from 'zustand/middleware';

type Backend = {
  getItem(name: string): Promise<string | null>;
  setItem(name: string, value: string): Promise<void>;
  removeItem(name: string): Promise<void>;
};

/**
 * zustand persist storage that saves at most once every `delayMs`, and only when a persisted
 * field actually changed. Without this, every GPS fix (once a second) re-serialises every chat
 * and node to disk. Call `flush()` when the app goes to the background so nothing is lost.
 */
export function createThrottledStorage<S extends object>(backend: Backend, delayMs: number) {
  let latest: { name: string; value: StorageValue<S> } | null = null;
  let lastWritten: S | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const unchanged = (a: S, b: S | null) =>
    !!b && Object.keys(a).every((k) => a[k as keyof S] === b[k as keyof S]);

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const w = latest;
    latest = null;
    if (!w || unchanged(w.value.state, lastWritten)) return;
    lastWritten = w.value.state;
    await backend.setItem(w.name, JSON.stringify(w.value));
  };

  const storage: PersistStorage<S> = {
    getItem: async (name) => {
      const raw = await backend.getItem(name);
      if (raw === null) return null;
      const value = JSON.parse(raw) as StorageValue<S>;
      lastWritten = value.state;
      return value;
    },
    setItem: (name, value) => {
      latest = { name, value };
      if (!timer) timer = setTimeout(() => void flush().catch(() => {}), delayMs);
    },
    removeItem: (name) => {
      latest = null;
      lastWritten = null;
      return backend.removeItem(name);
    },
  };
  return { storage, flush };
}
