import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const commit = process.argv[2];
if (!commit || !/^[a-f0-9]{40}$/.test(commit))
  throw new Error("Usage: node scripts/gallery-entry.ts <full-commit-id>");
const source = await readFile(new URL("resource-queue.ts", root), "utf8");
const description = source
  .match(/^\/\*\*\s*([\s\S]*?)\*\//)?.[1]
  .replace(/\s*\n\s*\*?\s*/g, " ")
  .trim();
const names = ["resource-queue.ts"];
async function walk(directory: string) {
  for (const entry of await readdir(new URL(`${directory}/`, root), {
    withFileTypes: true,
  })) {
    const name = join(directory, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile()) names.push(name);
    else throw new Error(`Unsupported entry: ${name}`);
  }
}
await walk("resource-queue");
const files = await Promise.all(
  names.sort().map(async (name) => {
    const bytes = await readFile(new URL(name, root));
    return {
      name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }),
);
const entry = {
  name: "resource-queue",
  title: "Resource queue",
  description,
  tags: ["resources", "monitoring", "queue", "linux"],
  author: { name: "hype-armor", github: "hype-armor" },
  version: "1.0.0",
  source: { repo: "hype-armor/pi-pocket-resource-queue", commit },
  files,
  pocketApi: 2,
  minPocket: "0.27.0",
  declares: {
    extensions: ["resource-queue"],
    tools: ["resource_queue_start"],
    readOnlyTools: [],
    hooks: ["beforeTool"],
    sections: ["resource-queue-guidance"],
    wraps: [],
    routes: ["GET status"],
    client: "owner",
    access: "owner",
    commands: [
      "conversation resource-queue-status",
      "conversation resource-queue-cancel",
    ],
  },
};
console.log(JSON.stringify(entry, null, 4));
