import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createExtension from "../resource-queue.ts";
import { createResumeGate } from "../resource-queue/lib/resume-gate.ts";
import { createProcessSampler } from "../resource-queue/lib/processes.ts";
import setupBrowser from "../resource-queue/index.js";

const off = {
  minFreeMemoryPercent: 0,
  maxLoadPerCpu: 0,
  maxIoWaitPercent: 0,
  minFreeDiskPercent: 0,
  pollSeconds: 5,
};

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "resource-queue-unit-"));
  const disposers: (() => void)[] = [];
  const commands: Record<string, any> = {};
  const notices: any[] = [];
  const docs = new Map<string, any>();
  const values = { ...off };
  let status: any;
  let time = 0;
  const gate = createResumeGate(() => time, dir);
  const startCalls: any[] = [];
  const host = {
    dataDir: dir,
    notice: (...args: any[]) => notices.push(args),
    linkedSessions: {
      start: async (...args: any[]) => {
        startCalls.push(args);
        return { session: 88, address: "linked-88" };
      },
    },
  };
  const web = {
    command: (name: string, spec: any) => (commands[name] = spec),
    settings() {},
    setting: (name: string) => values[name as keyof typeof values],
    route: (_method: string, _path: string, handler: any) => (status = handler),
    client() {},
    send() {},
    onDispose: (fn: () => void) => disposers.push(fn),
  };
  const extension = createExtension(host as any, web as any);
  const doc = async (token: any, conversationId?: number) => {
    const key = `${token.definition.kind}:${conversationId ?? "global"}`;
    if (!docs.has(key)) docs.set(key, token.definition.initial());
    return docs.get(key);
  };
  const tx = { doc, createTask: async () => 42 };
  const context = { abortSignal: new AbortController().signal };
  const api = {
    conversationId: 1,
    taskId: 10,
    callId: "call-1",
    commit: async (fn: any) => fn(tx),
  };
  const commandContext = (id = 1) => ({
    conversationId: id,
    context,
    commit: async (fn: any) => fn(tx),
    snapshot: (token: any, cid: number) => doc(token, cid),
  });
  const states: any[] = [];
  const runtime = {
    signal: context.abortSignal,
    now: () => time,
    snapshot: (token: any, cid: number) => doc(token, cid),
    commit: async (fn: any) => {
      const result = await fn(tx);
      if (result) states.push(result);
    },
    sleepUntil: async (until: number, checkpoint: any) =>
      states.push({ status: "sleeping", until, checkpoint }),
  };
  t.after(async () => {
    disposers.forEach((fn) => fn());
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    extension,
    commands,
    docs,
    status: () => status(),
    values,
    notices,
    gate,
    setTime: (value: number) => (time = value),
    startCalls,
    api,
    context,
    commandContext,
    runtime,
    states,
    dispose: () => disposers.forEach((fn) => fn()),
  };
}

test("gate spaces concurrent admissions and checks capacity", () => {
  let now = 0;
  const gate = createResumeGate(() => now);
  assert.equal(gate.acquire(true), false);
  now = 15_000;
  assert.equal(gate.acquire(false), false);
  assert.equal(gate.acquire(true), true);
  assert.equal(gate.acquire(true), false);
  now = 29_999;
  assert.equal(gate.acquire(true), false);
  now = 30_000;
  assert.equal(gate.acquire(true), true);
});

test("overlapping reload generations share their reservation", () => {
  let now = 0;
  const oldGate = createResumeGate(() => now, "reload-test");
  now = 10_000;
  const newGate = createResumeGate(() => now, "reload-test");
  assert.equal(oldGate, newGate);
  now = 15_000;
  assert.equal(oldGate.acquire(true), true);
  now = 20_000;
  assert.equal(newGate.acquire(true), false);
  now = 30_000;
  assert.equal(newGate.acquire(true), true);
  assert.equal(
    createResumeGate(() => 0).acquire(true),
    false,
    "fresh process model starts with full cooldown",
  );
});

test("held calls show counts, cancel cleanly, and stop on disposal", async (t) => {
  const f = await fixture(t);
  const before = f.extension.hooks![0].handlers.beforeTool!;
  const ctl = new AbortController();
  const held = before(
    { name: "read", arguments: {} } as any,
    { conversationId: 1 } as any,
    { abortSignal: ctl.signal } as any,
  );
  assert.equal(f.status().waiting[0].count, 1);
  ctl.abort(new Error("stopped"));
  await assert.rejects(held as Promise<any>, /stopped/);
  assert.equal(f.status().waiting.length, 0);
  const other = before(
    { name: "read", arguments: {} } as any,
    { conversationId: 2 } as any,
    f.context as any,
  );
  f.dispose();
  await assert.rejects(other as Promise<any>, /reloaded/);
  assert.equal(f.status().waiting.length, 0);
  await before(
    { name: "resource_queue_start", arguments: {} } as any,
    {} as any,
    f.context as any,
  );
});

test("enqueue is idempotent and cancellation is scoped to its conversation", async (t) => {
  const f = await fixture(t);
  const tool = f.extension.tools![0];
  await tool.execute(
    { message: "work", title: "Example" },
    f.api as any,
    f.context as any,
  );
  await tool.execute(
    { message: "work", title: "Example" },
    f.api as any,
    f.context as any,
  );
  const status = await f.commands["resource-queue-status"].handler(
    "",
    f.commandContext(),
  );
  assert.match(status.output, /42: waiting/);
  const denied = await f.commands["resource-queue-cancel"].handler(
    "42",
    f.commandContext(2),
  );
  assert.match(denied.output, /No such/);
  const cancelled = await f.commands["resource-queue-cancel"].handler(
    "42",
    f.commandContext(),
  );
  assert.match(cancelled.output, /cancelled/);
  const phases = f.extension.tasks![0].definition.phases;
  await phases.start(
    { id: 42, conversationId: 1, input: { message: "work" } } as any,
    f.runtime as any,
    f.context as any,
  );
  assert.equal(f.startCalls.length, 0);
  assert.equal(f.states.at(-1).outcome.status, "aborted");
});

test("queued starts share the gate and record completion", async (t) => {
  const f = await fixture(t);
  await f.extension.tools![0].execute(
    { message: "work" },
    f.api as any,
    f.context as any,
  );
  const phases = f.extension.tasks![0].definition.phases;
  const task = { id: 42, conversationId: 1, input: { message: "work" } };
  await phases.start(task as any, f.runtime as any, f.context as any);
  assert.equal(f.states.at(-1).status, "sleeping");
  f.setTime(15_000);
  await phases.start(task as any, f.runtime as any, f.context as any);
  assert.equal(f.startCalls.length, 1);
  assert.equal(f.gate.acquire(true), false);
  assert.equal(f.states.at(-1).outcome.status, "completed");
  const status = await f.commands["resource-queue-status"].handler(
    "",
    f.commandContext(),
  );
  assert.match(status.output, /completed.*linked-88/);
});

test("rail dot follows ready, paused, and recovery states without a bubble", () => {
  let rail: any;
  let statusEvent: any;
  const styles: string[] = [];
  setupBrowser({
    style: (name: string) => styles.push(name),
    toolCall() {},
    page() {},
    launcher() {},
    rail: (spec: any) => {
      rail = spec;
      return { update: (patch: any) => (rail = { ...rail, ...patch }) };
    },
    api: () => new Promise(() => {}),
    on: (_name: string, handler: any) => (statusEvent = handler),
  });
  assert.ok(styles.includes("rail-status.css"));
  statusEvent({ ready: true, checks: [], waiting: [], resumeDelaySeconds: 0 });
  assert.match(rail.title, /Ready/);
  assert.equal(rail.badge, null);
  statusEvent({
    ready: false,
    checks: [
      { enabled: true, ok: false, reason: "CPU load is above its limit" },
    ],
  });
  assert.match(rail.title, /Paused.*CPU load/);
  statusEvent({ ready: true, checks: [], waiting: [], resumeDelaySeconds: 12 });
  assert.match(rail.title, /Recovery/);
  assert.equal(rail.badge, null);
});

test("live process sampler returns bounded sorted lists", async () => {
  const sample = createProcessSampler();
  const first = await sample();
  if (!first.supported) return;
  assert.equal(first.warming, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await sample();
  assert.equal(second.warming, false);
  for (const key of ["cpu", "memory", "io"] as const) {
    assert.ok(second[key].length <= 3);
    assert.ok(
      second[key].every((row) => Number.isFinite(row.value) && row.value >= 0),
    );
    assert.deepEqual(
      second[key].map((row) => row.value),
      second[key].map((row) => row.value).sort((a, b) => b - a),
    );
  }
});
