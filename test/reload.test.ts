import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const candidate = resolve(import.meta.dirname, "..");
const pocketSource = resolve(
  process.env.POCKET_SOURCE ?? join(candidate, "..", "pocket-test-source"),
);
// The helpers isolate agent configuration before app modules load.
const { cleanUp, context, newSession, openApp, owner, root, scriptedModel } =
  await import(pathToFileURL(join(pocketSource, "test", "helpers.ts")).href);
const { createHandler } = await import(
  pathToFileURL(join(pocketSource, "src", "server", "http.ts")).href
);

after(cleanUp);

test(
  "real root reload preserves reservations across overlapping module lifetimes",
  { timeout: 20000 },
  async (t) => {
    const memory = t.mock.method(os, "freemem", () => 0);
    syncBuiltinESMExports();
    t.after(() => {
      memory.mock.restore();
      syncBuiltinESMExports();
    });
    const file = "resource-queue.ts";
    const dataDir = mkdtempSync(join(root, "resource-queue-reload-"));
    const extensions = join(dataDir, "extensions");
    mkdirSync(extensions, { recursive: true });
    copyFileSync(join(candidate, file), join(extensions, file));
    cpSync(
      join(candidate, "resource-queue"),
      join(extensions, "resource-queue"),
      {
        recursive: true,
      },
    );

    // Import the installed helper, not the repository helper. Seed its public
    // clock injection before the real loader sets up the first generation.
    const { createResumeGate } = await import(
      pathToFileURL(join(extensions, "resource-queue", "lib", "resume-gate.ts"))
        .href
    );
    let now = 0;
    const oldGate = createResumeGate(() => now, dataDir);
    const app = await openApp(scriptedModel(), dataDir);
    t.after(() => app.close());
    await app.setExtensionEnabled(owner(app), file, true);
    app.setExtensionSettings(owner(app), "resource-queue", {
      minFreeMemoryPercent: 95,
      maxLoadPerCpu: 0,
      maxIoWaitPercent: 0,
      minFreeDiskPercent: 0,
      pollSeconds: 5,
    });

    const server = createServer(
      createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const status = async () => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/x/resource-queue/status`,
        {
          headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(response.status, 200);
      return response.json();
    };

    // Use the loader's returned definition to keep a real old-generation hook
    // alive. No module source, loader internals, or host services are patched.
    const first = await app.loader.reload(file);
    const previous = first.find(
      (extension) => extension.name === "resource-queue",
    );
    assert.ok(previous);
    const beforeTool = previous.hooks?.[0].handlers.beforeTool;
    assert.equal(typeof beforeTool, "function");
    const conversationId = await newSession(app);

    now = 15_000;
    assert.equal(oldGate.acquire(true), true);
    now = 20_000;
    assert.equal((await status()).resumeDelaySeconds, 10);
    const waiting = Promise.resolve(
      beforeTool!(
        { name: "read", arguments: {} } as any,
        { conversationId } as any,
        context,
      ),
    );
    // Attach rejection handling before the reload can abort the hook.
    const interrupted = assert.rejects(waiting, /reloaded|interrupted/i);
    t.after(() => interrupted);
    assert.deepEqual((await status()).waiting, [{ conversationId, count: 1 }]);

    const reloading = app.loader.reload(file);
    // Reload has started, but asynchronous import has not yet disposed the old
    // generation. Reserve through its retained gate while its hook still waits.
    now = 30_000;
    assert.equal(oldGate.acquire(true), true);
    // Distinguish the retained deadline from a fresh 15-second cooldown in the
    // replacement factory. Both would report 15 if time stayed at reservation.
    now = 32_000;
    const second = await reloading;
    await interrupted;
    const replacement = second.find(
      (extension) => extension.name === "resource-queue",
    );
    assert.ok(replacement);
    assert.notEqual(replacement.hooks?.[0].handlers.beforeTool, beforeTool);
    assert.equal(
      app.loader.list().find((module) => module.file === file)?.error,
      undefined,
    );

    app.setExtensionSettings(owner(app), "resource-queue", {
      minFreeMemoryPercent: 0,
      maxLoadPerCpu: 0,
      maxIoWaitPercent: 0,
      minFreeDiskPercent: 0,
      pollSeconds: 5,
      resumeSpacingSeconds: 15,
    });
    const reading = await status();
    assert.equal(reading.resumeDelaySeconds, 13);
    assert.deepEqual(reading.waiting, []);
    assert.equal(reading.ready, true);
    now = 35_000;
    assert.equal(oldGate.acquire(true), false);
    assert.equal((await status()).resumeDelaySeconds, 10);
    now = 45_000;
    assert.equal(oldGate.acquire(true), true);
    assert.equal((await status()).resumeDelaySeconds, 15);
  },
);
