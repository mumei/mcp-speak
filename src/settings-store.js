import { constants, openSync, closeSync, readFileSync, writeFileSync, fstatSync, lstatSync, mkdirSync, renameSync, linkSync, unlinkSync, fsyncSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, validateSettings } from "./speech-settings.js";

function readSettings(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error("音声設定ファイルの権限・サイズが不正です");
    return validateSettings(JSON.parse(readFileSync(fd, "utf8")));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function settingsStore(config) {
  const directory = config.settingsDirectory || config.directory;
  if (!path.isAbsolute(directory)) throw new Error("音声設定のディレクトリが不正です");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("音声設定のディレクトリは自分が所有する権限700の実ディレクトリにしてください");
  const file = path.join(directory, "speech-settings.json");
  function write(settings, initial = false) {
    const next = validateSettings(settings);
    // Refuse to replace damaged or unsafe existing settings.
    readSettings(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (initial) linkSync(temporary, file); else renameSync(temporary, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return next;
  }
  let settings = readSettings(file);
  if (!settings && directory !== config.directory) {
    const legacy = readSettings(path.join(config.directory, "speech-settings.json"));
    if (legacy) {
      try { write(legacy, true); } catch (error) { if (error.code !== "EEXIST") throw error; }
      settings = readSettings(file);
    }
  }
  return { settings: settings || { ...DEFAULT_SETTINGS }, save: write };
}
