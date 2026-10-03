import { describe, expect, it } from "vitest";
import { artworkLanguage, selectArtworkPath } from "../src/core/tmdb-artwork.js";

describe("TMDB artwork language fallback", () => {
  const images = [
    { file_path: "/neutral.png", iso_639_1: null },
    { file_path: "/original.jpg", iso_639_1: "ja" },
    { file_path: "/chinese.webp", iso_639_1: "zh" },
  ];
  it("uses the preferred language before original and neutral artwork", () => {
    expect(selectArtworkPath(images, "zh", "ja")).toBe("/chinese.webp");
    expect(selectArtworkPath(images, "fr", "ja")).toBe("/original.jpg");
    expect(selectArtworkPath(images, "fr", "ko")).toBe("/neutral.png");
  });
  it("falls back to usable artwork and rejects external URLs and unsupported formats", () => {
    expect(
      selectArtworkPath(
        [
          { file_path: "https://other.example/poster.png", iso_639_1: "zh" },
          { file_path: "/logo.svg", iso_639_1: "zh" },
          { file_path: "/fallback.jpg", iso_639_1: "es" },
        ],
        "zh",
        "ja",
      ),
    ).toBe("/fallback.jpg");
    expect(
      selectArtworkPath([{ file_path: "/bad.png", iso_639_1: 42 }], "zh", undefined),
    ).toBeUndefined();
    expect(selectArtworkPath(null, "zh", "ja")).toBeUndefined();
  });
  it("resolves original and metadata preferences and normalizes regional language codes", () => {
    expect(artworkLanguage("metadata", "zh-HK", "ja")).toBe("zh");
    expect(artworkLanguage("original", "zh-CN", "ja")).toBe("ja");
    expect(artworkLanguage("original", "zh-CN", undefined)).toBe("zh");
    expect(artworkLanguage("en-US", "zh-CN", "ja")).toBe("en");
  });
});
