import { Schema } from "effect";

export class ScidFileNotFoundError extends Schema.TaggedError<ScidFileNotFoundError>()(
	"ScidFileNotFoundError",
	{
		filePath: Schema.String,
		message: Schema.String,
	},
) {}

export class InvalidScidHeaderError extends Schema.TaggedError<InvalidScidHeaderError>()(
	"InvalidScidHeaderError",
	{
		filePath: Schema.String,
		reason: Schema.String,
	},
) {}

export class ScidReadCorruptedError extends Schema.TaggedError<ScidReadCorruptedError>()(
	"ScidReadCorruptedError",
	{
		filePath: Schema.String,
		offset: Schema.Number,
		reason: Schema.String,
	},
) {}

export type ScidReaderError =
	| ScidFileNotFoundError
	| InvalidScidHeaderError
	| ScidReadCorruptedError;
