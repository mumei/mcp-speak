import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = join(directory, entry.name);
    return entry.isDirectory() ? files(name) : name.endsWith(".js") ? [name] : [];
  });
}
for (const name of ["index.js", "test.js", ...files("src"), ...files("test"), ...files("scripts")]) {
  const result = spawnSync(process.execPath, ["--check", name], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
