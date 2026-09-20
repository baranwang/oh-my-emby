import { Schema } from "effect"

const StringList = Schema.Array(Schema.NonEmptyString)

export const EmbyLoginBody = Schema.Struct({
  Username: Schema.NonEmptyString,
  Pw: Schema.NonEmptyString
})

export const EmbyClient = Schema.Struct({
  Device: Schema.NonEmptyString,
  DeviceId: Schema.NonEmptyString
})

export const EmbyItemsQuery = Schema.Struct({
  ParentId: Schema.NonEmptyString,
  StartIndex: Schema.optionalKey(Schema.Natural),
  Limit: Schema.optionalKey(Schema.Natural),
  SearchTerm: Schema.optionalKey(Schema.NonEmptyString),
  SortBy: Schema.optionalKey(StringList),
  SortOrder: Schema.optionalKey(Schema.Array(Schema.Literals(["Ascending", "Descending"]))),
  Fields: Schema.optionalKey(StringList),
  Filters: Schema.optionalKey(Schema.Array(Schema.Literals([
    "IsFavorite",
    "IsPlayed",
    "IsUnplayed",
    "IsResumable"
  ]))),
  IncludeItemTypes: Schema.optionalKey(Schema.Array(Schema.Literals([
    "Movie",
    "Series",
    "Season",
    "Episode"
  ])))
})

export const EmbyUserDataPatch = Schema.Struct({
  Played: Schema.optionalKey(Schema.Boolean),
  IsFavorite: Schema.optionalKey(Schema.Boolean),
  PlayCount: Schema.optionalKey(Schema.Natural),
  PlaybackPositionTicks: Schema.optionalKey(Schema.Natural),
  LastPlayedVersionId: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString))
})

export const EmbyPlaybackEvent = Schema.Struct({
  ItemId: Schema.NonEmptyString,
  MediaSourceId: Schema.NonEmptyString,
  PlaySessionId: Schema.NonEmptyString,
  PositionTicks: Schema.optionalKey(Schema.Natural)
})

export type EmbyItemsQuery = typeof EmbyItemsQuery.Type
export type EmbyUserDataPatch = typeof EmbyUserDataPatch.Type
export type EmbyPlaybackEvent = typeof EmbyPlaybackEvent.Type
