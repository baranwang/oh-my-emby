import type { CollectionView } from "../core/collection-model.js";
import type { JsonValue } from "../core/model.js";
import type { Schema } from "effect";
import { EmbyItemDto } from "./emby-schemas.js";
import { isCatalogObject } from "../core/source-item-candidate.js";
type EmbyItemDtoValue = Schema.Schema.Type<typeof EmbyItemDto> & {
  readonly RecursiveItemCount?: number;
};

export const collectionsRootId = "collections:movies";
export const isCollectionsRoot = (id: string) => id === collectionsRootId;
export const isCollectionId = (id: string) => id.startsWith("collection:");
const object = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  isCatalogObject(value) ? value : {};
export const collectionsRootDto = (serverId: string, name = "合集") => ({
  Id: collectionsRootId,
  ServerId: serverId,
  Name: name,
  Type: "CollectionFolder",
  CollectionType: "boxsets",
  IsFolder: true,
});
export const collectionDto = (view: CollectionView, serverId: string): EmbyItemDtoValue => {
  const metadata = object(view.displayMetadata),
    external = object(metadata.ExternalImages),
    upstream = object(metadata.ImageTags);
  const name = typeof metadata.Name === "string" ? metadata.Name : "Collection";
  const revision =
    typeof metadata.ExternalArtworkRevision === "number"
      ? `-${metadata.ExternalArtworkRevision}`
      : "";
  const language =
    typeof metadata.ExternalArtworkLanguage === "string"
      ? `-${metadata.ExternalArtworkLanguage}`
      : "";
  const tag = `collection${revision}${language}`;
  const imageTags = Object.fromEntries(
    ["Primary", "Thumb", "Logo"].flatMap((type) =>
      typeof external[type] === "string" || typeof upstream[type] === "string" ? [[type, tag]] : [],
    ),
  );
  let backdrops: ReadonlyArray<JsonValue> = [];
  if (Array.isArray(external.Backdrop)) backdrops = external.Backdrop;
  else if (Array.isArray(metadata.BackdropImageTags)) backdrops = metadata.BackdropImageTags;
  return {
    Id: view.id,
    ServerId: serverId,
    Name: name,
    SortName: typeof metadata.SortName === "string" ? metadata.SortName : name,
    Type: "BoxSet",
    IsFolder: true,
    ParentId: collectionsRootId,
    ChildCount: view.childCount,
    RecursiveItemCount: view.childCount,
    ...(typeof metadata.Overview === "string" ? { Overview: metadata.Overview } : {}),
    ...(Object.keys(imageTags).length ? { ImageTags: imageTags } : {}),
    ...(backdrops.length ? { BackdropImageTags: backdrops.slice(0, 32).map(() => tag) } : {}),
    MediaSources: [],
    UserData: {
      ItemId: view.id,
      Played: false,
      IsFavorite: false,
      PlayCount: 0,
      PlaybackPositionTicks: 0,
    },
  };
};
