import { BunRuntime } from "@effect/platform-bun";
import {
	Config,
	Console,
	Data,
	Deferred,
	type Duration,
	Effect,
	Fiber,
	Layer,
	Redacted,
	type Scope,
	Stream,
} from "effect";
import {
	CedroClient,
	CedroClientLive,
	CedroConfigLive,
	CedroProtocolError,
	isCedroAuthRejection,
} from "./cedro-protocol.js";
import { type TcpStreamError, TcpStreamLive } from "./tcp-connection.js";

export class CedroAuthTimeoutError extends Data.TaggedError(
	"CedroAuthTimeoutError",
)<{
	readonly message: string;
}> {}

export class CedroAuthRejectionError extends Data.TaggedError(
	"CedroAuthRejectionError",
)<{
	readonly message: string;
	readonly line: string;
}> {}

export interface CedroSessionOptions {
	readonly tickers?: ReadonlyArray<string>;
	readonly authTimeout?: Duration.Input;
	readonly isAuthRejection?: (line: string) => boolean;
}

/** Send the login sequence immediately, then consume server text until disconnect. */
export const receiveCedroCommands = <E, R>(
	onLine: (line: string) => Effect.Effect<void, E, R>,
) =>
	Effect.gen(function* () {
		const client = yield* CedroClient;
		yield* client.authenticate();
		yield* Stream.runForEach(client.lines, onLine);
	});

/**
 * Runs a single authenticated Cedro session.
 * Transmits login fields immediately, delivers incoming server lines, awaits authentication
 * confirmation ("You are connected") within authTimeout, sends trade subscriptions upon confirmation,
 * and preserves all lines arriving before, with, or after confirmation.
 */
export const runCedroSession = <E = never, R = never>(
	onLine: (line: string) => Effect.Effect<void, E, R>,
	options?: CedroSessionOptions,
): Effect.Effect<
	void,
	| TcpStreamError
	| CedroProtocolError
	| CedroAuthTimeoutError
	| CedroAuthRejectionError
	| E,
	CedroClient | Scope.Scope | R
> =>
	Effect.gen(function* () {
		const client = yield* CedroClient;
		const tickers = options?.tickers ?? ["WINV26", "PETR4"];
		const authTimeout = options?.authTimeout ?? "15 seconds";
		const isAuthRejectionFn = options?.isAuthRejection ?? isCedroAuthRejection;

		const authDeferred = yield* Deferred.make<
			void,
			CedroAuthRejectionError | CedroProtocolError
		>();

		// 1. Transmit credentials immediately
		yield* client.authenticate();

		// 2. Fork consumer fiber for lines
		const lineConsumerFiber = yield* Stream.runForEach(client.lines, (line) =>
			Effect.gen(function* () {
				const isDone = yield* Deferred.isDone(authDeferred);
				if (!isDone) {
					if (line.trim() === "You are connected") {
						yield* Deferred.succeed(authDeferred, void 0);
					} else if (isAuthRejectionFn(line)) {
						yield* Deferred.fail(
							authDeferred,
							new CedroAuthRejectionError({
								message: `Cedro authentication rejected: ${line}`,
								line,
							}),
						);
					}
				}
				yield* onLine(line);
			}),
		).pipe(
			Effect.onExit((exit) =>
				Effect.gen(function* () {
					const isDone = yield* Deferred.isDone(authDeferred);
					if (!isDone) {
						yield* Deferred.fail(
							authDeferred,
							new CedroProtocolError({
								message:
									"Connection closed before authentication confirmation was received",
								cause: exit,
							}),
						);
					}
				}),
			),
			Effect.forkScoped,
		);

		// 3. Await authentication confirmation with timeout
		yield* Deferred.await(authDeferred).pipe(
			Effect.timeout(authTimeout),
			Effect.catchTag("TimeoutError", () =>
				Effect.fail(
					new CedroAuthTimeoutError({
						message: "Authentication confirmation timed out",
					}),
				),
			),
		);

		// 4. Once confirmed, send trade subscriptions
		if (tickers.length > 0) {
			yield* client.subscribeTrades(tickers);
		}

		// 5. Await consumer fiber until completion
		yield* Fiber.join(lineConsumerFiber);
	});

export const main = Effect.gen(function* () {
	const host = yield* Config.string("CEDRO_HOST").pipe(
		Config.withDefault("datafeedcd3.cedrotech.com"),
	);
	const port = yield* Config.int("CEDRO_PORT").pipe(Config.withDefault(81));
	const magicToken = yield* Config.redacted("CEDRO_TOKEN");
	const username = yield* Config.redacted("CEDRO_USERNAME");
	const password = yield* Config.redacted("CEDRO_PASSWORD");
	const credentials = {
		magicToken: Redacted.value(magicToken),
		username: Redacted.value(username),
		password: Redacted.value(password),
	};
	const secrets = Object.values(credentials).sort(
		(a, b) => b.length - a.length,
	);
	const cedroLayer = CedroClientLive.pipe(
		Layer.provide(
			Layer.merge(
				TcpStreamLive({ host, port, retry: false }),
				CedroConfigLive(credentials),
			),
		),
	);
	return yield* receiveCedroCommands((line) =>
		Console.log(
			secrets.reduce(
				(text, secret) => text.replaceAll(secret, "[REDACTED]"),
				line,
			),
		),
	).pipe(Effect.provide(cedroLayer));
});

if (import.meta.main) {
	BunRuntime.runMain(main);
}
