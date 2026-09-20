import { Schema } from "effect"

const StringList = Schema.Array(Schema.NonEmptyString)

export const EmbyUserDataDto = Schema.Struct({
  ItemId: Schema.NonEmptyString,
  Played: Schema.Boolean,
  IsFavorite: Schema.Boolean,
  PlayCount: Schema.Natural,
  PlaybackPositionTicks: Schema.Natural
})

export const EmbyMediaStreamDto = Schema.Struct({
  Index: Schema.optionalKey(Schema.Natural),
  Type: Schema.optionalKey(Schema.String),
  Codec: Schema.optionalKey(Schema.String),
  CodecTag: Schema.optionalKey(Schema.String),
  Language: Schema.optionalKey(Schema.String),
  DisplayTitle: Schema.optionalKey(Schema.String),
  Title: Schema.optionalKey(Schema.String),
  Profile: Schema.optionalKey(Schema.String),
  Level: Schema.optionalKey(Schema.Number),
  AspectRatio: Schema.optionalKey(Schema.String),
  PixelFormat: Schema.optionalKey(Schema.String),
  VideoRange: Schema.optionalKey(Schema.String),
  ChannelLayout: Schema.optionalKey(Schema.String),
  SampleRate: Schema.optionalKey(Schema.Number),
  Channels: Schema.optionalKey(Schema.Number),
  BitRate: Schema.optionalKey(Schema.Number),
  BitDepth: Schema.optionalKey(Schema.Number),
  Width: Schema.optionalKey(Schema.Number),
  Height: Schema.optionalKey(Schema.Number),
  AverageFrameRate: Schema.optionalKey(Schema.Number),
  RealFrameRate: Schema.optionalKey(Schema.Number),
  IsDefault: Schema.optionalKey(Schema.Boolean),
  IsForced: Schema.optionalKey(Schema.Boolean),
  IsExternal: Schema.optionalKey(Schema.Boolean),
  IsTextSubtitleStream: Schema.optionalKey(Schema.Boolean),
  IsInterlaced: Schema.optionalKey(Schema.Boolean),
  IsAVC: Schema.optionalKey(Schema.Boolean),
  IsAnamorphic: Schema.optionalKey(Schema.Boolean),
  SupportsExternalStream: Schema.optionalKey(Schema.Boolean)
})

export const EmbyMediaSourceDto = Schema.Struct({
  Id: Schema.NonEmptyString,
  Name: Schema.optionalKey(Schema.String),
  Protocol: Schema.optionalKey(Schema.String),
  Container: Schema.optionalKey(Schema.String),
  Size: Schema.optionalKey(Schema.Number),
  RunTimeTicks: Schema.optionalKey(Schema.Number),
  Bitrate: Schema.optionalKey(Schema.Number),
  VideoType: Schema.optionalKey(Schema.String),
  SupportsDirectPlay: Schema.optionalKey(Schema.Boolean),
  SupportsDirectStream: Schema.optionalKey(Schema.Boolean),
  SupportsTranscoding: Schema.optionalKey(Schema.Boolean),
  IsRemote: Schema.optionalKey(Schema.Boolean),
  MediaStreams: Schema.Array(EmbyMediaStreamDto)
})

export const EmbyItemDto = Schema.Struct({
  Id: Schema.NonEmptyString,
  Type: Schema.NonEmptyString,
  Name: Schema.optionalKey(Schema.String),
  OriginalTitle: Schema.optionalKey(Schema.String),
  SortName: Schema.optionalKey(Schema.String),
  Overview: Schema.optionalKey(Schema.String),
  ProductionYear: Schema.optionalKey(Schema.Number),
  PremiereDate: Schema.optionalKey(Schema.String),
  DateCreated: Schema.optionalKey(Schema.String),
  EndDate: Schema.optionalKey(Schema.String),
  CommunityRating: Schema.optionalKey(Schema.Number),
  CriticRating: Schema.optionalKey(Schema.Number),
  OfficialRating: Schema.optionalKey(Schema.String),
  RunTimeTicks: Schema.optionalKey(Schema.Number),
  IndexNumber: Schema.optionalKey(Schema.Number),
  ParentIndexNumber: Schema.optionalKey(Schema.Number),
  ChildCount: Schema.optionalKey(Schema.Number),
  IsFolder: Schema.optionalKey(Schema.Boolean),
  IsHD: Schema.optionalKey(Schema.Boolean),
  Genres: Schema.optionalKey(StringList),
  UserData: EmbyUserDataDto,
  MediaSources: Schema.Array(EmbyMediaSourceDto)
})

export const EmbyPlaybackInfoDto = Schema.Struct({
  PlaySessionId: Schema.NonEmptyString,
  MediaSources: Schema.Array(EmbyMediaSourceDto)
})

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
export type EmbyItemDto = typeof EmbyItemDto.Type
export type EmbyMediaSourceDto = typeof EmbyMediaSourceDto.Type
export type EmbyMediaStreamDto = typeof EmbyMediaStreamDto.Type
export type EmbyPlaybackInfoDto = typeof EmbyPlaybackInfoDto.Type
