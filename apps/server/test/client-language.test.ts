import { expect, it } from "vitest";
import { clientLanguage } from "../src/core/client-language.js";

it.each([
  [null, "en-US"],
  ["", "en-US"],
  ["zh-CN, en;q=0.8", "zh-CN"],
  ["en;q=0.2, ja-JP;q=0.9", "ja-JP"],
  ["zh-Hant, en;q=0.5", "zh-TW"],
  ["de-DE", "de-DE"],
  ["sh", "sr-RS"],
  ["fil-PH", "tl-PH"],
  ["tl-PH", "tl-PH"],
  ["yue-HK", "zh-HK"],
  ["fr;q=0, en;q=0.5", "en-US"],
  ["invalid_!;q=1, ko;q=0.8", "ko-KR"],
  ["zh-CN;q=oops, fr-FR;q=0.8", "fr-FR"],
  ["*", "en-US"],
  ["en-GB-u-ca-gregory", "en-GB"],
  ["eo", "eo"],
  ["zh-CN;q=0;q=1, ja;q=0.8", "ja-JP"],
  ["en;q=1.5", "en-US"],
] as const)("resolves Accept-Language %s to %s", (header, expected) => {
  expect(clientLanguage(header)).toBe(expected);
});
