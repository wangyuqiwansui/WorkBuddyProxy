const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const cacheDir = path.join(rootDir, ".cache", "electron-builder");
const builderCli = path.join(rootDir, "node_modules", "electron-builder", "cli.js");
const args = process.argv.slice(2);
const maxAttempts = 3;

function removeBuildScratch() {
  for (const name of ["win-unpacked.tmp", "win-unpacked"]) {
    fs.rmSync(path.join(distDir, name), { recursive: true, force: true });
  }
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  removeBuildScratch();

  const result = spawnSync(process.execPath, [builderCli, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: cacheDir,
    },
    encoding: "utf8",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status === 0) {
    process.exit(0);
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const canRetry =
    attempt < maxAttempts &&
    (output.includes("EPERM: operation not permitted") ||
      output.includes("ERR_ELECTRON_BUILDER_CANNOT_EXECUTE"));

  if (!canRetry) {
    process.exit(result.status || 1);
  }

  console.warn(`electron-builder failed with a transient Windows file access error; retrying (${attempt + 1}/${maxAttempts})...`);
  wait(1500 * attempt);
}

process.exit(1);
