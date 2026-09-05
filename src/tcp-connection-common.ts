import type * as tls from "node:tls";
import {
	Cause,
	Context,
	Data,
	Deferred,
	type Duration,
	Effect,
	Layer,
	MutableRef,
	Option,
	Queue,
	Result,
	Schedule,
	type Scope,
	Semaphore,
	Stream,
} from "effect";

export class ConnectionConfigError extends Data.TaggedError(
	"ConnectionConfigError",
)<{
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

/**
 * Unified configuration for a TCP connection session across runtimes.
 *
 * Decisions made:
 * - TLS options accept a union `boolean | Bun.TLSOptions | tls.ConnectionOptions` (Q3 -> Option B).
 *   - `boolean`: Simple TLS activation across both Bun and Node.js.
 *   - `Bun.TLSOptions`: Bun-specific TLS options (e.g., `ca`, `cert`, `key`, `serverName`, `rejectUnauthorized`).
 *   - `tls.ConnectionOptions`: Node.js-specific TLS options (e.g., `ca`, `cert`, `key`, `servername`, `rejectUnauthorized`).
 */
export interface ConnectionConfigShape {
	readonly host: string;
	readonly port: number;
	readonly tls?: boolean | Bun.TLSOptions | tls.ConnectionOptions;
	readonly retry?: RetryPolicyConfig | false;
	readonly retrySchedule?: Schedule.Schedule<unknown, unknown>;
}

export class ConnectionConfig extends Context.Service<
	ConnectionConfig,
	ConnectionConfigShape
>()("ConnectionConfig") {}

export const ConnectionConfigLive = (config: ConnectionConfigShape) =>
	Layer.succeed(ConnectionConfig, config);

export const unknownToMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const validateHostAndPort = (
	host: string,
	port: number,
): Result.Result<
	{ readonly host: string; readonly port: number },
	ConnectionConfigError
> => {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return Result.fail(
			new ConnectionConfigError({ message: `Invalid port ${port}` }),
		);
	}
	if (!host.trim()) {
		return Result.fail(
			new ConnectionConfigError({ message: "Host cannot be empty" }),
		);
	}
	return Result.succeed({ host, port });
};

export const validateConnectionConfig = (
	config: ConnectionConfigShape,
): Result.Result<ConnectionConfigShape, ConnectionConfigError> =>
	Result.map(validateHostAndPort(config.host, config.port), () => config);

export const buildDefaultRetrySchedule = (config?: RetryPolicyConfig) => {
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

/**
 * Socket event callbacks provided by TcpStream to the underlying engine adapter.
 *
 * Decision: Minimal raw socket event interface (Q1 -> Option A).
 * Concurrency, write buffering, queueing, and drain waiters are owned by TcpStream.
 */
export interface SocketCallbacks {
	readonly onData: (chunk: Uint8Array) => void;
	readonly onDrain: () => void;
	readonly onClose: () => void;
	readonly onError: (error: Error) => void;
}

export interface RawSocketWriteResult {
	readonly flushed: boolean;
	readonly bytesWritten: number;
}

/**
 * Handle to an active raw socket returned by TcpStreamEngine upon connection.
 *
 * Decision: Raw socket handle returns normalized write status (Q4 -> Option A).
 * - `flushed`: `true` if kernel/userland buffers flushed without backpressure.
 * - `bytesWritten`: number of bytes accepted (supports partial writes in Bun).
 * - Teardown via `close()` callback, managed via Effect Scope in TcpStream (Q6 -> Option B).
 */
export interface RawSocketHandle {
	readonly write: (
		chunk: Uint8Array,
	) => Effect.Effect<RawSocketWriteResult, TcpStreamError>;
	readonly close: () => Effect.Effect<void>;
}

/**
 * Runtime-agnostic engine adapter service.
 * Three adapters satisfy this seam: Bun native sockets, Node.js node:net/node:tls,
 * and @effect/platform Socket.Socket.
 *
 * `connect` may require `Scope.Scope`: an adapter that owns Effect-managed
 * child resources (forked fibers, `@effect/platform` writer scopes, etc.)
 * should fork a child of that ambient scope — rather than an unlinked
 * `Scope.make()` — so those resources are torn down whenever the caller's
 * own scope closes or is interrupted, even if `RawSocketHandle.close()` is
 * never explicitly invoked. Adapters with nothing to scope (Bun, Node.js)
 * simply don't consume it.
 */
export interface TcpStreamEngineShape {
	readonly connect: (
		config: ConnectionConfigShape,
		callbacks: SocketCallbacks,
	) => Effect.Effect<RawSocketHandle, TcpStreamError, Scope.Scope>;
}

export class TcpStreamEngine extends Context.Service<
	TcpStreamEngine,
	TcpStreamEngineShape
>()("TcpStreamEngine") {}

type ConnectionState =
	| { readonly _tag: "Open" }
	| { readonly _tag: "Closed"; readonly error?: TcpStreamError };

/**
 * Deep orchestrator for TcpStream.
 *
 * Decisions made:
 * - Centralized concurrency: incoming queue, writeLock semaphore, drain waiter deferred,
 *   and stream lifecycles are owned entirely here (Q1 -> Option A).
 * - Sockets normalize backpressure to a boolean (flushed vs buffered) with bytesWritten (Q4 -> Option A).
 * - Socket cleanup is managed via Effect Scope finalizer (Q6 -> Option B).
 */
export const makeTcpStream = Effect.gen(function* () {
	const config = yield* ConnectionConfig;
	const engine = yield* TcpStreamEngine;

	const validConfig = yield* Effect.fromResult(
		validateConnectionConfig(config),
	);

	const incoming = yield* Queue.unbounded<
		Uint8Array,
		TcpStreamError | Cause.Done
	>();
	const writeLock = yield* Semaphore.make(1);

	const state = MutableRef.make<ConnectionState>({ _tag: "Open" });
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

	const finishIncoming = (error?: TcpStreamError): boolean => {
		const currentState = MutableRef.get(state);
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

	// Determine retry schedule based on configuration
	const retrySchedule =
		validConfig.retrySchedule !== undefined
			? Option.some(validConfig.retrySchedule)
			: validConfig.retry === false
				? Option.none()
				: Option.some(buildDefaultRetrySchedule(validConfig.retry));

	const connectEffect = engine.connect(validConfig, {
		onData(chunk) {
			Queue.offerUnsafe(incoming, chunk);
		},
		onDrain() {
			completeDrainWaiter();
		},
		onClose() {
			finishIncoming();
		},
		onError(err) {
			finishIncoming(
				new TcpStreamError({
					operation: "read",
					message: err.message,
					cause: err,
				}),
			);
		},
	});

	const connectWithRetry = Option.match(retrySchedule, {
		onNone: () => connectEffect,
		onSome: (schedule) => Effect.retry(connectEffect, schedule),
	});

	// Acquire and register teardown atomically (Q6 -> Option B): a separate
	// "connect, then addFinalizer" pair leaves a window, between a
	// successful connect and the finalizer registration, where an
	// interruption would skip closing the socket entirely. acquireRelease
	// guarantees the release (close) runs whenever the enclosing scope
	// closes, including on interruption of this very step — and, per its
	// own contract, still guarantees this even with `interruptible: true`:
	// that option only controls whether a still-in-flight connect/retry
	// attempt can itself be cancelled (which it must remain, so callers can
	// still time out or shut down while retries are backing off); once
	// `connectWithRetry` actually produces a handle, release is registered
	// and guaranteed to run regardless.
	const socketHandle = yield* Effect.acquireRelease(
		connectWithRetry,
		(handle) =>
			Effect.gen(function* () {
				finishIncoming();
				yield* handle.close().pipe(Effect.catch(() => Effect.void));
			}),
		{ interruptible: true },
	);

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
								message: "Cannot send data on a closed TCP connection",
							});
					}

					const waiter = Deferred.makeUnsafe<void, TcpStreamError>();
					MutableRef.set(drainWaiter, waiter);

					const chunkToWrite = data.subarray(offset);
					const writeResult = yield* socketHandle.write(chunkToWrite);

					if (writeResult.bytesWritten < 0) {
						return yield* new TcpStreamError({
							operation: "write",
							message: "Socket closed while writing",
						});
					}

					offset += writeResult.bytesWritten;

					if (!writeResult.flushed) {
						const stateAfterWrite = MutableRef.get(state);
						if (stateAfterWrite._tag === "Closed") {
							return yield* stateAfterWrite.error ??
								new TcpStreamError({
									operation: "write",
									message: "Connection closed during a partial write",
								});
						}
						// Kernel/userland buffer is saturated; pause until drain event releases waiter
						yield* Deferred.await(waiter);
					} else {
						// Flushed immediately; clear registered waiter
						MutableRef.set(drainWaiter, undefined);
					}
				}
			}),
		);

	const encoder = new TextEncoder();
	const sendText = (data: string) => send(encoder.encode(data));

	const close = Effect.gen(function* () {
		finishIncoming();
		yield* socketHandle.close().pipe(Effect.catch(() => Effect.void));
	});

	return TcpStream.of({
		stream: Stream.fromQueue(incoming),
		send,
		sendText,
		close,
	});
});

/**
 * Standard composable layer requiring TcpStreamEngine and ConnectionConfig.
 */
export const TcpStreamLayer = Layer.effect(TcpStream, makeTcpStream);

/**
 * Generic convenience layer factory for runtime engine adapters.
 */
export interface ConvenienceLayer<S> {
	(config: ConnectionConfigShape): Layer.Layer<S>;
	(): Layer.Layer<S, never, ConnectionConfig>;
}

export const makeConvenienceLayer = (
	engineLayer: Layer.Layer<TcpStreamEngine>,
): ConvenienceLayer<TcpStream> => {
	const base = TcpStreamLayer.pipe(Layer.provide(engineLayer));
	function layer(config: ConnectionConfigShape): Layer.Layer<TcpStream>;
	function layer(): Layer.Layer<TcpStream, never, ConnectionConfig>;
	function layer(config?: ConnectionConfigShape) {
		return config !== undefined
			? base.pipe(Layer.provide(ConnectionConfigLive(config)))
			: base;
	}
	return layer;
};
