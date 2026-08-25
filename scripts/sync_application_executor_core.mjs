import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "application_executor", "shared_core.js");
const targetPath = path.join(root, "extensions", "application_assistant", "executor_core.js");
const source = await readFile(sourcePath, "utf8");
await writeFile(targetPath, source, "utf8");
console.log("Synced the Application Executor shared core into the Chrome extension bundle.");
