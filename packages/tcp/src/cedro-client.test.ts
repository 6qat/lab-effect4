import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer, Stream } from "effect";
import { receiveCedroCommands } from "./cedro-client.js";
import {
	CedroClient,
	CedroClientLive,
	CedroConfigLive,
} from "./cedro-protocol.js";
import { TcpStream, TcpStreamLive } from "./tcp-connection.js";

const credentials = {
	magicToken: "magic-key",
	username: "test-user",
	password: "test-password",
};

describe("Cedro client", () => {
	it("sends the login fields immediately, then receives server lines until disconnect", async () => {
		let received = "";
		let replied = false;
		const expectedLogin = "magic-key\ntest-user\ntest-password\n";
		const lines: string[] = [];
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					received += new TextDecoder().decode(data);
					if (!replied && received.split("\n").length >= 4) {
						replied = true;
						// Arbitrary server text, not an assumed authentication response.
						socket.end("SERVER MESSAGE\nCOMMAND|one\nCOMMAND|two\n");
					}
				},
			},
		});
		const layer = CedroClientLive.pipe(
			Layer.provide(
				Layer.merge(
					TcpStreamLive({ host: "127.0.0.1", port: server.port, retry: false }),
					CedroConfigLive(credentials),
				),
			),
		);
		try {
			await Effect.runPromise(
				receiveCedroCommands((line) =>
					Effect.sync(() => {
						lines.push(line);
					}),
				).pipe(Effect.provide(layer), Effect.timeout("2 seconds")),
			);
			expect(received).toBe(expectedLogin);
			expect(lines).toEqual(["SERVER MESSAGE", "COMMAND|one", "COMMAND|two"]);
		} finally {
			server.stop(true);
		}
	});

	for (const field of ["magicToken", "username", "password"] as const) {
		for (const separator of ["\n", "\r"]) {
			it(`rejects ${field} containing ${JSON.stringify(separator)} before sending anything`, async () => {
				const sent: string[] = [];
				const layer = CedroClientLive.pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(TcpStream, {
								stream: Stream.empty,
								send: () => Effect.void,
								sendText: (text) =>
									Effect.sync(() => {
										sent.push(text);
									}),
								close: Effect.void,
							}),
							CedroConfigLive({
								...credentials,
								[field]: `invalid${separator}value`,
							}),
						),
					),
				);
				const exit = await Effect.runPromiseExit(
					Effect.gen(function* () {
						const client = yield* CedroClient;
						yield* client.authenticate();
					}).pipe(Effect.provide(layer)),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					expect(exit.cause.toString()).toContain("CedroProtocolError");
				}
				expect(sent).toEqual([]);
			});
		}
	}
});
