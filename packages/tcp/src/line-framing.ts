import { Stream } from "effect";

/**
 * Transforms a raw byte stream into a stream of individual text lines.
 *
 * Handles:
 * - Multi-packet reassembly: partial lines split across chunks are buffered
 *   until a full line delimiter arrives.
 * - Batched emission: multiple lines received in a single chunk are emitted
 *   individually.
 * - Line delimiters: \n, \r\n, and \r are all supported (via `Stream.splitLines`).
 *
 * Empty lines (blank lines between delimiters) are preserved in the output.
 */
export const frameLines = <E>(
	raw: Stream.Stream<Uint8Array, E>,
): Stream.Stream<string, E> => raw.pipe(Stream.decodeText, Stream.splitLines);
