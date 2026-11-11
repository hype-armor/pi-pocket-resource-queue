export const RESUME_INTERVAL_MS = 15_000;

function newGate(now: () => number) {
  // The same anchor controls startup and the interval after each admission.
  let anchor = now();
  let interval = RESUME_INTERVAL_MS;
  return {
    configure(delayMs: number) {
      if (!Number.isFinite(delayMs) || delayMs < 1_000 || delayMs > 600_000)
        throw new Error("Resume spacing must be between 1 and 600 seconds.");
      interval = delayMs;
    },
    remainingMs: () => Math.max(0, anchor + interval - now()),
    acquire(ready: boolean): boolean {
      if (!ready || now() < anchor + interval) return false;
      anchor = now();
      return true;
    },
  };
}

// Node caches helper modules across root-module reloads. Old and new generations
// share one clock. This is transient scheduling state, not durable queue data.
// A fresh process always waits a full configured startup interval.
const gates = new Map<string, ReturnType<typeof newGate>>();
export function createResumeGate(
  now: () => number = () => performance.now(),
  key?: string,
) {
  if (key === undefined) return newGate(now);
  let gate = gates.get(key);
  if (!gate) {
    gate = newGate(now);
    gates.set(key, gate);
  }
  return gate;
}
export type ResumeGate = ReturnType<typeof createResumeGate>;
