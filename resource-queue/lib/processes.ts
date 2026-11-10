import { readFile, readdir } from "node:fs/promises";
import { cpus } from "node:os";

export type ProcessRow = { pid: number; name: string; value: number };
type ProcessSample = {
  pid: number;
  name: string;
  start: string;
  ticks: number;
  rssBytes: number | null;
  ioBytes: number | null;
};
export type ProcessLeaders = {
  supported: boolean;
  warming: boolean;
  cpu: ProcessRow[];
  memory: ProcessRow[];
  io: ProcessRow[];
  ioReadable: boolean;
  error?: string;
};

/** Read process names, not command lines, which can contain credentials. */
async function readProcess(pid: number): Promise<ProcessSample | null> {
  try {
    const base = `/proc/${pid}`;
    const stat = await readFile(`${base}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return null;
    const fields = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/);
    // fields[0] is Linux stat field 3 (state).
    const ticks = Number(fields[11]) + Number(fields[12]);
    const [status, io] = await Promise.all([
      readFile(`${base}/status`, "utf8").catch(() => ""),
      readFile(`${base}/io`, "utf8").catch(() => ""),
    ]);
    const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    const read = /^read_bytes:\s+(\d+)/m.exec(io);
    const write = /^write_bytes:\s+(\d+)/m.exec(io);
    if (!Number.isFinite(ticks) || !fields[19]) return null;
    return {
      pid,
      name: stat.slice(stat.indexOf("(") + 1, end),
      start: fields[19],
      ticks,
      rssBytes: rss ? Number(rss[1]) * 1024 : null,
      ioBytes: read && write ? Number(read[1]) + Number(write[1]) : null,
    };
  } catch {
    // Processes can exit during a sample, or deny access.
    return null;
  }
}

const top = (rows: ProcessRow[]) =>
  rows.sort((a, b) => b.value - a.value || a.pid - b.pid).slice(0, 3);

export function createProcessSampler() {
  let previous = new Map<number, ProcessSample>();
  let previousTotal: number | undefined;
  let previousTime: number | undefined;
  return async (): Promise<ProcessLeaders> => {
    const empty: ProcessLeaders = {
      supported: process.platform === "linux",
      warming: true,
      cpu: [],
      memory: [],
      io: [],
      ioReadable: false,
    };
    if (!empty.supported) return empty;
    try {
      const [names, stat] = await Promise.all([
        readdir("/proc"),
        readFile("/proc/stat", "utf8"),
      ]);
      const total = stat
        .split("\n")[0]
        .trim()
        .split(/\s+/)
        .slice(1, 9)
        .map(Number)
        .reduce((a, b) => a + b, 0);
      const now = performance.now();
      const pids = names.filter((name) => /^\d+$/.test(name)).map(Number);
      const current = new Map<number, ProcessSample>();
      let index = 0;
      // Bound concurrent /proc reads on busy hosts.
      await Promise.all(
        Array.from({ length: Math.min(8, pids.length) }, async () => {
          while (index < pids.length) {
            const row = await readProcess(pids[index++]);
            if (row) current.set(row.pid, row);
          }
        }),
      );
      const cpu: ProcessRow[] = [],
        memory: ProcessRow[] = [],
        io: ProcessRow[] = [];
      const totalDelta =
        previousTotal === undefined ? 0 : total - previousTotal;
      const seconds =
        previousTime === undefined ? 0 : (now - previousTime) / 1000;
      let ioReadable = false;
      const cores = Math.max(1, cpus().length);
      for (const row of current.values()) {
        if (row.rssBytes !== null)
          memory.push({ pid: row.pid, name: row.name, value: row.rssBytes });
        if (row.ioBytes !== null) ioReadable = true;
        const old = previous.get(row.pid);
        if (!old || old.start !== row.start) continue; // PID reuse, or a new process.
        if (totalDelta > 0 && row.ticks >= old.ticks)
          cpu.push({
            pid: row.pid,
            name: row.name,
            value: ((row.ticks - old.ticks) / totalDelta) * cores * 100,
          });
        if (
          seconds > 0 &&
          row.ioBytes !== null &&
          old.ioBytes !== null &&
          row.ioBytes >= old.ioBytes
        )
          io.push({
            pid: row.pid,
            name: row.name,
            value: (row.ioBytes - old.ioBytes) / seconds,
          });
      }
      const warming = previousTime === undefined;
      previous = current;
      previousTime = now;
      previousTotal = total;
      return {
        supported: true,
        warming,
        cpu: top(cpu),
        memory: top(memory),
        io: top(io),
        ioReadable,
      };
    } catch {
      return { ...empty, error: "Could not read process usage from /proc." };
    }
  };
}
