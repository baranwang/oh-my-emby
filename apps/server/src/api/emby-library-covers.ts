import type { LibraryCoverSummary } from "@oh-my-emby/contracts";
export const libraryCoverImageFields = (cover?: LibraryCoverSummary) =>
  cover ? { ImageTags: { Primary: cover.revision }, PrimaryImageAspectRatio: 16 / 9 } : {};
