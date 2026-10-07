import test from "node:test";
import assert from "node:assert/strict";
import { parseVoices, validateSettings } from "../src/speech-settings.js";

test("Mac voice rows preserve full names and ignore malformed rows", () => {
  assert.deepEqual(parseVoices("Kyoko                ja_JP    # こんにちは。\nEddy (English (US)) en_US # Hello!\nmalformed\n"), [
    { name: "Kyoko", language: "ja_JP", sample: "こんにちは。" },
    { name: "Eddy (English (US))", language: "en_US", sample: "Hello!" },
  ]);
});

test("shared settings validate explicit system voice, full names and integer rates", () => {
  assert.deepEqual(validateSettings({ voice: null, rate: 175 }), { voice: null, rate: 175 });
  for (const rate of [1, 500]) assert.deepEqual(validateSettings({ voice: "Eddy (English (US))", rate }), { voice: "Eddy (English (US))", rate });
  for (const args of [{ voice: null }, { rate: 175 }, { voice: null, rate: 0 }, { voice: null, rate: 501 }, { voice: null, rate: 1.2 }, { voice: "", rate: 175 }, { voice: [], rate: 175 }, { voice: null, rate: "175" }, { voice: null, rate: 175, text: "extra" }]) assert.throws(() => validateSettings(args));
});
