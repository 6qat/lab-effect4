import * as net from "node:net";
import * as tls from "node:tls";
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Layer,
	MutableRef,
	Queue,
	Result,
	type Schedule,
	Semaphore,
	Stream,
} from "effect";
import {
	buildDefaultRetrySchedule,
	ConnectionConfigError,
	type RetryPolicyConfig,
	TcpStream,
	TcpStreamError,
	type TcpStreamOperation,
	type TcpStreamShape,
	unknownToMessage,
	validateHostAndPort,
} from "./tcp-connection-common.js";

export {
	buildDefaultRetrySchedule,
	ConnectionConfigError,
	type RetryPolicyConfig,
	TcpStream,
	TcpStreamError,
	type TcpStreamOperation,
	type TcpStreamShape,
};

export interface ConnectionConfigShape {
	readonly host: string;
	readonly port: number;
	readonly tls?: boolean | tls.ConnectionOptions;
	readonly retry?: RetryPolicyConfig | false;
	readonly retrySchedule?: Schedule.Schedule<unknown, unknown>;
}

export class ConnectionConfig extends Context.Service<
	ConnectionConfig,
	ConnectionConfigShape
>()("ConnectionConfigNode") {}

type ConnectionState =
	| { readonly _tag: "Open" }
	| { readonly _tag: "Closed"; readonly error?: TcpStreamError };

export const validateConnectionConfig = (
	config: ConnectionConfigShape,
): Result.Result<ConnectionConfigShape, ConnectionConfigError> => {
	const valid = validateHostAndPort(config.host, config.port);
	if (valid._tag === "Failure") {
		return valid;
	}
	return Result.succeed(config);
};

const makeTcpStream = Effect.gen(function* () {
	const config = yield* ConnectionConfig;

	const incoming = yield* Queue.unbounded<
		Uint8Array,
		TcpStreamError | Cause.Done
	>();
	const writeLock = yield* Semaphore.make(1);

	const state = MutableRef.make<ConnectionState>({ _tag: "Open" });
	const hasDestroyedSocket = MutableRef.make(false);
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

	const destroySocket = (socket: net.Socket, error?: Error): void => {
		if (!MutableRef.compareAndSet(hasDestroyedSocket, false, true)) {
			return;
		}

		try {
			socket.removeAllListeners();
			socket.destroy(error);
		} catch {
			// Closing is idempotent and best-effort
		}
	};

	const endSocket = (socket: net.Socket): void => {
		if (!MutableRef.compareAndSet(hasDestroyedSocket, false, true)) {
			return;
		}

		try {
			socket.end();
		} catch {
			destroySocket(socket);
		}
	};

	const connectOnce = Effect.callback<net.Socket, TcpStreamError>((resume) => {
		let settled = false;
		let socket: net.Socket;

		const cleanup = () => {
			socket.removeListener("connect", onConnect);
			socket.removeListener("secureConnect", onConnect);
			socket.removeListener("error", onError);
		};

		const onConnect = () => {
			if (!settled) {
				settled = true;
				cleanup();
				resume(Effect.succeed(socket));
			}
		};

		const onError = (cause: unknown) => {
			if (!settled) {
				settled = true;
				cleanup();
				socket.destroy();
				resume(
					Effect.fail(
						new TcpStreamError({
							operation: "connect",
							message: `Connection failed: ${unknownToMessage(cause)}`,
							cause,
						}),
					),
				);
			}
		};

		try {
			if (config.tls) {
				const tlsOptions: tls.ConnectionOptions =
					typeof config.tls === "boolean" ? {} : config.tls;
				socket = tls.connect({
					...tlsOptions,
					host: config.host,
					port: config.port,
				});
				socket.once("secureConnect", onConnect);
			} else {
				socket = net.createConnection({
					host: config.host,
					port: config.port,
				});
				socket.once("connect", onConnect);
			}
			socket.once("error", onError);
		} catch (cause) {
			onError(cause);
		}

		return Effect.sync(() => {
			if (!settled) {
				settled = true;
				cleanup();
				socket?.destroy();
			}
		});
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
			destroySocket(socket);
		}),
	);

	// Attach persistent event listeners to the acquired socket
	socket.on("data", (chunk: Buffer) => {
		// Queue.offerUnsafe(
		// 	incoming,
		// 	new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
		// );
		// const data = new Uint8Array(chunk);
		const dataFromChunk = new Uint8Array(chunk);
		Queue.offerUnsafe(incoming, dataFromChunk);
	});

	socket.on("drain", () => {
		completeDrainWaiter();
	});

	socket.on("error", (cause) => {
		const error = new TcpStreamError({
			operation: "read",
			message: `Socket error: ${unknownToMessage(cause)}`,
			cause,
		});
		finishIncoming(error);
		destroySocket(socket, cause instanceof Error ? cause : undefined);
	});

	socket.on("close", () => {
		MutableRef.set(hasDestroyedSocket, true);
		finishIncoming();
	});

	const failConnection = (error: TcpStreamError): Effect.Effect<void> =>
		Effect.sync(() => {
			finishIncoming(error);
			destroySocket(
				socket,
				error.cause instanceof Error ? error.cause : undefined,
			);
		});

	const send = (data: Uint8Array): Effect.Effect<void, TcpStreamError> =>
		Semaphore.withPermits(
			writeLock,
			1,
		)(
			Effect.gen(function* () {
				const currentState = MutableRef.get(state);
				if (currentState._tag === "Closed") {
					return yield* currentState.error ??
						new TcpStreamError({
							operation: "write",
							message: "Connection is closed",
						});
				}

				const waiter = Deferred.makeUnsafe<void, TcpStreamError>();
				MutableRef.set(drainWaiter, waiter);

				const canContinue = yield* Effect.try({
					try: () => socket.write(data),
					catch: (cause) =>
						new TcpStreamError({
							operation: "write",
							message: `Socket write failed: ${unknownToMessage(cause)}`,
							cause,
						}),
				});

				if (!canContinue) {
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
			}).pipe(
				Effect.tapError(failConnection),
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

export const TcpStreamNodeLive = () => Layer.effect(TcpStream, makeTcpStream);

export const ConnectionConfigNodeLive = (config: ConnectionConfigShape) =>
	Layer.succeed(ConnectionConfig, config);
