import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
if (!manifest.id || !/^[a-z0-9-]+$/.test(manifest.id)) throw new Error("Invalid plugin ID");
const destination = path.join(root, "dist", manifest.id);
await mkdir(destination, { recursive: true });
for (const name of ["main.js", "manifest.json", "styles.css"])
  await copyFile(path.join(root, name), path.join(destination, name));
console.log(`Plugin files: ${destination}`);
