import { BunRuntime } from "@effect/platform-bun";
import {
	Cause,
	Config,
	Console,
	Data,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Redacted,
	Ref,
	type Scope,
	Stream,
} from "effect";
import {
	CedroClient,
	CedroClientLive,
	CedroConfigLive,
	type CedroConfigShape,
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
	readonly onSubscribed?: () => Effect.Effect<void, never>;
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
		if (options?.onSubscribed) {
			yield* options.onSubscribed();
		}

		// 5. Await consumer fiber until completion
		yield* Fiber.join(lineConsumerFiber);
	});

export interface CedroSupervisorOptions extends CedroSessionOptions {
	readonly host: string;
	readonly port: number;
	readonly credentials: CedroConfigShape;
	readonly backoffDelays?: ReadonlyArray<Duration.Input>;
	readonly onStatus?: (status: string) => Effect.Effect<void, never>;
}

/**
 * Supervised Cedro connection loop with capped exponential backoff.
 * Reconnects on clean disconnects, transport errors, and auth timeouts.
 * Re-authenticates afresh and restores trade subscriptions on each reconnect.
 * Resets backoff delay upon successful authentication and subscription restoration.
 * Terminates on fatal errors (explicit auth rejection, invalid credentials) or cancellation.
 */
export const runCedroSupervisor = <E = never, R = never>(
	onLine: (line: string) => Effect.Effect<void, E, R>,
	options: CedroSupervisorOptions,
): Effect.Effect<void, CedroAuthRejectionError | CedroProtocolError | E, R> =>
	Effect.gen(function* () {
		const delays = options.backoffDelays ?? [
			"1 second",
			"2 seconds",
			"4 seconds",
			"8 seconds",
			"16 seconds",
			"30 seconds",
		];
		const onStatus =
			options.onStatus ?? ((status: string) => Console.log(status));
		const attemptRef = yield* Ref.make(0);

		// Validate credentials upfront (so invalid local config fails fast before loop)
		if (
			!options.credentials.magicToken ||
			!options.credentials.username ||
			!options.credentials.password
		) {
			return yield* Effect.fail(
				new CedroProtocolError({
					message: "Missing required Cedro credentials or magic token",
				}),
			);
		}
		if (
			[
				options.credentials.magicToken,
				options.credentials.username,
				options.credentials.password,
			].some((val) => /[\r\n]/.test(val))
		) {
			return yield* Effect.fail(
				new CedroProtocolError({
					message: "Cedro login fields must not contain line breaks",
				}),
			);
		}

		while (true) {
			const attempt = yield* Ref.get(attemptRef);
			const sessionLayer = CedroClientLive.pipe(
				Layer.provide(
					Layer.merge(
						TcpStreamLive({
							host: options.host,
							port: options.port,
							retry: false,
						}),
						CedroConfigLive(options.credentials),
					),
				),
			);

			yield* onStatus(
				`[cedro] Connecting to ${options.host}:${options.port}...`,
			);

			const sessionResult = yield* Effect.scoped(
				runCedroSession(onLine, {
					...options,
					onSubscribed: () =>
						Effect.gen(function* () {
							yield* onStatus(
								`[cedro] Authenticated, restored subscriptions: ${(
									options.tickers ?? ["WINV26", "PETR4"]
								).join(", ")}`,
							);
							yield* Ref.set(attemptRef, 0);
							if (options.onSubscribed) {
								yield* options.onSubscribed();
							}
						}),
				}).pipe(Effect.provide(sessionLayer)),
			).pipe(Effect.exit);

			if (Exit.isSuccess(sessionResult)) {
				yield* onStatus("[cedro] Disconnected from server.");
			} else {
				const cause = sessionResult.cause;
				if (cause.reasons.some(Cause.isInterruptReason)) {
					return yield* Effect.interrupt;
				}
				const failure = Cause.squash(cause);
				if (failure instanceof CedroAuthRejectionError) {
					yield* onStatus(
						`[cedro] Fatal authentication rejection: ${failure.message}`,
					);
					return yield* Effect.fail(failure);
				}
				if (
					failure instanceof CedroProtocolError &&
					(failure.message.includes("line breaks") ||
						failure.message.includes("Missing required"))
				) {
					yield* onStatus(
						`[cedro] Fatal configuration error: ${failure.message}`,
					);
					return yield* Effect.fail(failure);
				}

				if (failure instanceof CedroAuthTimeoutError) {
					yield* onStatus("[cedro] Authentication confirmation timed out.");
				} else {
					yield* onStatus(
						`[cedro] Connection error: ${
							failure instanceof Error ? failure.message : String(failure)
						}`,
					);
				}
			}

			// Delay before reconnecting using capped backoff
			const delayInput =
				delays[Math.min(attempt, delays.length - 1)] ?? "1 second";
			const delayDuration = Duration.fromInputUnsafe(delayInput);
			yield* Ref.set(attemptRef, attempt + 1);

			yield* onStatus(
				`[cedro] Reconnecting in ${Duration.format(delayDuration)}...`,
			);
			yield* Effect.sleep(delayDuration);
		}
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
	const redact = (text: string) =>
		secrets.reduce(
			(acc, secret) => (secret ? acc.replaceAll(secret, "[REDACTED]") : acc),
			text,
		);

	return yield* runCedroSupervisor((line) => Console.log(redact(line)), {
		host,
		port,
		credentials,
		tickers: ["WINV26", "PETR4"],
		onStatus: (status) => Console.log(redact(status)),
	});
});

if (import.meta.main) {
	BunRuntime.runMain(main);
}
