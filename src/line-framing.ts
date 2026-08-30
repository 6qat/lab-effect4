import { Stream } from "effect";

export const frameLines = <E, R>(
	bytes: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<string, E, R> =>
	bytes.pipe(Stream.decodeText, Stream.splitLines);
