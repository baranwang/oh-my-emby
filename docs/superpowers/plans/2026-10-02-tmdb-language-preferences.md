# TMDB Language Preferences Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement the tasks in this session.

**Goal:** Provide the three TMDB language selectors shown in the user's screenshots and apply them to metadata, logos, and posters.

**Architecture:** Keep the existing nullable metadata language and add optional artwork and system language settings. Persist additions in a separate migrated table so legacy clients and settings remain compatible. Select TMDB artwork by requested language and retain safe upstream fallback.

**Tech Stack:** Effect, Bun SQLite, Workers D1, React Form, existing shadcn Select, Paraglide.

**Spec:** User screenshots and in-chat design: metadata default follows Dashboard language; artwork defaults to original language, with an additional follow-metadata choice. Languages: zh-CN, zh-TW, zh-HK, zh-SG, es-ES, en-US, ar-SA, ja-JP, ko-KR, ru-RU, fr-FR.

## Global Constraints

- Preserve credentials, existing language values, provider ordering, and old API inputs.
- Do not manually edit components/ui; compose its existing Select.
- Keep TMDB ID priority and IMDb fallback, validated image URLs, provider deadlines, and upstream fallback.

## Review Focus

- Old settings and omitted new fields must survive updates and provider reordering.
- Original and follow-metadata artwork choices must produce different results when languages differ.
- TMDB image languages identify a language rather than Chinese regional variants.
- Provider failure and missing localized artwork must retain usable fallback.
- Language changes must invalidate cached artwork and preserve credentials.

### Task 1: Persist language preferences

- [x] Add failing contract/settings tests for artwork languages, saved defaults, and legacy field preservation.
- [x] Add optional language fields to contracts; migrate metadata_artwork_settings; implement Bun/D1 persistence and metadata settings merging.
- [x] Verify metadata settings and repository tests, including migration round trip.

### Task 2: Resolve localized TMDB artwork

- [x] Add failing provider tests for original, specified and follow-metadata languages, logos, missing artwork and request failures.
- [x] Fetch validated TMDB details and image variants, select preferred/original/neutral fallback, expose Logo through cache and Emby image routes.
- [x] Verify provider, playback, and Emby catalog tests; verify actual TMDB request behavior.

### Task 3: Render and validate selectors

- [x] Add dashboard tests for three selectors, language options, save payloads, and preservation during reorder.
- [x] Replace the text field with business components built from Select; localize labels; synchronize system-default language when Dashboard language changes.
- [x] Run tests, typecheck and build sequentially; lint; inspect UI; request review; commit and push the authorized branch.

## Verification

- Full suite: 642 passing tests (25 contracts, 121 Dashboard, 496 server).
- Workers/D1: 64 passing, 1 intentionally skipped; new fields tested in shared repository round trip and rollback.
- Typecheck, production build, lint and diff whitespace check passed.
- Real TMDB movie and series details/images returned 200; preferred, original and metadata language selection yielded usable posters/logos.
- Browser verified all three Chinese selectors and the screenshot language ordering.
- Review caught and fixed Workers migration bookkeeping and system-default initialization; final review passed.

**Initialization refinement:** After settings load, align system-default TMDB language with the current Dashboard locale; disable locale changes while settings are unavailable. This closes the existing-Chinese-locale gap without changing explicit TMDB metadata language.
