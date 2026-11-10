# Resource queue for Pi Pocket

An MIT-licensed community extension for Pi Pocket. It monitors system capacity, holds Pi's tool calls under resource pressure, and queues linked work sessions. It is not an official Pi Pocket product.

## Requirements and installation

Requires Pi Pocket **0.27.0 or newer** and extension API **2**. Linux provides the full process and I/O monitor. Other platforms omit unsupported metrics.

Copy `resource-queue.ts` and the complete `resource-queue/` folder into Pi Pocket's data directory under `extensions/`. Enable **Resource queue** in **Menu → Extensions**. Never copy test files or repository development dependencies into the extension directory.

Open **Resource monitor** from the rail. Its dot shows green for ready, red for a resource limit exceeded, yellow for staggered recovery, and gray when status is unavailable or loading. The tooltip explains the state.

## What it does

- Samples free RAM, 1-minute load per CPU, Linux I/O wait, and free space on Pi Pocket's data filesystem every 5 seconds.
- Shows top-3 processes for CPU, resident memory, and disk read/write throughput. Rates are approximate. Exited processes and inaccessible counters may be omitted.
- Holds tool calls across sessions before execution while an enabled resource check fails. It never interrupts an already running process or model generation.
- Exempts `resource_queue_start` so Pi can still enqueue work during resource pressure.
- Rechecks resources before releasing work. Waiting tools and queued linked-session starts share a recovery admission limit: starts are at least 15 seconds apart, not necessarily non-overlapping.
- Shows chat notices and a persistent status-line indication for held tool calls. Stop cancels a waiting tool call.
- Starts queued work through Pi Pocket's linked-session API. Queue items use durable tasks and idempotent enqueue receipts.
- Provides `/resource-queue-status` to inspect this conversation's queue and outcomes, and `/resource-queue-cancel <id>` to cancel an item before its start is claimed. Stop does **not** cancel an already-enqueued background item. These commands require permission to steer the conversation.

The monitor page and its routes are owner-only. Session notices go only to tabs of the affected conversation.

### Reloads and restarts

The admission clock is transient scheduling state shared by overlapping reload generations through Node's cached helper module. A fresh process applies a full 15-second startup cooldown. Reload disposal aborts old hook waits rather than leaving invisible timers. Interrupted tool calls may need a retry. Durable queue tasks and receipts survive restart. Helper-code updates require a server restart, as Pi Pocket's gallery indicates.

The 15-second rule applies to **admission times**, not linked-session completion times. A linked start already admitted before reload can finish afterward. Queue cancellation is accepted only while an item is `waiting`; it cannot undo a session whose start was already claimed.

## Settings

Change settings in **Menu → Extensions → Resource queue**. Changes apply to later checks. Set a resource threshold to **0** to disable that check.

| Setting                                         | Default | Range |
| ----------------------------------------------- | ------: | ----: |
| Minimum free memory (%)                         |      20 |  0–95 |
| Maximum 1-minute load per CPU                   |    0.75 |  0–16 |
| Maximum I/O wait (%)                            |      15 | 0–100 |
| Minimum free data-disk space (%)                |      10 |  0–95 |
| Resource-check interval while waiting (seconds) |      20 | 5–600 |

CPU load is an average, not instantaneous CPU utilization. It can remain high after activity decreases. Enabled, supported I/O and disk checks wait for their initial measurements after load or reload. If the OS cannot report a metric, the monitor marks it unavailable and does not block on that metric. Read failures also use this fail-open policy; this is a capacity aid, not a hard resource isolation boundary. Bad settings use defaults or clamp to their supported range.

## Data access and security

This extension runs with Pi Pocket server privileges, as all server drop-ins do.

- Reads Linux `/proc/stat`, `/proc/<pid>/stat`, `/proc/<pid>/status`, and `/proc/<pid>/io`, plus the numeric PID directory listing under `/proc`.
- Reads operating-system CPU, memory, hostname, load, and uptime information through Node's `os` module.
- Reads filesystem capacity metadata for `host.dataDir` through `statfs`. It does not read user file contents.
- Displays process names and PIDs to the owner. Process names can themselves contain sensitive text. Command-line arguments and environment variables are not collected.
- Does not read tokens, provider credentials, Pi Pocket configuration files, or unrelated session transcripts.
- Makes no external network requests, installs no packages at runtime, and starts no OS subprocesses.
- Sends monitor information only to Pi Pocket's own authenticated browser interface.
- Stores queue receipts in `x.resource-queue.receipts`, per-conversation queue outcomes and cancellation markers in `x.resource-queue.items`, and queue tasks in `x.resource-queue.start` using Pi Durable.
- Does not bypass Lancet Guard, approvals, or other hooks. It delays execution rather than granting permission.

The extension uses experimental Pi Pocket APIs: linked sessions, status-line items, conversation navigation listeners, and extension settings. Its rail-dot CSS uses the public `rail-button` theme part and the extension's own tooltip prefix.

## Development

Use Node 24 or a supported Node release with native TypeScript stripping. Install development dependencies with `npm ci`. A Pi Pocket v0.27.0 checkout with dependencies is required for integration tests and the `Host`/`Web` type definitions. Link `_pocket.d.ts` to that checkout's `types/pocket.d.ts`. Development package installs must never use a `node_modules` symlink into a running server. See `CLAUDE.md` for local setup.

Run cheap checks before integration tests:

```sh
npm run check
npm test
npm run format:check
POCKET_SOURCE=/path/to/pi-pocket npm run test:integration
```

Tests must use temporary data, never the owner's running server. The gallery's validator must also load the pinned extension in its isolated test app before submission.

## Gallery publication

Publish this repository with its license. Submit `entries/resource-queue.json` to [TannerMidd/pi-pocket-extensions](https://github.com/TannerMidd/pi-pocket-extensions), pinning a full commit ID and exact file sizes and SHA-256 hashes. Generate the entry after committing:

```sh
node scripts/gallery-entry.ts "$(git rev-parse HEAD)" > /path/to/gallery/entries/resource-queue.json
```

Run the gallery's `scripts/validate.ts` against both the local files and the published commit before submitting. Do not edit the gallery's generated `index.json`. Owners review and apply updates themselves.
