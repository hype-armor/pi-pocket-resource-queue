/** Monitor memory, CPU load, I/O wait, data-disk space, and top Linux processes. Pause tool calls across sessions and stagger waiting admissions with a configurable resume delay. Reads /proc/stat and per-process stat, status, and io counters; never command arguments. Uses the experimental linked-session, settings, and browser status APIs. No external network calls. */
import { readFile, statfs } from "node:fs/promises";
import { freemem, hostname, loadavg, totalmem, uptime, cpus } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  section,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { Host, Web } from "./_pocket.d.ts";
import { createProcessSampler } from "./resource-queue/lib/processes.ts";
import type { ProcessLeaders } from "./resource-queue/lib/processes.ts";
import { createResumeGate } from "./resource-queue/lib/resume-gate.ts";
import type { ResumeGate } from "./resource-queue/lib/resume-gate.ts";

export const pocketApi = 2;

/** Each limit: its default, and the range the owner may set. A limit of 0 turns its check off (pollSeconds has no off). */
const LIMITS = {
  minFreeMemoryPercent: { fallback: 20, min: 0, max: 95 },
  maxLoadPerCpu: { fallback: 0.75, min: 0, max: 16 },
  maxIoWaitPercent: { fallback: 15, min: 0, max: 100 },
  minFreeDiskPercent: { fallback: 10, min: 0, max: 95 },
  pollSeconds: { fallback: 20, min: 5, max: 600 },
  resumeSpacingSeconds: { fallback: 15, min: 1, max: 600 },
} as const;

type LimitName = keyof typeof LIMITS;
type Limits = { [K in LimitName]: number };

const QueueReceipts = defineDoc<{ receipts: Record<string, number> }>({
  kind: "x.resource-queue.receipts",
  version: 1,
  scope: "session",
  initial: () => ({ receipts: {} }),
  checkpointWhen: () => true,
});

/** The owner's values, read at each use. A missing or invalid value falls back to the default, inside its range. */
type QueueItem = {
  title: string;
  status: "waiting" | "starting" | "completed" | "failed" | "cancelled";
  detail?: string;
};
const QueueItems = defineDoc<{ items: Record<string, QueueItem> }>({
  kind: "x.resource-queue.items",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: () => true,
});

function config(web: Web): Limits {
  const read = (name: LimitName): number => {
    const rule = LIMITS[name];
    const value = web.setting?.(name);
    const number =
      typeof value === "number" && Number.isFinite(value)
        ? value
        : rule.fallback;
    return Math.min(rule.max, Math.max(rule.min, number));
  };

  return {
    minFreeMemoryPercent: read("minFreeMemoryPercent"),
    maxLoadPerCpu: read("maxLoadPerCpu"),
    maxIoWaitPercent: read("maxIoWaitPercent"),
    minFreeDiskPercent: read("minFreeDiskPercent"),
    pollSeconds: read("pollSeconds"),
    resumeSpacingSeconds: read("resumeSpacingSeconds"),
  };
}

async function cpuSnapshot() {
  try {
    const cpuLine = (await readFile("/proc/stat", "utf8"))
      .split("\n")
      .find((line) => /^cpu\s/.test(line));
    const values = cpuLine?.trim().split(/\s+/).slice(1).map(Number) ?? [];
    if (values.length >= 5 && values.every(Number.isFinite)) {
      return {
        total: values.slice(0, 8).reduce((sum, value) => sum + value, 0),
        ioWait: values[4],
        ioWaitSupported: true,
      };
    }
  } catch {
    // The platform may not expose Linux CPU counters.
  }

  const total = cpus().reduce(
    (sum, cpu) =>
      sum +
      Object.values(cpu.times).reduce((cpuSum, value) => cpuSum + value, 0),
    0,
  );
  return { total, ioWait: 0, ioWaitSupported: false };
}

async function diskSnapshot(path: string) {
  try {
    const fs = await statfs(path);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    if (total > 0 && Number.isFinite(free)) {
      return { path, total, free, freePercent: (free / total) * 100 };
    }
  } catch {
    // The data filesystem may not expose capacity information.
  }
  return undefined;
}

type Sampled = {
  ioWaitPercent: number | null;
  ioWaitSupported: boolean;
  disk: Awaited<ReturnType<typeof diskSnapshot>>;
  diskSupported: boolean;
};

export type Check = {
  id: "memory" | "load" | "io" | "disk";
  /** Off when its limit is 0, or the OS does not report it. */
  enabled: boolean;
  ok: boolean;
  /** What the owner reads, such as "free memory is below its limit". */
  reason: string;
};

/**
 * The one set of rules. The queue, the tool-call hold, and the monitor all use it.
 * Unknown measurements are not evidence that a resource limit is exceeded.
 */
function checksFor(
  limits: Limits,
  memory: { freePercent: number },
  loadPerCpu: number,
  sampled: Sampled,
): Check[] {
  const io = sampled.ioWaitSupported && limits.maxIoWaitPercent > 0;
  const disk = sampled.diskSupported && limits.minFreeDiskPercent > 0;

  return [
    {
      id: "memory",
      enabled: limits.minFreeMemoryPercent > 0,
      ok: memory.freePercent >= limits.minFreeMemoryPercent,
      reason: "free memory is below its limit",
    },
    {
      id: "load",
      enabled: limits.maxLoadPerCpu > 0,
      ok: loadPerCpu <= limits.maxLoadPerCpu,
      reason: "CPU load is above its limit",
    },
    {
      id: "io",
      enabled: io,
      ok:
        !io ||
        sampled.ioWaitPercent === null ||
        sampled.ioWaitPercent <= limits.maxIoWaitPercent,
      reason:
        sampled.ioWaitPercent === null
          ? "I/O wait is being measured"
          : "I/O wait is above its limit",
    },
    {
      id: "disk",
      enabled: disk,
      ok:
        !disk ||
        sampled.disk === undefined ||
        sampled.disk.freePercent >= limits.minFreeDiskPercent,
      reason:
        sampled.disk === undefined
          ? "data-disk space is being measured"
          : "free data-disk space is below its limit",
    },
  ];
}

function status(web: Web, sampled: Sampled) {
  const total = totalmem();
  const free = freemem();
  const cores = Math.max(1, cpus().length);
  const load = loadavg();
  const limits = config(web);
  const freePercent = total > 0 ? (free / total) * 100 : 0;
  const loadPerCpu = load[0] / cores;
  const checks = checksFor(limits, { freePercent }, loadPerCpu, sampled);

  return {
    host: hostname(),
    cpus: cores,
    load,
    loadPerCpu,
    memory: { total, free, freePercent },
    ioWaitPercent: sampled.ioWaitPercent,
    ioWaitSupported: sampled.ioWaitSupported,
    disk: sampled.disk,
    diskSupported: sampled.diskSupported,
    uptime: Math.round(uptime()),
    limits,
    checks,
    ready: checks.every((check) => !check.enabled || check.ok),
    at: Date.now(),
  };
}

type Reading = ReturnType<typeof status>;

function waitMessage(reading: Reading, interval: number) {
  if (reading.ready)
    return "Capacity is available. The request is queued and awaits its admission slot; no linked start is confirmed yet.";

  const reasons = reading.checks
    .filter((check) => check.enabled && !check.ok)
    .map((check) => check.reason);

  return `WAITING FOR RESOURCES: ${reasons.join("; ") || "capacity is not ready"}. The request stays queued and checks again in ${interval} seconds.`;
}

/** Resolve when `ms` passes, or reject when the signal aborts (Stop, Esc, or a restart). */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Hold a tool call until capacity is back. It polls the same status as the queue, and it waits only as long as the call runs. */
async function holdUntilReady(
  getStatus: () => Reading,
  web: Web,
  signal: AbortSignal | undefined,
  gate: ResumeGate,
): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
    const ready = getStatus().ready;
    if (gate.acquire(ready)) return;
    await pause(
      ready
        ? Math.max(1, Math.min(1000, gate.remainingMs()))
        : config(web).pollSeconds * 1000,
      signal,
    );
  }
}

function createPauseHook(
  getStatus: () => Reading,
  web: Web,
  host: Host,
  waiting: Map<number, number>,
  publish: () => void,
  gate: ResumeGate,
  lifetime: AbortSignal,
) {
  return hook(ToolTask, {
    // Pi's own tools wait while resources are low. The queue tool itself is never held: it only records the request.
    beforeTool: async (call, api, context) => {
      if (call.name === "resource_queue_start") return undefined;
      const signal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, lifetime])
        : lifetime;
      if (signal.aborted) throw signal.reason ?? new Error("Aborted");
      // Only calls that actually encounter resource pressure join recovery.
      // Healthy follow-up calls must not prolong the recovery queue.
      if (getStatus().ready) return undefined;
      const id = api.conversationId;
      const count = waiting.get(id) ?? 0;
      waiting.set(id, count + 1);
      if (count === 0) {
        const reasons = getStatus()
          .checks.filter((check) => check.enabled && !check.ok)
          .map((check) => check.reason);
        host.notice(
          "warning",
          `⏸ Paused: ${reasons.join("; ") || "staggered resource recovery"}. Waiting work resumes one start at a time, at least ${config(web).resumeSpacingSeconds} seconds apart. Stop cancels the wait.`,
          id,
        );
      }
      publish();
      let resumed = false;
      try {
        await holdUntilReady(getStatus, web, signal, gate);
        resumed = true;
        return undefined;
      } finally {
        const remaining = (waiting.get(id) ?? 1) - 1;
        if (remaining > 0) waiting.set(id, remaining);
        else {
          waiting.delete(id);
          host.notice(
            "info",
            resumed
              ? `▶ Tool call released. Further waiting work starts at least ${config(web).resumeSpacingSeconds} seconds apart.`
              : "Resource wait cancelled.",
            id,
          );
        }
        publish();
      }
    },
  });
}

function createQueueTask(
  host: Host,
  web: Web,
  getStatus: () => Reading,
  gate: ResumeGate,
) {
  type Input = { title?: string; message: string };
  type State = { phase: "check" | "start" };
  type Result = { session?: number; address?: string };

  return defineTask<Input, State, Result>({
    name: "x.resource-queue.start",
    version: 1,
    initial: () => ({ phase: "check" }),
    phases: {
      check: async (task, runtime, context) => {
        const items = await runtime.snapshot(
          QueueItems,
          task.conversationId,
          context,
        );
        if (items?.items[String(task.id)]?.status === "cancelled") {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "aborted", reason: "Queue item cancelled" },
            }),
            context,
          );
          return;
        }
        if (!getStatus().ready) {
          await runtime.sleepUntil(
            runtime.now() + config(web).pollSeconds * 1000,
            { phase: "check" },
            context,
          );
          return;
        }
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "start" } }),
          context,
        );
      },
      start: async (task, runtime, context) => {
        if (context.abortSignal?.aborted)
          throw context.abortSignal.reason ?? new Error("Aborted");
        const items = await runtime.snapshot(
          QueueItems,
          task.conversationId,
          context,
        );
        if (items?.items[String(task.id)]?.status === "cancelled") {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "aborted", reason: "Queue item cancelled" },
            }),
            context,
          );
          return;
        }
        // Reserve immediately before starting, not during the earlier phase transition.
        if (!gate.acquire(getStatus().ready)) {
          const delay = getStatus().ready
            ? Math.max(1, Math.min(1000, gate.remainingMs()))
            : config(web).pollSeconds * 1000;
          await runtime.sleepUntil(
            runtime.now() + delay,
            { phase: "start" },
            context,
          );
          return;
        }
        let cancelled = false;
        await runtime.commit(async (tx) => {
          const queue = await tx.doc(QueueItems, task.conversationId);
          const item = queue.items[String(task.id)];
          if (item?.status === "cancelled") cancelled = true;
          else
            queue.items[String(task.id)] = {
              title: task.input.title ?? "Linked work",
              status: "starting",
            };
          return undefined;
        }, context);
        if (cancelled) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "aborted", reason: "Queue item cancelled" },
            }),
            context,
          );
          return;
        }
        try {
          const result = await host.linkedSessions.start(
            task.conversationId,
            { title: task.input.title, message: task.input.message },
            `resource-queue:${task.id}`,
          );
          await runtime.commit(async (tx) => {
            const queue = await tx.doc(QueueItems, task.conversationId);
            queue.items[String(task.id)] = {
              title: task.input.title ?? "Linked work",
              status: "completed",
              detail: result.address,
            };
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: { session: result.session, address: result.address },
              },
            };
          }, context);
          host.notice(
            "info",
            `Queue item ${task.id} started linked session ${result.address}.`,
            task.conversationId,
          );
        } catch (error) {
          if (context.abortSignal?.aborted || runtime.signal.aborted)
            throw error;
          const message =
            "The linked session could not start. The request failed; no start is confirmed.";
          await runtime.commit(async (tx) => {
            const queue = await tx.doc(QueueItems, task.conversationId);
            queue.items[String(task.id)] = {
              title: task.input.title ?? "Linked work",
              status: "failed",
              detail: message,
            };
            return {
              status: "terminal",
              outcome: { status: "failed", error: { message } },
            };
          }, context);
          host.notice(
            "warning",
            `Queue item ${task.id} failed. Use /resource-queue-status for details.`,
            task.conversationId,
          );
        }
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "Queue item cancelled" },
        }),
        context,
      );
    },
  });
}

function createQueueTool(
  host: Host,
  web: Web,
  queueTask: ReturnType<typeof createQueueTask>,
  getStatus: () => Reading,
) {
  return defineTool({
    name: "resource_queue_start",
    description:
      "Start a linked work session when this server has capacity. If free memory or data-disk space is low, CPU load is high, or I/O wait exceeds its configured limit, keep the request queued and check again until capacity is available.",
    parameters: Type.Object({
      message: Type.String({
        minLength: 1,
        maxLength: 12000,
        description: "The work for the linked session",
      }),
      title: Type.Optional(
        Type.String({
          maxLength: 120,
          description: "A short title for the linked session",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      if (typeof host.linkedSessions?.start !== "function") {
        throw new Error(
          "This Pi Pocket version does not support linked sessions.",
        );
      }
      const receiptKey = `call:${api.taskId}:${api.callId}`;
      const taskId = await api.commit(async (tx) => {
        const receipts = await tx.doc(QueueReceipts);
        const previous = receipts.receipts[receiptKey];
        if (previous !== undefined) return previous;

        const queue = await tx.doc(QueueItems, api.conversationId);
        const created = await tx.createTask(
          queueTask,
          { message: args.message, title: args.title },
          {
            ownership: { kind: "conversation" },
            conversationId: api.conversationId,
            background: true,
          },
        );
        receipts.receipts[receiptKey] = created;
        queue.items[String(created)] = {
          title: args.title ?? "Linked work",
          status: "waiting",
        };
        return created;
      }, context);
      const reading = getStatus();
      return {
        output: [
          {
            type: "text" as const,
            text: `Queue item ${taskId}. ${waitMessage(reading, config(web).pollSeconds)} Admissions are at least ${config(web).resumeSpacingSeconds} seconds apart. Use /resource-queue-status to inspect it, or /resource-queue-cancel ${taskId} before it starts. Stop cancels held tools, not this background queue item.`,
          },
        ],
      };
    },
  });
}

export default function createResourceQueue(host: Host, web: Web) {
  web.command("resource-queue-status", {
    description: "Show this conversation's queued work and outcomes.",
    scope: "conversation",
    handler: async (_args, ctx) => {
      const queue = await ctx.snapshot(
        QueueItems,
        ctx.conversationId,
        ctx.context,
      );
      const rows = Object.entries(queue?.items ?? {}).slice(-30);
      return {
        type: "card",
        output: rows.length
          ? rows
              .map(
                ([id, item]) =>
                  `${id}: ${item.status} — ${item.title}${item.detail ? ` (${item.detail})` : ""}`,
              )
              .join("\n")
          : "No queued work in this conversation.",
      };
    },
  });
  web.command("resource-queue-cancel", {
    description:
      "Cancel a waiting queue item before its start is claimed. Items marked starting cannot be cancelled, even during restart recovery.",
    args: "<queue-item-id>",
    scope: "conversation",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!/^\d+$/.test(id))
        return {
          type: "card",
          output: "Usage: /resource-queue-cancel <queue-item-id>",
        };
      const message = await ctx.commit(async (tx) => {
        const queue = await tx.doc(QueueItems, ctx.conversationId);
        const item = queue.items[id];
        if (!item) return "No such queue item in this conversation.";
        if (item.status !== "waiting")
          return `Queue item ${id} is ${item.status}; it cannot be cancelled here.`;
        item.status = "cancelled";
        return `Queue item ${id} is cancelled. No linked session will start for it.`;
      });
      return { type: "card", output: message };
    },
  });
  if (typeof web.settings === "function") {
    web.settings([
      {
        name: "minFreeMemoryPercent",
        label: "Minimum free memory (%)",
        description:
          "Work waits while free memory is below this percentage. 0 turns this check off.",
        type: "number",
        default: LIMITS.minFreeMemoryPercent.fallback,
        min: LIMITS.minFreeMemoryPercent.min,
        max: LIMITS.minFreeMemoryPercent.max,
      },
      {
        name: "maxLoadPerCpu",
        label: "Maximum 1-minute load per CPU",
        description:
          "Work waits while the 1-minute load divided by the CPU count is above this. 0 turns this check off.",
        type: "number",
        default: LIMITS.maxLoadPerCpu.fallback,
        min: LIMITS.maxLoadPerCpu.min,
        max: LIMITS.maxLoadPerCpu.max,
      },
      {
        name: "maxIoWaitPercent",
        label: "Maximum I/O wait (%)",
        description:
          "Work waits while I/O wait, over the last 5 seconds, is above this. 0 turns this check off. Linux only.",
        type: "number",
        default: LIMITS.maxIoWaitPercent.fallback,
        min: LIMITS.maxIoWaitPercent.min,
        max: LIMITS.maxIoWaitPercent.max,
      },
      {
        name: "minFreeDiskPercent",
        label: "Minimum free data-disk space (%)",
        description:
          "Work waits while free space on Pi Pocket's data filesystem is below this percentage. 0 turns this check off.",
        type: "number",
        default: LIMITS.minFreeDiskPercent.fallback,
        min: LIMITS.minFreeDiskPercent.min,
        max: LIMITS.minFreeDiskPercent.max,
      },
      {
        name: "resumeSpacingSeconds",
        label: "Delay between resumed starts (seconds)",
        description:
          "Minimum spacing shared by waiting tool calls and queued session starts. Also sets the startup cooldown.",
        type: "number",
        default: LIMITS.resumeSpacingSeconds.fallback,
        min: LIMITS.resumeSpacingSeconds.min,
        max: LIMITS.resumeSpacingSeconds.max,
      },
      {
        name: "pollSeconds",
        label: "Check interval while waiting (seconds)",
        description:
          "How often a waiting tool call or queued start checks again.",
        type: "number",
        default: LIMITS.pollSeconds.fallback,
        min: LIMITS.pollSeconds.min,
        max: LIMITS.pollSeconds.max,
      },
    ]);
  }

  let previousCpu: Awaited<ReturnType<typeof cpuSnapshot>> | undefined;
  let sampled: Sampled = {
    ioWaitPercent: null,
    ioWaitSupported: process.platform === "linux",
    disk: undefined,
    diskSupported: true,
  };
  // Transient state for live hook executions only. Restarted calls register again.
  const waiting = new Map<number, number>();
  const resumeGate = createResumeGate(undefined, host.dataDir);
  resumeGate.configure(config(web).resumeSpacingSeconds * 1000);
  const lifetime = new AbortController();
  web.onDispose(() =>
    lifetime.abort(
      new Error("Resource queue reloaded; retry the interrupted call."),
    ),
  );
  const sampleProcesses = createProcessSampler();
  let processes: ProcessLeaders = {
    supported: process.platform === "linux",
    warming: true,
    cpu: [],
    memory: [],
    io: [],
    ioReadable: false,
  };
  const getStatus = () => {
    resumeGate.configure(config(web).resumeSpacingSeconds * 1000);
    return {
      ...status(web, sampled),
      processes,
      resumeDelaySeconds: Math.ceil(resumeGate.remainingMs() / 1000),
      waiting: Array.from(waiting, ([conversationId, count]) => ({
        conversationId,
        count,
      })),
    };
  };
  const publish = () => web.send("status", getStatus());

  web.route("GET", "status", getStatus);
  web.client("resource-queue");

  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const [currentCpu, currentDisk, currentProcesses] = await Promise.all([
        cpuSnapshot(),
        diskSnapshot(host.dataDir),
        sampleProcesses(),
      ]);
      processes = currentProcesses;
      let ioWaitPercent: number | null = null;
      if (
        previousCpu !== undefined &&
        currentCpu.ioWaitSupported &&
        previousCpu.ioWaitSupported
      ) {
        const totalDelta = currentCpu.total - previousCpu.total;
        const ioWaitDelta = currentCpu.ioWait - previousCpu.ioWait;
        if (totalDelta > 0)
          ioWaitPercent = Math.max(
            0,
            Math.min(100, (ioWaitDelta / totalDelta) * 100),
          );
      }
      previousCpu = currentCpu;
      sampled = {
        ioWaitPercent,
        ioWaitSupported: currentCpu.ioWaitSupported,
        disk: currentDisk,
        diskSupported: currentDisk !== undefined,
      };
    } catch {
      previousCpu = undefined;
      sampled = {
        ioWaitPercent: null,
        ioWaitSupported: false,
        disk: undefined,
        diskSupported: false,
      };
    }
    sampling = false;
    web.send("status", getStatus());
  };

  void sample();
  const timer = setInterval(() => void sample(), 5000);
  timer.unref();
  web.onDispose(() => clearInterval(timer));

  const queueTask = createQueueTask(host, web, getStatus, resumeGate);

  return defineExtension({
    name: "resource-queue",
    tasks: [queueTask],
    tools: [createQueueTool(host, web, queueTask, getStatus)],
    hooks: [
      createPauseHook(
        getStatus,
        web,
        host,
        waiting,
        publish,
        resumeGate,
        lifetime.signal,
      ),
    ],
    sections: [
      section(
        "resource-queue-guidance",
        () =>
          "When you use resource_queue_start, tell the person clearly if the work is waiting for resources. Do not say the linked session started until the tool confirms it.",
        { tag: false },
      ),
    ],
  });
}
