export const RESUME_INTERVAL_MS = 15_000;

function newGate(now: () => number) {
  // A full startup interval also protects against a reservation just before restart.
  let nextStart = now() + RESUME_INTERVAL_MS;
  return {
    remainingMs: () => Math.max(0, nextStart - now()),
    acquire(ready: boolean): boolean {
      if (!ready || now() < nextStart) return false;
      nextStart = now() + RESUME_INTERVAL_MS;
      return true;
    },
  };
}

// Node caches helper modules across root-module reloads. Old and new generations
// must share the same admission clock, including while their lifetimes overlap.
// This is transient scheduling state, not queue data. A process restart starts
// a conservative full cooldown; durable tasks and receipts remain in Pi Durable.
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
