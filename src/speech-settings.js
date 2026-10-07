import { validateObject, validateSpeak } from "./speech.js";

export const DEFAULT_SETTINGS = { voice: null, rate: 175 };

export function validateSettings(args) {
  validateObject(args, ["voice", "rate"]);
  if (!Object.hasOwn(args, "voice") || !Object.hasOwn(args, "rate")) throw new Error("音声と速度を指定してください");
  const input = validateSpeak({ text: "設定確認", voice: args.voice === null ? undefined : args.voice, rate: args.rate });
  return { voice: input.voice ?? null, rate: input.rate };
}

export function parseVoices(raw) {
  return raw.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z]{2})\s+#\s?(.*)$/u);
    return match ? [{ name: match[1].trim(), language: match[2], sample: match[3] }] : [];
  });
}
