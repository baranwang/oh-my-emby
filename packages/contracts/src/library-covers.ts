import { Schema } from 'effect';
export const LibraryCoverSummary = Schema.Struct({revision:Schema.NonEmptyString,width:Schema.Literals([1920]),height:Schema.Literals([1080]),stale:Schema.Boolean});
export type LibraryCoverSummary = typeof LibraryCoverSummary.Type;
export const LibraryCoverPreparation = Schema.Struct({token:Schema.NonEmptyString,title:Schema.String,subtitle:Schema.String,templateVersion:Schema.NonEmptyString,expiresAtMs:Schema.Number,candidates:Schema.Array(Schema.Struct({index:Schema.Number,url:Schema.NonEmptyString}))});
export type LibraryCoverPreparation = typeof LibraryCoverPreparation.Type;
