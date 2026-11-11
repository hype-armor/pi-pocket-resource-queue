// Resource monitor page. It uses Pi Pocket's own components, colors, and controls.
export const pocketApi = 1;

const GAUGE = "M4 18a8 8 0 1116 0M12 18l4-6";
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const clamp = (value, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));
const ERROR = "Could not read system resources.";

function uptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days
    ? `${days}d ${hours}h`
    : hours
      ? `${hours}h ${minutes}m`
      : `${minutes}m`;
}

export default function setup(pocket) {
  const { html, useEffect, useState, Loader } = pocket;

  pocket.style("resource-queue.css");
  pocket.style("processes.css");
  pocket.style("rail-status.css");
  pocket.toolCall({
    tool: "resource_queue_start",
    iconPath: GAUGE,
    label: () => "queue linked work",
    subject: (args) => {
      const title = typeof args.title === "string" ? args.title : "";
      const firstLine =
        typeof args.message === "string" ? args.message.split("\n", 1)[0] : "";
      return (title || firstLine).slice(0, 120);
    },
  });

  function ResourceIcon({ kind }) {
    const paths = {
      memory: html`<rect x="5" y="7" width="14" height="10" rx="2" />
        <path
          d="M8 10h2v4H8zm6 0h2v4h-2zM8 4v3m4-3v3m4-3v3m-8 10v3m4-3v3m4-3v3M2 10h3m14 0h3M2 14h3m14 0h3"
        />`,
      cpu: html`<rect x="7" y="7" width="10" height="10" rx="2" />
        <path d="M9 2v5m6-5v5m-6 10v5m6-5v5M2 9h5m-5 6h5m10-6h5m-5 6h5" />`,
      io: html`<path d="M4 8h11m-4-4 4 4-4 4M20 16H9m4-4-4 4 4 4" />`,
      disk: html`<ellipse cx="12" cy="6" rx="7.5" ry="3.5" />
        <path
          d="M4.5 6v12c0 1.9 3.4 3.5 7.5 3.5s7.5-1.6 7.5-3.5V6M4.5 12c0 1.9 3.4 3.5 7.5 3.5s7.5-1.6 7.5-3.5"
        />`,
    };
    return html`<svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      ${paths[kind] ?? paths.disk}
    </svg>`;
  }

  function Meter({ value, level, label }) {
    return html`<div
      class="rq-meter"
      role="meter"
      aria-label=${label}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${Math.round(value)}
      aria-valuetext=${label}
    >
      <div
        class="rq-meter__fill"
        data-level=${level}
        style=${{ width: `${clamp(value)}%` }}
      ></div>
    </div>`;
  }

  function Metric({
    icon,
    title,
    value,
    description,
    meter,
    meterLabel,
    level,
    footLeft,
    footRight,
  }) {
    return html`<article class="rq-metric" data-level=${level}>
      <div class="rq-metric__top">
        <span class="rq-icon"><${ResourceIcon} kind=${icon} /></span>
        <span class="rq-metric__label">${title}</span>
      </div>
      <div class="rq-metric__value">${value}</div>
      <div class="rq-metric__description">${description}</div>
      <${Meter} value=${meter} level=${level} label=${meterLabel} />
      <div class="rq-metric__foot">
        <span>${footLeft}</span><span>${footRight}</span>
      </div>
    </article>`;
  }

  function ProcessLeaders({ processes }) {
    const bytes = (value) =>
      value >= 1024 ** 3
        ? `${(value / 1024 ** 3).toFixed(1)} GiB`
        : value >= 1024 ** 2
          ? `${(value / 1024 ** 2).toFixed(1)} MiB`
          : value >= 1024
            ? `${(value / 1024).toFixed(1)} KiB`
            : `${Math.round(value)} B`;
    const groups = [
      {
        id: "cpu",
        title: "CPU",
        format: (value) => `${value.toFixed(1)}%`,
        note: "100% = one CPU core",
      },
      {
        id: "memory",
        title: "RAM",
        format: bytes,
        note: "Resident memory (RSS)",
      },
      {
        id: "io",
        title: "Disk I/O",
        format: (value) => `${bytes(value)}/s`,
        note: "Disk reads + writes; only accessible counters. Excludes network I/O.",
      },
    ];
    return html`<section class="rq-details" aria-label="Top processes">
      <div class="rq-details__heading">Top 3 processes by resource</div>
      <p class="small muted">
        Sampled about every 5 seconds. Rates are approximate. Command arguments
        are not collected. Exited or inaccessible processes may be omitted.
      </p>
      ${!processes
        ? html`<p class="muted">Process usage is not available yet.</p>`
        : !processes.supported
          ? html`<p class="muted">Process usage is available on Linux only.</p>`
          : processes.error
            ? html`<p class="error-box">${processes.error}</p>`
            : html`<div class="rq-process-grid">
                ${groups.map(
                  (group) =>
                    html`<article class="rq-process-group">
                      <h2>${group.title}</h2>
                      <p class="small muted">${group.note}</p>
                      ${processes[group.id].length
                        ? html`<ol class="rq-process-list">
                            ${processes[group.id].map(
                              (row) =>
                                html`<li key=${row.pid}>
                                  <span
                                    class="rq-process-name"
                                    title=${row.name}
                                    >${row.name}<small
                                      >PID ${row.pid}</small
                                    ></span
                                  >
                                  <strong class="mono"
                                    >${group.format(row.value)}</strong
                                  >
                                </li>`,
                            )}
                          </ol>`
                        : html`<p class="small muted">
                            ${group.id === "io" && !processes.ioReadable
                              ? "I/O counters are not accessible."
                              : processes.warming
                                ? "Measuring first interval…"
                                : "No process usage available."}
                          </p>`}
                    </article>`,
                )}
              </div>`}
    </section>`;
  }

  function ResourceMonitor() {
    const [reading, setReading] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    const refresh = async () => {
      setBusy(true);
      try {
        setReading(await pocket.api("status"));
        setError(null);
      } catch (failure) {
        setError(failure.message || ERROR);
      } finally {
        setBusy(false);
      }
    };

    useEffect(() => {
      const controller = new AbortController();
      let active = true;
      pocket.api("status", undefined, { signal: controller.signal }).then(
        (result) => {
          if (active) {
            setReading(result);
            setError(null);
          }
        },
        (failure) => {
          if (active && !controller.signal.aborted)
            setError(failure.message || ERROR);
        },
      );
      const stop = pocket.on("status", (result) => {
        setReading(result);
        setError(null);
      });
      return () => {
        active = false;
        controller.abort();
        stop();
      };
    }, []);

    if (error && !reading) {
      return html`<div class="rq-page">
        <div class="error-box">${error}</div>
        <button class="button" onClick=${refresh}>Try again</button>
      </div>`;
    }
    if (!reading)
      return html`<div class="rq-page">
        <${Loader} label="Reading system resources" />
      </div>`;

    const { limits, checks } = reading;
    const check = (id) => checks.find((item) => item.id === id);
    const off = "Off";
    const ioKnown = reading.ioWaitSupported && reading.ioWaitPercent !== null;
    const ioWait = ioKnown ? reading.ioWaitPercent : 0;
    const diskKnown = reading.diskSupported && reading.disk !== undefined;
    const diskFree = diskKnown ? reading.disk.freePercent : 0;
    const memoryFree = reading.memory.freePercent;

    const levelFor = (id, ok) => {
      const item = check(id);
      if (!item || !item.enabled) return "muted";
      return ok ? "good" : "warn";
    };

    const blocking = checks
      .filter((item) => item.enabled && !item.ok)
      .map((item) => item.reason);
    const summary = reading.ready
      ? "No measured resource limits are exceeded."
      : `Pi's tool calls and queued starts wait while ${blocking.join(" and ")}.`;

    const metrics = [
      {
        icon: "memory",
        title: "Free memory",
        value: `${memoryFree.toFixed(0)}%`,
        description: `${gib(reading.memory.free)} free of ${gib(reading.memory.total)}`,
        meter: memoryFree,
        meterLabel: `${memoryFree.toFixed(1)} percent memory free`,
        level: levelFor("memory", check("memory")?.ok),
        footLeft: "Available",
        footRight:
          limits.minFreeMemoryPercent > 0
            ? `Minimum ${limits.minFreeMemoryPercent}%`
            : off,
      },
      {
        icon: "cpu",
        title: "CPU load / core",
        value: reading.loadPerCpu.toFixed(2),
        description: `1-minute load across ${reading.cpus} CPU${reading.cpus === 1 ? "" : "s"}`,
        meter:
          limits.maxLoadPerCpu > 0
            ? (reading.loadPerCpu / limits.maxLoadPerCpu) * 100
            : 0,
        meterLabel: `${reading.loadPerCpu.toFixed(2)} load per CPU; limit ${limits.maxLoadPerCpu}`,
        level: levelFor("load", check("load")?.ok),
        footLeft: "Current load",
        footRight:
          limits.maxLoadPerCpu > 0 ? `Limit ${limits.maxLoadPerCpu}` : off,
      },
      {
        icon: "io",
        title: "I/O wait",
        value: ioKnown ? `${ioWait.toFixed(1)}%` : "—",
        description: ioKnown
          ? "CPU time waiting for I/O"
          : reading.ioWaitSupported
            ? "Measuring first sample"
            : "Not reported by this OS",
        meter:
          limits.maxIoWaitPercent > 0
            ? (ioWait / limits.maxIoWaitPercent) * 100
            : 0,
        meterLabel: ioKnown
          ? `${ioWait.toFixed(1)} percent I/O wait; limit ${limits.maxIoWaitPercent} percent`
          : "I/O wait is not available yet",
        level: ioKnown ? levelFor("io", check("io")?.ok) : "muted",
        footLeft: "5-second sample",
        footRight: !reading.ioWaitSupported
          ? "Not available"
          : limits.maxIoWaitPercent > 0
            ? `Limit ${limits.maxIoWaitPercent}%`
            : off,
      },
      {
        icon: "disk",
        title: "Data disk free",
        value: diskKnown ? `${diskFree.toFixed(0)}%` : "—",
        description: diskKnown
          ? `${gib(reading.disk.free)} free of ${gib(reading.disk.total)}`
          : reading.diskSupported
            ? "Measuring Pi Pocket data filesystem"
            : "Not available",
        meter: diskKnown ? diskFree : 0,
        meterLabel: diskKnown
          ? `${diskFree.toFixed(1)} percent data-disk space free`
          : "Data-disk capacity is not available yet",
        level: diskKnown ? levelFor("disk", check("disk")?.ok) : "muted",
        footLeft: "Pi Pocket data path",
        footRight: !reading.diskSupported
          ? "Not available"
          : limits.minFreeDiskPercent > 0
            ? `Minimum ${limits.minFreeDiskPercent}%`
            : off,
      },
    ];

    return html`<main class="rq-page">
      <header class="rq-header">
        <div>
          <div class="rq-eyebrow">System health</div>
          <h1 class="rq-title">Resource monitor</h1>
          <p class="rq-subtitle">Live capacity for starting more work.</p>
        </div>
        <button
          class="button"
          disabled=${busy}
          onClick=${refresh}
          aria-label="Refresh resource readings"
        >
          ${busy ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <section
        class="rq-status"
        data-state=${reading.ready ? "ready" : "waiting"}
        aria-live="polite"
      >
        <span class="rq-status__icon" aria-hidden="true"
          >${reading.ready ? "✓" : "…"}</span
        >
        <div class="rq-status__copy">
          <div class="rq-status__label">
            ${reading.ready ? "Capacity available" : "Work is paused"}
          </div>
          <div class="rq-status__detail">${summary}</div>
        </div>
        <span class="rq-status__tag"
          >${reading.ready ? "Ready" : "Waiting"}</span
        >
      </section>

      <section class="rq-metrics" aria-label="Resource readings">
        ${metrics.map((metric) => html`<${Metric} ...${metric} />`)}
      </section>

      <${ProcessLeaders} processes=${reading.processes} />

      <section class="rq-details" aria-label="System details">
        <div class="rq-details__heading">System details</div>
        <div class="rq-details__grid">
          <div class="rq-detail">
            <span>Host</span><strong class="mono">${reading.host}</strong>
          </div>
          <div class="rq-detail">
            <span>Load averages</span
            ><strong class="mono"
              >${reading.load.map((n) => n.toFixed(2)).join(" · ")}</strong
            >
          </div>
          ${diskKnown
            ? html`<div class="rq-detail">
                <span>Data filesystem</span
                ><strong class="mono">${reading.disk.path}</strong>
              </div>`
            : null}
          <div class="rq-detail">
            <span>Uptime</span><strong>${uptime(reading.uptime)}</strong>
          </div>
          <div class="rq-detail">
            <span>Last sample</span
            ><strong>${new Date(reading.at).toLocaleTimeString()}</strong>
          </div>
        </div>
      </section>

      <footer class="rq-note">
        <span class="rq-note__mark" aria-hidden="true">i</span>
        <p>
          Change these limits in
          <strong>Menu → Extensions → Resource queue</strong>. A limit of 0
          turns its check off. Waiting tool calls check resources every
          ${limits.pollSeconds} seconds. Waiting tools and queued sessions share
          one recovery slot: starts are at least
          ${limits.resumeSpacingSeconds ?? 15} seconds apart.
        </p>
      </footer>
      ${error ? html`<div class="error-box">${error}</div>` : null}
    </main>`;
  }

  pocket.page({
    id: "monitor",
    title: "Resource monitor",
    component: ResourceMonitor,
  });
  const rail = pocket.rail({
    id: "monitor",
    title: "Resource monitor — loading status",
    badge: null,
    iconPath: GAUGE,
    page: "monitor",
  });
  pocket.launcher({
    id: "monitor",
    label: "Resource monitor",
    detail: "CPU, memory, I/O wait, disk space, queued work",
    iconPath: GAUGE,
    page: "monitor",
  });

  {
    const renderStatus = (reading) => {
      const paused = (reading.waiting ?? []).find(
        (item) => item.conversationId === pocket.conversationId?.(),
      );
      if (paused) {
        const reasons = reading.checks
          .filter((item) => item.enabled && !item.ok)
          .map((item) => item.reason);
        const why =
          reasons.join("; ") ||
          `staggered recovery (one start every ${reading.limits.resumeSpacingSeconds ?? 15}s)`;
        return {
          text: `⏸ PAUSED — ${why}`,
          short: "⏸ PAUSED: resources",
          title: `${paused.count} tool call(s) waiting: ${why}. Resource checks every ${reading.limits.pollSeconds}s. Starts are at least ${reading.limits.resumeSpacingSeconds ?? 15}s apart; next slot in about ${reading.resumeDelaySeconds ?? 0}s. Resumes automatically; Stop cancels. Tap to open the resource monitor.`,
          tone: "warn",
        };
      }
      const io =
        reading.ioWaitSupported && reading.ioWaitPercent !== null
          ? ` · I/O ${reading.ioWaitPercent.toFixed(1)}%`
          : "";
      const disk = reading.disk ? ` · ${gib(reading.disk.free)} disk free` : "";
      return {
        text: `load ${reading.loadPerCpu.toFixed(2)}${io} · ${gib(reading.memory.free)} mem${disk}`,
        short: `load ${reading.loadPerCpu.toFixed(2)}`,
        title: `${reading.host}: ${reading.memory.freePercent.toFixed(1)}% memory free; load per CPU ${reading.loadPerCpu.toFixed(2)}${io}${reading.disk ? `; ${reading.disk.freePercent.toFixed(1)}% data disk free` : ""}`,
        tone: reading.ready ? undefined : "warn",
      };
    };
    const item =
      typeof pocket.status === "function"
        ? pocket.status({
            id: "resources",
            text: "resources …",
            page: "monitor",
          })
        : null;
    let latest;
    const update = (reading) => {
      latest = reading;
      item?.update(renderStatus(reading));
      const recovering = reading.ready && (reading.waiting ?? []).length > 0;
      const state = !reading.ready
        ? "Paused"
        : recovering
          ? "Recovery"
          : "Ready";
      const reasons = (reading.checks ?? [])
        .filter((check) => check.enabled && !check.ok)
        .map((check) => check.reason);
      rail.update({
        badge: null,
        title: `Resource monitor — ${state}${reasons.length ? `: ${reasons.join("; ")}` : recovering ? `: waiting starts are spaced ${reading.limits?.resumeSpacingSeconds ?? 15} seconds apart` : ": capacity available"}`,
      });
    };
    pocket
      .api("status")
      .then(update)
      .catch(() => {
        if (!latest)
          rail.update({
            badge: null,
            title: "Resource monitor — status unavailable",
          });
      });
    pocket.on("status", update);
    pocket.onConversation?.(() => {
      if (latest) item?.update(renderStatus(latest));
    });
  }
}
