import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer, Stream } from "effect";
import {
	ConnectionConfigLive,
	TcpStream,
	TcpStreamLive,
	TcpStreamError,
} from "./tcp-connection.js";
import { frameLines } from "./line-framing.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const collectLines = (
	chunks: ReadonlyArray<Uint8Array>,
): Effect.Effect<ReadonlyArray<string>> =>
	Stream.fromIterable(chunks).pipe(frameLines, Stream.runCollect);

describe("frameLines", () => {
	it("reassembles a line fragmented across arbitrary chunk boundaries", async () => {
		const lines = await Effect.runPromise(
			collectLines([
				bytes("HE"),
				bytes("LL"),
				bytes("O|PET"),
				bytes("R4|12.3"),
				bytes("4\n"),
			]),
		);
		expect(lines).toEqual(["HELLO|PETR4|12.34"]);
	});

	it("emits multiple lines from a single chunk individually", async () => {
		const lines = await Effect.runPromise(
			collectLines([bytes("QUOTE|PETR4|10\nQUOTE|VALE3|20\n")]),
		);
		expect(lines).toEqual(["QUOTE|PETR4|10", "QUOTE|VALE3|20"]);
	});

	it("reassembles fragmented lines and batches mixed within one stream", async () => {
		const lines = await Effect.runPromise(
			collectLines([bytes("A|1\nB|"), bytes("2\nC|3\nD|"), bytes("4\n")]),
		);
		expect(lines).toEqual(["A|1", "B|2", "C|3", "D|4"]);
	});

	it("handles CRLF terminators, including CRLF split across chunks", async () => {
		const lines = await Effect.runPromise(
			collectLines([bytes("L1\r"), bytes("\nL2\r\nL3\r\n")]),
		);
		expect(lines).toEqual(["L1", "L2", "L3"]);
	});

	it("decodes multi-byte UTF-8 characters split across chunks", async () => {
		const lines = await Effect.runPromise(
			collectLines([
				Uint8Array.from([...bytes("QUOTE|VALE"), 0xc3]),
				Uint8Array.from([0xa7, ...bytes("3|20\n")]),
			]),
		);
		expect(lines).toEqual(["QUOTE|VALEç3|20"]);
	});

	it("treats a standalone CR as a line terminator", async () => {
		const lines = await Effect.runPromise(collectLines([bytes("A\rB\r")]));
		expect(lines).toEqual(["A", "B"]);
	});

	it("emits a trailing unterminated line when the stream completes", async () => {
		const lines = await Effect.runPromise(collectLines([bytes("A\nB\nC")]));
		expect(lines).toEqual(["A", "B", "C"]);
	});

	it("propagates TcpStreamError through the error channel", async () => {
		const error = new TcpStreamError({
			operation: "read",
			message: "Socket error",
		});
		const program = Effect.runPromiseExit(
			Stream.make(bytes("A\n")).pipe(
				Stream.concat(Stream.fail(error)),
				frameLines,
				Stream.runDrain,
			),
		);

		const exit = await program;
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(exit.cause.toString()).toContain("TcpStreamError");
		}
	});

	it("frames a live fragmented TCP stream through TcpStreamLive", async () => {
		const port = 59240;

		const server = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: {
				data(socket, data) {
					const text = new TextDecoder().decode(data);
					if (text === "READY\n") {
						socket.write("QUOTE|PETR4|1");
						setTimeout(() => {
							socket.write("0.5\nTRADE|PETR4|100\n");
							socket.write("HB\n");
							socket.end();
						}, 25);
					}
				},
			},
		});

		const tcpLayer = TcpStreamLive().pipe(
			Layer.provide(
				ConnectionConfigLive({
					host: "127.0.0.1",
					port,
					retry: false,
				}),
			),
		);

		const program = Effect.gen(function* () {
			const tcp = yield* TcpStream;
			yield* tcp.sendText("READY\n");
			return yield* tcp.stream.pipe(frameLines, Stream.runCollect);
		}).pipe(Effect.provide(tcpLayer));

		try {
			const lines = await Effect.runPromise(program);
			expect(lines).toEqual(["QUOTE|PETR4|10.5", "TRADE|PETR4|100", "HB"]);
		} finally {
			server.stop(true);
		}
	});
});
