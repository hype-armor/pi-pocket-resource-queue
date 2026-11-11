import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join, resolve } from "node:path";
import { after, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const candidate = resolve(import.meta.dirname, "..");
const pocketSource = resolve(
  process.env.POCKET_SOURCE ?? join(candidate, "..", "pocket-test-source"),
);
// Await the helpers before importing app modules. They isolate the agent configuration.
const {
  cleanUp,
  context,
  lastText,
  loadTools: loadToolsHelper,
  modelTexts,
  newSession,
  openApp,
  owner,
  root,
  say,
  scriptedModel,
  until,
} = await import(pathToFileURL(join(pocketSource, "test", "helpers.ts")).href);
const { createHandler } = await import(
  pathToFileURL(join(pocketSource, "src", "server", "http.ts")).href
);
const { fauxAssistantMessage, fauxText, fauxToolCall } = await import(
  "@earendil-works/pi-ai/providers/faux"
);
type App = Awaited<ReturnType<typeof openApp>>;

function assertResumeDelay(seconds: unknown) {
  assert.ok(
    typeof seconds === "number" &&
      Number.isInteger(seconds) &&
      seconds >= 0 &&
      seconds <= 15,
    `The startup or admission cooldown must be within 0 to 15 seconds: ${seconds}`,
  );
}
const file = "resource-queue.ts";
const statusPath = "/api/x/resource-queue/status";
const disabledLimits = {
  minFreeMemoryPercent: 0,
  maxLoadPerCpu: 0,
  maxIoWaitPercent: 0,
  minFreeDiskPercent: 0,
  pollSeconds: 5,
  resumeSpacingSeconds: 15,
};

after(cleanUp);

// Pi Pocket 0.22 loads session tools eagerly. Newer test helpers expose loadTools.
async function loadTools(app: App, sessionId: string, toolName: string) {
  if (typeof loadToolsHelper === "function") {
    await loadToolsHelper(app, sessionId, toolName);
    return;
  }
  // The 0.22 harness has no tool-loading helper. It loads tools eagerly at runtime.
  assert.ok(app.harness.conversation);
}

/** Copy the supplied layout without repairs or links to live data. */
async function fixture(
  t: TestContext,
  model = scriptedModel(),
  entryOnly = false,
) {
  const dataDir = mkdtempSync(join(root, "resource-queue-"));
  const extensions = join(dataDir, "extensions");
  mkdirSync(extensions, { recursive: true });
  copyFileSync(join(candidate, file), join(extensions, file));
  if (!entryOnly) {
    for (const directory of [
      "resource-queue",
      "resource-queue-lib",
      "resource-queue-ui",
    ]) {
      const source = join(candidate, directory);
      if (existsSync(source))
        cpSync(source, join(extensions, directory), { recursive: true });
    }
  }
  const app = await openApp(model, dataDir);
  t.after(() => app.close());
  return { app, dataDir };
}

async function enable(app: App) {
  await app.setExtensionEnabled(owner(app), file, true);
  const info = app.loader.list().find((module) => module.file === file);
  assert.ok(info, "The candidate must appear in the extension list.");
  assert.equal(info.enabled, true);
  assert.equal(info.error, undefined, info.error);
  return info;
}

async function http(t: TestContext, app: App) {
  const server: Server = createServer(
    createHandler({
      app,
      listen: { host: "127.0.0.1", port: 0 },
      restart: () => {},
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return async (
    path = statusPath,
    token: string | null = app.config.ownerToken,
    pocketHeader = true,
  ) => {
    const response = await fetch(`${base}${path}`, {
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(pocketHeader ? { "x-pocket": "1" } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* Browser assets are not JSON. */
    }
    return { status: response.status, data };
  };
}

test(
  "the supplied candidate enables without module errors and serves its browser entry",
  { timeout: 20000 },
  async (t) => {
    const { app } = await fixture(t);
    const info = await enable(app);
    assert.ok(
      info.extensions.some((extension) =>
        extension.tools.includes("resource_queue_start"),
      ),
    );
    assert.ok(info.web?.routes.includes("GET status"));
    const call = await http(t, app);
    const me = await call("/api/me");
    assert.equal(me.status, 200);
    const ui = me.data.server.ui.find(
      (item: { module: string }) => item.module === "resource-queue",
    );
    assert.ok(ui, "The owner must receive the browser module.");
    const entry = await call(ui.url);
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.data, "string");
    assert.match(entry.data, /resource.queue/i);
    await app.setExtensionEnabled(owner(app), file, false);
    assert.equal((await call()).status, 404);
    assert.equal((await call(ui.url)).status, 404);
  },
);

test(
  "missing candidate dependencies produce an owner-visible module error and no status route",
  { timeout: 20000 },
  async (t) => {
    const { app } = await fixture(t, scriptedModel(), true);
    await assert.rejects(
      app.setExtensionEnabled(owner(app), file, true),
      /failed to load/i,
    );
    const info = app.loader.list().find((module) => module.file === file);
    assert.equal(info?.enabled, true);
    assert.match(
      info?.error ?? "",
      /Cannot find module|ERR_MODULE_NOT_FOUND|web\.client/i,
    );
    const guest = app.config.addUser("Error guest", "guest").user;
    const ownerInfo = (await app.extensions(owner(app))).modules.find(
      (module) => module.file === file,
    );
    const guestInfo = (await app.extensions(guest)).modules.find(
      (module) => module.file === file,
    );
    assert.ok(ownerInfo?.error);
    assert.equal(guestInfo?.error, "It failed to load.");
    const call = await http(t, app);
    assert.equal((await call()).status, 404);
  },
);

test(
  "only the owner can read status and authentication checks run first",
  { timeout: 20000 },
  async (t) => {
    const { app } = await fixture(t);
    await enable(app);
    const call = await http(t, app);
    assert.equal((await call()).status, 200);
    assert.equal((await call(statusPath, null)).status, 401);
    assert.equal(
      (await call(statusPath, app.config.ownerToken, false)).status,
      403,
    );
    for (const role of ["guest", "viewer"] as const) {
      const person = app.config.addUser(`Status ${role}`, role);
      const response = await call(statusPath, person.token);
      assert.equal(response.status, 404, role);
      assert.equal("processes" in response.data, false);
    }
    const scoped = app.config.addUser("Scoped guest", "guest", [
      String(await newSession(app)),
    ]);
    assert.equal((await call(statusPath, scoped.token)).status, 404);
  },
);

test(
  "status includes bounded process leaders and samples the temporary data filesystem",
  { timeout: 20000 },
  async (t) => {
    const { app, dataDir } = await fixture(t);
    await enable(app);
    const call = await http(t, app);
    let reading: any;
    await until(async () => {
      const response = await call();
      assert.equal(response.status, 200);
      reading = response.data;
      return (
        process.platform !== "linux" ||
        reading.processes.memory.length > 0 ||
        Boolean(reading.processes.error)
      );
    }, "the first process sample");
    assert.equal(typeof reading.host, "string");
    assert.ok(Number.isInteger(reading.cpus) && reading.cpus > 0);
    assert.ok(reading.memory.total > 0);
    assert.ok(Number.isFinite(reading.memory.freePercent));
    assert.equal(typeof reading.ready, "boolean");
    assert.equal(typeof reading.at, "number");
    assert.deepEqual(reading.waiting, []);
    assertResumeDelay(reading.resumeDelaySeconds);
    if (reading.diskSupported) assert.equal(reading.disk.path, dataDir);
    assert.deepEqual(
      reading.checks.map((check: { id: string }) => check.id),
      ["memory", "load", "io", "disk"],
    );
    const processes = reading.processes;
    assert.equal(processes.supported, process.platform === "linux");
    assert.equal(typeof processes.warming, "boolean");
    assert.equal(typeof processes.ioReadable, "boolean");
    assert.equal(processes.error, undefined, processes.error);
    for (const metric of ["cpu", "memory", "io"]) {
      const rows = processes[metric];
      assert.ok(Array.isArray(rows));
      assert.ok(rows.length <= 3);
      for (const [index, row] of rows.entries()) {
        assert.deepEqual(Object.keys(row).sort(), ["name", "pid", "value"]);
        assert.ok(Number.isInteger(row.pid) && row.pid > 0);
        assert.equal(typeof row.name, "string");
        assert.ok(Number.isFinite(row.value) && row.value >= 0);
        if (index > 0) assert.ok(rows[index - 1].value >= row.value);
      }
    }
  },
);

test(
  "disabled limits allow a normal tool call after the startup cooldown",
  { timeout: 45000 },
  async (t) => {
    const marker = "isolated-resource-queue-read";
    const input = join(root, "tool-input.txt");
    writeFileSync(input, marker);
    let results = 0;
    const model = scriptedModel((context) => {
      const last = lastText(context as never);
      if (last.role === "toolResult") {
        results++;
        return fauxAssistantMessage([fauxText(`Read result: ${last.text}`)]);
      }
      return fauxAssistantMessage([fauxToolCall("read", { path: input })], {
        stopReason: "toolUse",
      });
    });
    const { app } = await fixture(t, model);
    await enable(app);
    app.setExtensionSettings(owner(app), "resource-queue", disabledLimits);
    const call = await http(t, app);
    const before = (await call()).data;
    assert.deepEqual(before.limits, disabledLimits);
    assert.equal(before.ready, true);
    assertResumeDelay(before.resumeDelaySeconds);
    assert.ok(
      before.checks.every(
        (check: { enabled: boolean }) => check.enabled === false,
      ),
    );
    const id = await newSession(app);
    await loadTools(app, id, "read");
    await say(app, id, "Read the isolated input.");
    assert.equal(results, 1);
    assert.match(
      (await modelTexts(app, id)).at(-1) ?? "",
      /Read result:.*isolated-resource-queue-read/s,
    );
    const after = (await call()).data;
    assert.equal(after.ready, true);
    assert.deepEqual(after.waiting, []);
    assertResumeDelay(after.resumeDelaySeconds);
    assert.equal(
      app.sessions().length,
      1,
      "A normal tool call must not create a linked session.",
    );
  },
);

test(
  "settings updates change resume spacing in limits and countdown",
  { timeout: 20000 },
  async (t) => {
    const { app } = await fixture(t);
    await enable(app);
    app.setExtensionSettings(owner(app), "resource-queue", {
      ...disabledLimits,
      resumeSpacingSeconds: 7,
    });
    const call = await http(t, app);
    const updated = (await call()).data;
    assert.equal(updated.limits.resumeSpacingSeconds, 7);
    assert.equal(updated.resumeDelaySeconds, 7);
  },
);

test(
  "queue commands report and cancel only this conversation's queued work",
  { timeout: 30000 },
  async (t) => {
    // Control only the memory reading. The app, tool, task, and commands are real.
    const memory = t.mock.method(os, "freemem", () => 0);
    syncBuiltinESMExports();
    t.after(() => {
      memory.mock.restore();
      syncBuiltinESMExports();
    });
    let queueReply = "";
    let toolResults = 0;
    const title = "Isolated cancellation item";
    const model = scriptedModel((request) => {
      const last = lastText(request as never);
      if (last.role === "toolResult") {
        toolResults++;
        queueReply = last.text;
        return fauxAssistantMessage([fauxText(`Queue result: ${last.text}`)]);
      }
      return fauxAssistantMessage(
        [
          fauxToolCall("resource_queue_start", {
            title,
            message: "This cancelled item must not start a linked session.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    });
    const { app } = await fixture(t, model);
    await enable(app);
    app.setExtensionSettings(owner(app), "resource-queue", {
      ...disabledLimits,
      minFreeMemoryPercent: 95,
    });
    const call = await http(t, app);
    assert.equal((await call()).data.ready, false);
    const source = await newSession(app);
    const other = await newSession(app);
    const command = async (
      conversation: typeof source,
      name: string,
      args = "",
    ) => {
      const registered = app.webs.commands().find((item) => item.name === name);
      assert.ok(registered, `The command ${name} must be registered.`);
      const result = await app.extensionCommands.run(conversation, owner(app), {
        commandId: registered.id,
        args,
        requestId: crypto.randomUUID(),
      });
      assert.equal(result.status, "done");
      assert.equal(result.type, "card");
      assert.equal(typeof result.output, "string");
      return result.output as string;
    };
    assert.equal(
      await command(source, "resource-queue-status"),
      "No queued work in this conversation.",
    );
    await loadTools(app, source, "resource_queue_start");
    await say(app, source, "Queue the isolated work.");
    assert.equal(toolResults, 1);
    assert.match(queueReply, /WAITING FOR RESOURCES/);
    const item = /Queue item (\d+)\./.exec(queueReply)?.[1];
    assert.ok(item, "The tool must return the created queue item ID.");
    const waiting = `${item}: waiting — ${title}`;
    assert.equal(await command(source, "resource-queue-status"), waiting);
    assert.equal(
      await command(other, "resource-queue-status"),
      "No queued work in this conversation.",
    );
    assert.equal(
      await command(other, "resource-queue-cancel", item),
      "No such queue item in this conversation.",
    );
    assert.equal(await command(source, "resource-queue-status"), waiting);
    assert.equal(
      await command(source, "resource-queue-cancel", item),
      `Queue item ${item} is cancelled. No linked session will start for it.`,
    );
    assert.equal(
      await command(source, "resource-queue-status"),
      `${item}: cancelled — ${title}`,
    );
    // Release the resource block. The durable cancellation must still prevent a start.
    app.setExtensionSettings(owner(app), "resource-queue", disabledLimits);
    const readTask = () => app.harness.getTask(Number(item), context);
    await until(
      async () => {
        const task = await readTask();
        return task?.state.status === "terminal";
      },
      "the cancelled queue task to stop",
      15000,
    );
    const task = await readTask();
    assert.equal(task?.conversationId, source);
    assert.equal(task?.background, true);
    assert.deepEqual(task?.state.outcome, {
      status: "aborted",
      reason: "Queue item cancelled",
    });
    assert.equal(
      await command(source, "resource-queue-status"),
      `${item}: cancelled — ${title}`,
    );
    assert.equal(
      app.sessions().length,
      2,
      "The cancelled item must not create a linked session.",
    );
  },
);
