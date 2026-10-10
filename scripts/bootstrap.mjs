import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const registry = "https://registry.npmjs.org";

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd || root, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal || code})`));
    });
  });
}

await run("npm", ["install", "--workspaces=false", "--ignore-scripts", `--registry=${registry}`], { cwd: root });
await chmod(join(root, "src", "cli.mjs"), 0o755);
await chmod(join(root, "scripts", "cws.py"), 0o755);
await run("npm", ["link"], { cwd: root });

console.log("masaka bootstrap complete.");
console.log("Run: masaka doctor");
console.log('Enable native Codex switching: eval "$(masaka shell-init)"');
console.log("Then run: masaka");
