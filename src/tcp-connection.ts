import {
	Cause,
	Context,
	Data,
	Deferred,
	type Duration,
	Effect,
	Layer,
	MutableRef,
	Queue,
	Result,
	Schedule,
	Semaphore,
	Stream,
} from "effect";

class ConnectionConfigError extends Data.TaggedError("ConnectionConfigError")<{
	readonly message: string;
}> {}

export type TcpStreamOperation = "connect" | "read" | "write";

export class TcpStreamError extends Data.TaggedError("TcpStreamError")<{
	readonly operation: TcpStreamOperation;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export interface TcpStreamShape {
	/**
	 * Incoming bytes from the socket.
	 *
	 * A graceful socket close completes the stream normally. A socket or write
	 * failure fails the stream with `TcpStreamError`.
	 */
	readonly stream: Stream.Stream<Uint8Array, TcpStreamError>;
	readonly send: (data: Uint8Array) => Effect.Effect<void, TcpStreamError>;
	readonly sendText: (data: string) => Effect.Effect<void, TcpStreamError>;
	readonly close: Effect.Effect<void>;
}

export class TcpStream extends Context.Service<TcpStream, TcpStreamShape>()(
	"TcpStream",
) {}

export interface RetryPolicyConfig {
	readonly initialDelay?: Duration.Input;
	readonly factor?: number;
	readonly maxAttempts?: number;
	readonly maxDuration?: Duration.Input;
	readonly jitter?: boolean;
}

export interface ConnectionConfigShape {
	readonly host: string;
	readonly port: number;
	readonly tls?: boolean | Bun.TLSOptions;
	readonly retry?: RetryPolicyConfig | false;
	readonly retrySchedule?: Schedule.Schedule<unknown, unknown>;
}

export class ConnectionConfig extends Context.Service<
	ConnectionConfig,
	ConnectionConfigShape
>()("ConnectionConfig") {}

type ConnectionState =
	| { readonly _tag: "Open" }
	| { readonly _tag: "Closed"; readonly error?: TcpStreamError };

type EndableSocket = {
	readonly end: () => void;
};

const unknownToMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const validateConnectionConfig = (
	config: ConnectionConfigShape,
): Result.Result<ConnectionConfigShape, ConnectionConfigError> => {
	if (
		!Number.isInteger(config.port) ||
		config.port < 1 ||
		config.port > 65535
	) {
		return Result.fail(
			new ConnectionConfigError({ message: `Invalid port ${config.port}` }),
		);
	}
	if (!config.host.trim()) {
		return Result.fail(
			new ConnectionConfigError({ message: "Host cannot be empty" }),
		);
	}
	return Result.succeed(config);
};

const buildDefaultRetrySchedule = (config?: RetryPolicyConfig) => {
	const initialDelay = config?.initialDelay ?? "100 millis";
	const factor = config?.factor ?? 2.0;
	const maxAttempts = config?.maxAttempts ?? 5;
	const maxDuration = config?.maxDuration ?? "30 seconds";
	const useJitter = config?.jitter ?? true;

	let schedule = Schedule.exponential(initialDelay, factor);
	if (useJitter) {
		schedule = Schedule.jittered(schedule);
	}
	return Schedule.upTo(schedule, {
		times: maxAttempts,
		duration: maxDuration,
	});
};

const makeTcpStream = Effect.gen(function* () {
	const config = yield* ConnectionConfig;

	const incoming = yield* Queue.unbounded<
		Uint8Array,
		TcpStreamError | Cause.Done
	>();

	const writeLock = yield* Semaphore.make(1);

	// 3 mutable refs to manage connection state and socket drain events
	const state = MutableRef.make<ConnectionState>({ _tag: "Open" });
	const hasEndedSocket = MutableRef.make(false);
	const drainWaiter = MutableRef.make<
		Deferred.Deferred<void, TcpStreamError> | undefined
	>(undefined);

	const completeDrainWaiter = (error?: TcpStreamError): void => {
		const waiter = MutableRef.get(drainWaiter);
		if (waiter === undefined) {
			return;
		}

		MutableRef.set(drainWaiter, undefined);
		Deferred.doneUnsafe(
			waiter,
			error === undefined ? Effect.void : Effect.fail(error),
		);
	};

	// Undefined error means graceful completion
	const finishIncoming = (error?: TcpStreamError): boolean => {
		const currentState = MutableRef.get(state);

		// Ensure completion happens only once
		if (currentState._tag === "Closed") {
			return false;
		}

		if (error) {
			MutableRef.set(state, { _tag: "Closed", error });
			completeDrainWaiter(error);
			Queue.failCauseUnsafe(incoming, Cause.fail(error));
		} else {
			MutableRef.set(state, { _tag: "Closed" });
			completeDrainWaiter(
				new TcpStreamError({
					operation: "write",
					message: "Connection closed while waiting for socket drain",
				}),
			);
			Queue.endUnsafe(incoming);
		}

		return true;
	};

	const endSocket = (socket: EndableSocket): void => {
		if (!MutableRef.compareAndSet(hasEndedSocket, false, true)) {
			return;
		}

		try {
			socket.end();
		} catch {
			// Closing is idempotent and best-effort; a prior socket failure is
			// already represented by the incoming stream's error channel.
		}
	};

	const connectOnce = Effect.tryPromise<Bun.Socket<undefined>, TcpStreamError>({
		try: () =>
			Bun.connect<undefined>({
				hostname: config.host,
				port: config.port,
				...(config.tls === undefined ? {} : { tls: config.tls }),
				socket: {
					binaryType: "uint8array",
					data(_socket, data) {
						Queue.offerUnsafe(incoming, data);
					},
					drain() {
						completeDrainWaiter();
					},
					error(socket, cause) {
						const error = new TcpStreamError({
							operation: "read",
							message: `Socket error: ${unknownToMessage(cause)}`,
							cause,
						});

						finishIncoming(error);
						endSocket(socket);
					},
					close() {
						MutableRef.set(hasEndedSocket, true);
						finishIncoming();
					},
				},
			}),
		catch: (cause) =>
			new TcpStreamError({
				operation: "connect",
				message: `Connection failed: ${unknownToMessage(cause)}`,
				cause,
			}),
	}).pipe(
		Effect.timeout("3 seconds"),
		Effect.mapError((cause) =>
			cause instanceof TcpStreamError
				? cause
				: new TcpStreamError({
						operation: "connect",
						message: "Connection timeout",
						cause,
					}),
		),
	);

	const connect =
		config.retrySchedule !== undefined
			? Effect.retry(connectOnce, config.retrySchedule)
			: config.retry === false
				? connectOnce
				: Effect.retry(connectOnce, buildDefaultRetrySchedule(config.retry));

	const socket = yield* Effect.acquireRelease(connect, (socket) =>
		Effect.sync(() => {
			finishIncoming();
			endSocket(socket);
		}),
	);

	const failConnection = (error: TcpStreamError): Effect.Effect<void> =>
		Effect.sync(() => {
			finishIncoming(error);
			endSocket(socket);
		});

	const send = (data: Uint8Array): Effect.Effect<void, TcpStreamError> =>
		Semaphore.withPermits(
			writeLock,
			1,
		)(
			Effect.gen(function* () {
				let offset = 0;

				while (offset < data.byteLength) {
					const currentState = MutableRef.get(state);
					if (currentState._tag === "Closed") {
						return yield* currentState.error ??
							new TcpStreamError({
								operation: "write",
								message: "Connection is closed",
							});
					}

					// Register before calling socket.write so a drain event cannot be
					// missed if Bun emits it immediately after accepting a partial write.
					const waiter = Deferred.makeUnsafe<void, TcpStreamError>();
					MutableRef.set(drainWaiter, waiter);

					const bytesWritten = yield* Effect.try({
						try: () => {
							const written = socket.write(data.subarray(offset));
							socket.flush();
							return written;
						},
						catch: (cause) =>
							new TcpStreamError({
								operation: "write",
								message: `Socket write failed: ${unknownToMessage(cause)}`,
								cause,
							}),
					});

					if (bytesWritten < 0) {
						return yield* new TcpStreamError({
							operation: "write",
							message: "Socket closed while writing",
						});
					}

					offset += bytesWritten;

					if (offset < data.byteLength) {
						// The socket may have closed between the state check above and
						// registering the waiter. Check again before suspending.
						const stateAfterWrite = MutableRef.get(state);
						if (stateAfterWrite._tag === "Closed") {
							return yield* stateAfterWrite.error ??
								new TcpStreamError({
									operation: "write",
									message: "Connection closed during a partial write",
								});
						}

						yield* Deferred.await(waiter);
					} else {
						MutableRef.set(drainWaiter, undefined);
					}
				}
			}).pipe(
				Effect.tapError(failConnection),
				// If the sending fiber itself is interrupted while waiting for drain,
				// remove its waiter before another sender acquires the semaphore.
				Effect.ensuring(
					Effect.sync(() => MutableRef.set(drainWaiter, undefined)),
				),
			),
		);

	const textEncoder = new TextEncoder();
	return TcpStream.of({
		stream: Stream.fromQueue(incoming),
		send,
		sendText: (data) => send(textEncoder.encode(data)),
		close: Effect.sync(() => {
			finishIncoming();
			endSocket(socket);
		}),
	});
});

export const TcpStreamLive = () => Layer.effect(TcpStream, makeTcpStream);

export const ConnectionConfigLive = (config: ConnectionConfigShape) =>
	Layer.succeed(ConnectionConfig, config);
