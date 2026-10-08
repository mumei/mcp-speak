import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { settingsStore } from "../src/settings-store.js";
import { queueConfig } from "../src/queue-config.js";
import { homedir } from "node:os";
import path from "node:path";

test("default settings use persistent user storage and custom queues stay isolated", () => {
  const keys = ["MCP_SPEAK_QUEUE_DIR", "MCP_SPEAK_SETTINGS_DIR"];
  const old = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(queueConfig().settingsDirectory, path.join(homedir(), "Library", "Application Support", "mcp-speak"));
    process.env.MCP_SPEAK_QUEUE_DIR = "/tmp/isolated-queue";
    assert.equal(queueConfig().settingsDirectory, "/tmp/isolated-queue");
    process.env.MCP_SPEAK_SETTINGS_DIR = "/tmp/separate-settings";
    assert.equal(queueConfig().settingsDirectory, "/tmp/separate-settings");
  } finally { keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; }); }
});

test("legacy settings migrate once and survive removal of temporary queue data", async t => {
  const root = await fs.mkdtemp("/tmp/mcp-speak-settings-test-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { directory: `${root}/queue`, settingsDirectory: `${root}/persistent` };
  await fs.mkdir(config.directory, { mode: 0o700 });
  await fs.writeFile(`${config.directory}/speech-settings.json`, JSON.stringify({ voice: "Kyoko", rate: 220 }), { mode: 0o600 });
  const store = settingsStore(config);
  assert.deepEqual(store.settings, { voice: "Kyoko", rate: 220 });
  store.save({ voice: "Otoya", rate: 245 });
  assert.deepEqual(settingsStore(config).settings, { voice: "Otoya", rate: 245 });
  await fs.rm(config.directory, { recursive: true });
  assert.deepEqual(settingsStore(config).settings, { voice: "Otoya", rate: 245 });
  assert.equal((await fs.stat(`${config.settingsDirectory}/speech-settings.json`)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(config.settingsDirectory), ["speech-settings.json"]);
});

test("failed, corrupt and unsafe settings writes retain the saved data", async t => {
  const root = await fs.mkdtemp("/tmp/mcp-speak-settings-test-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = settingsStore({ directory: root });
  const file = `${root}/speech-settings.json`;
  store.save({ voice: "Kyoko", rate: 220 });
  assert.throws(() => store.save({ voice: null, rate: 501 }), /1〜500/);
  assert.deepEqual(settingsStore({ directory: root }).settings, { voice: "Kyoko", rate: 220 });
  await fs.writeFile(file, "broken JSON");
  assert.throws(() => store.save({ voice: null, rate: 175 }));
  assert.equal(await fs.readFile(file, "utf8"), "broken JSON");
  await fs.unlink(file);
  await fs.symlink(`${root}/other`, file);
  assert.throws(() => store.save({ voice: null, rate: 175 }), { code: "ELOOP" });
  await fs.unlink(file);
  await fs.mkdir(file);
  assert.throws(() => store.save({ voice: null, rate: 175 }), /権限・サイズ/);
  assert.deepEqual(await fs.readdir(root), ["speech-settings.json"]);
});
