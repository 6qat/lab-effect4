import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect, Layer, Redacted, Stream } from "effect";
import {
	CedroClient,
	CedroClientLive,
	CedroConfigLive,
} from "./cedro-protocol.js";
import { TcpStreamLive } from "./tcp-connection.js";

/** Send the login sequence immediately, then consume server text until disconnect. */
export const receiveCedroCommands = <E, R>(
	onLine: (line: string) => Effect.Effect<void, E, R>,
) =>
	Effect.gen(function* () {
		const client = yield* CedroClient;
		yield* client.authenticate();
		yield* Stream.runForEach(client.lines, onLine);
	});

export const main = Effect.gen(function* () {
	const host = yield* Config.string("CEDRO_HOST");
	const port = yield* Config.int("CEDRO_PORT");
	const magicToken = yield* Config.redacted("CEDRO_MAGIC_KEY");
	const username = yield* Config.string("CEDRO_USER");
	const password = yield* Config.redacted("CEDRO_PASSWORD");
	const cedroLayer = CedroClientLive.pipe(
		Layer.provide(
			Layer.merge(
				TcpStreamLive({ host, port, retry: false }),
				CedroConfigLive({
					magicToken: Redacted.value(magicToken),
					username,
					password: Redacted.value(password),
				}),
			),
		),
	);
	return yield* receiveCedroCommands((line) => Console.log(line)).pipe(
		Effect.provide(cedroLayer),
	);
});

if (import.meta.main) {
	BunRuntime.runMain(main);
}
