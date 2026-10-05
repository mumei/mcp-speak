import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAY = "/usr/bin/say";

export function validateSpeak(args) {
  validateObject(args, ["text", "voice", "rate"]);
  if (typeof args.text !== "string" || args.text.trim().length === 0) {
    throw new Error("textには空白だけではない文字列を指定してください");
  }
  if (args.voice !== undefined &&
      (typeof args.voice !== "string" || args.voice.trim().length === 0)) {
    throw new Error("voiceには空白だけではない文字列を指定してください");
  }
  const rate = args.rate === undefined ? 175 : args.rate;
  if (!Number.isInteger(rate) || rate < 1 || rate > 500) {
    throw new Error("rateには1〜500の整数を指定してください");
  }
  return { text: args.text, voice: args.voice, rate };
}

export function validateObject(args, allowedKeys) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("引数にはオブジェクトを指定してください");
  }
  if (Object.keys(args).some((key) => !allowedKeys.includes(key))) {
    throw new Error("未対応の引数が指定されています");
  }
}

export function createSpeech({
  spawnProcess = spawn,
  executeFile = execFileAsync,
  log = (message) => console.error(message),
} = {}) {
  const children = new Set();

  return {
    async speak(args) {
      const { text, voice, rate } = validateSpeak(args);
      const options = ["-r", String(rate)];
      if (voice !== undefined) options.push("-v", voice);

      await new Promise((resolve, reject) => {
        // Text travels through stdin, so leading '-' can never become an option.
        const child = spawnProcess(SAY, options, {
          stdio: ["pipe", "ignore", "pipe"],
          shell: false,
        });
        children.add(child);
        let stderr = "";
        let accepted = false;
        let failed = false;
        const fail = (error) => {
          if (failed) return;
          failed = true;
          child.kill();
          const message = `sayコマンドの実行に失敗しました: ${error.message}`;
          if (accepted) log(message);
          else reject(new Error(message));
        };
        child.stderr.on("data", (data) => {
          stderr = (stderr + data.toString()).slice(-8192);
        });
        child.on("error", fail);
        child.stdin.on("error", fail);
        child.once("spawn", () => {
          child.stdin.end(text, "utf8", (error) => {
            if (error) {
              fail(error);
              return;
            }
            if (!failed) {
              accepted = true;
              resolve();
            }
          });
        });
        child.once("close", (code, signal) => {
          children.delete(child);
          if (code === 0 && !accepted && !failed) {
            reject(new Error("テキストの送信前にsayコマンドが終了しました"));
          }
          if (code !== 0) {
            const message = `sayコマンドが終了しました (code: ${code}, signal: ${signal}): ${stderr.trim()}`;
            if (accepted) log(message);
            else if (!failed) reject(new Error(message));
          }
        });
      });
      return { text, voice, rate };
    },

    async listVoices() {
      const { stdout } = await executeFile(SAY, ["-v", "?"], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      });
      return stdout;
    },

    stop() {
      for (const child of children) child.kill();
    },
  };
}
