const languageCode = (value: string) => value.split("-")[0]!.toLowerCase();

export const artworkLanguage = (
  preference: string | undefined,
  metadataLanguage: string,
  originalLanguage: string | undefined,
) => {
  let selected = preference;
  if (preference === "metadata") selected = metadataLanguage;
  if (preference === undefined || preference === "original")
    selected = originalLanguage ?? metadataLanguage;
  return languageCode(selected!);
};

export const selectArtworkPath = (
  value: unknown,
  preferredLanguage: string,
  originalLanguage: string | undefined,
): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  const images = value.filter(
    (entry): entry is { file_path: string; iso_639_1: string | null } =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.file_path === "string" &&
      /^\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp)$/i.test(entry.file_path) &&
      (entry.iso_639_1 === null || typeof entry.iso_639_1 === "string"),
  );
  for (const language of [preferredLanguage, originalLanguage, null]) {
    if (language === undefined) continue;
    const matched = images.find((image) => image.iso_639_1 === language);
    if (matched) return matched.file_path;
  }
  return images[0]?.file_path;
};
