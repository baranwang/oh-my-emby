import { Context } from "effect";

export const ClientLanguage = Context.Reference<string>("oh-my-emby/ClientLanguage", {
  defaultValue: () => "en-US",
});

/** Resolve the client's highest-priority valid ISO language to a TMDB locale. */
export const clientLanguage = (header: string | null): string => {
  if (!header || header.length > 4096) return "en-US";
  const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
  const preferences = header
    .split(",")
    .slice(0, 32)
    .flatMap((entry, order) => {
      const [tag, ...parameters] = entry.trim().split(";");
      if (parameters.length > 1 || !tag || !/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i.test(tag)) return [];
      // TMDB uses two-letter ISO language codes; retain common client aliases.
      const base = tag.split("-")[0]!.toLowerCase();
      if (base.length === 3 && base !== "fil" && base !== "yue") return [];
      let weight = 1;
      for (const parameter of parameters) {
        const match = /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(parameter.trim());
        if (!match) return [];
        weight = Number(match[1]);
      }
      if (weight === 0) return [];
      try {
        const locale = new Intl.Locale(tag.replace(/^sh(?=-|$)/i, "sr")).maximize();
        if (!names.of(locale.language)) return [];
        const aliases: Readonly<Record<string, string>> = { fil: "tl", yue: "zh" };
        const language = aliases[locale.language] ?? locale.language;
        if (!/^[a-z]{2}$/.test(language)) return [];
        return [
          {
            language:
              locale.region && /^[A-Z]{2}$/.test(locale.region)
                ? `${language}-${locale.region}`
                : language,
            weight,
            order,
          },
        ];
      } catch {
        return [];
      }
    });
  preferences.sort((left, right) => right.weight - left.weight || left.order - right.order);
  return preferences[0]?.language ?? "en-US";
};
