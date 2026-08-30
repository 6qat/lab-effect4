import { describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import { frameLines } from "./line-framing.js";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

const collectLines = (
	raw: Stream.Stream<Uint8Array>,
): Promise<ReadonlyArray<string>> =>
	Effect.runPromise(Stream.runCollect(frameLines(raw)));

describe("frameLines", () => {
	it("emits individual lines from a single chunk containing multiple lines", async () => {
		const result = await collectLines(
			Stream.make(encode("line1\nline2\nline3\n")),
		);
		expect(result).toEqual(["line1", "line2", "line3"]);
	});

	it("reassembles a single line split across two TCP chunks", async () => {
		const result = await collectLines(
			Stream.make(encode("hel"), encode("lo\n")),
		);
		expect(result).toEqual(["hello"]);
	});

	it("reassembles lines fragmented across three TCP chunks", async () => {
		const result = await collectLines(
			Stream.make(encode("line1\nli"), encode("ne2\nline"), encode("3\n")),
		);
		expect(result).toEqual(["line1", "line2", "line3"]);
	});

	it("handles byte-at-a-time fragmentation", async () => {
		const result = await collectLines(
			Stream.fromIterable(Array.from("AB\n").map((ch) => encode(ch))),
		);
		expect(result).toEqual(["AB"]);
	});

	it("reassembles when the newline delimiter arrives in a separate chunk", async () => {
		const result = await collectLines(
			Stream.make(encode("complete-line"), encode("\n")),
		);
		expect(result).toEqual(["complete-line"]);
	});

	it("handles \\r\\n (CRLF) line endings", async () => {
		const result = await collectLines(Stream.make(encode("alpha\r\nbeta\r\n")));
		expect(result).toEqual(["alpha", "beta"]);
	});

	it("handles \\r (CR) line endings", async () => {
		const result = await collectLines(Stream.make(encode("one\rtwo\r")));
		expect(result).toEqual(["one", "two"]);
	});

	it("handles mixed line endings within a single chunk", async () => {
		const result = await collectLines(Stream.make(encode("a\nb\r\nc\rd\n")));
		expect(result).toEqual(["a", "b", "c", "d"]);
	});

	it("handles \\r\\n split across two chunks", async () => {
		const result = await collectLines(
			Stream.make(encode("hello\r"), encode("\nworld\n")),
		);
		expect(result).toEqual(["hello", "world"]);
	});

	it("emits nothing for an empty stream", async () => {
		const result = await collectLines(
			Stream.empty as Stream.Stream<Uint8Array, never>,
		);
		expect(result).toEqual([]);
	});

	it("preserves empty lines between consecutive delimiters", async () => {
		const result = await collectLines(Stream.make(encode("a\n\nb\n")));
		expect(result).toEqual(["a", "", "b"]);
	});

	it("emits trailing content without a final newline when the stream ends", async () => {
		const result = await collectLines(
			Stream.make(encode("no-trailing-newline")),
		);
		expect(result).toEqual(["no-trailing-newline"]);
	});

	it("frames Cedro pipe-delimited protocol messages arriving in a single packet", async () => {
		const result = await collectLines(
			Stream.make(encode("AUTH|OK\nQUOTE|PETR4|28.50|100\nHEARTBEAT\n")),
		);
		expect(result).toEqual(["AUTH|OK", "QUOTE|PETR4|28.50|100", "HEARTBEAT"]);
	});

	it("frames Cedro messages split across multiple TCP packets", async () => {
		const result = await collectLines(
			Stream.make(
				encode("AUTH|O"),
				encode("K\nQUOTE|PE"),
				encode("TR4|28.50|100\n"),
				encode("HEARTBEAT\n"),
			),
		);
		expect(result).toEqual(["AUTH|OK", "QUOTE|PETR4|28.50|100", "HEARTBEAT"]);
	});
});
