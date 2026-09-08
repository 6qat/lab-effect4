import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	MutableRef,
	Option,
	Queue,
	Semaphore,
	Stream,
} from "effect";
import {
	buildDefaultRetrySchedule,
	ConnectionConfig,
	ConnectionConfigLive,
	type ConnectionConfigShape,
	TcpStream,
	TcpStreamError,
	unknownToMessage,
	validateConnectionConfig,
} from "./tcp-connection-common.js";

export { TcpStreamError } from "./tcp-connection-common.js";

export interface RawSocketWriteResult {
	readonly flushed: boolean;
	readonly bytesWritten: number;
}

export interface RawSocketHandle {
	readonly write: (
		chunk: Uint8Array,
	) => Effect.Effect<RawSocketWriteResult, TcpStreamError>;
	readonly close: () => Effect.Effect<void>;
}

export type ConnectionEvent =
	| { readonly _tag: "Data"; readonly chunk: Uint8Array }
	| { readonly _tag: "Drain" };

export interface EstablishedConnection {
	readonly socket: RawSocketHandle;
	readonly events: Stream.Stream<ConnectionEvent, TcpStreamError>;
}

export type TcpStreamEngineConfig = Pick<
	ConnectionConfigShape,
	"host" | "port" | "tls" | "connectTimeout"
>;

export interface TcpStreamEngineShape {
	readonly connect: (
		config: TcpStreamEngineConfig,
	) => Effect.Effect<
		EstablishedConnection,
		TcpStreamError,
		import("effect").Scope.Scope
	>;
}

export class TcpStreamEngine extends Context.Service<
	TcpStreamEngine,
	TcpStreamEngineShape
>()("TcpStreamEngine") {}

export type TcpStreamEngineAdapterEvent =
	| { readonly _tag: "Ready" }
	| { readonly _tag: "Data"; readonly chunk: Uint8Array }
	| { readonly _tag: "Drain" }
	| { readonly _tag: "Close" }
	| { readonly _tag: "Error"; readonly cause: unknown };
type EmitDisposition = "accepted" | "closed";
type ColdAdapter = (
	config: TcpStreamEngineConfig,
	emit: (event: TcpStreamEngineAdapterEvent) => EmitDisposition,
) => Effect.Effect<RawSocketHandle, unknown, import("effect").Scope.Scope>;

const connectError = (cause: unknown, message = "Connection failed") =>
	new TcpStreamError({
		operation: "connect",
		message: `${message}: ${unknownToMessage(cause)}`,
		cause,
	});

/** Builds the public caller-first engine from the private cold adapter protocol. */
export const makeTcpStreamEngine = (
	adapter: ColdAdapter,
): TcpStreamEngineShape => ({
	connect: (config) =>
		Effect.gen(function* () {
			const queue = yield* Queue.unbounded<
				ConnectionEvent,
				TcpStreamError | Cause.Done
			>();
			const ready = yield* Deferred.make<void, TcpStreamError>();
			let phase: "connecting" | "ready" | "closed" = "connecting";
			let isReady = false;
			let outcome = false;
			const abandon = () => {
				outcome = true;
				phase = "closed";
			};
			const emit = (event: TcpStreamEngineAdapterEvent): EmitDisposition => {
				if (outcome || phase === "closed") return "closed";
				switch (event._tag) {
					case "Ready":
						if (phase !== "connecting") return "closed";
						phase = "ready";
						isReady = true;
						Deferred.doneUnsafe(ready, Effect.succeed(void 0));
						return "accepted";
					case "Data":
						Queue.offerUnsafe(queue, { _tag: "Data", chunk: event.chunk });
						return "accepted";
					case "Drain":
						Queue.offerUnsafe(queue, { _tag: "Drain" });
						return "accepted";
					case "Close":
						phase = "closed";
						Queue.endUnsafe(queue);
						return "accepted";
					case "Error": {
						const error = new TcpStreamError({
							operation: phase === "connecting" ? "connect" : "read",
							message: unknownToMessage(event.cause),
							cause: event.cause,
						});
						outcome = true;
						phase = "closed";
						Deferred.doneUnsafe(ready, Effect.fail(error));
						Queue.failCauseUnsafe(queue, Cause.fail(error));
						return "closed";
					}
				}
			};

			const attempt = yield* withConnectTimeout(
				adapter(config, emit).pipe(
					Effect.onExit((exit) =>
						Exit.isSuccess(exit) ? Effect.void : Effect.sync(abandon),
					),
					Effect.mapError((cause) => connectError(cause)),
				),
				config,
			);
			if (!isReady) {
				yield* attempt.close().pipe(Effect.catch(() => Effect.void));
				if (outcome) {
					yield* Deferred.await(ready);
				}
				yield* new TcpStreamError({
					operation: "connect",
					message: "Connection closed before ready",
				});
			}
			let handleClosed = false;
			const close = Effect.gen(function* () {
				if (handleClosed) return;
				handleClosed = true;
				if (phase !== "closed") {
					outcome = true;
					phase = "closed";
					Queue.endUnsafe(queue);
				}
				yield* attempt.close();
			});
			return {
				socket: {
					...attempt,
					close: () => close.pipe(Effect.catch(() => Effect.void)),
				},
				events: Stream.fromQueue(queue),
			};
		}),
});

export const withConnectTimeout = <A, R>(
	effect: Effect.Effect<A, TcpStreamError, R>,
	config: ConnectionConfigShape,
) =>
	effect.pipe(
		Effect.timeout(config.connectTimeout ?? "3 seconds"),
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

type ConnectionState =
	| { readonly _tag: "Open" }
	| { readonly _tag: "Closed"; readonly error?: TcpStreamError };

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
	const finish = (error?: TcpStreamError) => {
		if (MutableRef.get(state)._tag === "Closed") return;
		MutableRef.set(
			state,
			error ? { _tag: "Closed", error } : { _tag: "Closed" },
		);
		const waiter = MutableRef.get(drainWaiter);
		if (waiter)
			Deferred.doneUnsafe(
				waiter,
				error
					? Effect.fail(error)
					: Effect.fail(
							new TcpStreamError({
								operation: "write",
								message: "Connection closed",
							}),
						),
			);
		if (error) Queue.failCauseUnsafe(incoming, Cause.fail(error));
		else Queue.endUnsafe(incoming);
	};
	const retry =
		validConfig.retrySchedule !== undefined
			? Option.some(validConfig.retrySchedule)
			: validConfig.retry === false
				? Option.none()
				: Option.some(buildDefaultRetrySchedule(validConfig.retry));
	const engineConfig: TcpStreamEngineConfig = {
		host: validConfig.host,
		port: validConfig.port,
		...(validConfig.tls === undefined ? {} : { tls: validConfig.tls }),
		...(validConfig.connectTimeout === undefined
			? {}
			: { connectTimeout: validConfig.connectTimeout }),
	};
	const connection = yield* Effect.acquireRelease(
		Option.match(retry, {
			onNone: () => engine.connect(engineConfig),
			onSome: (schedule) =>
				Effect.retry(engine.connect(engineConfig), schedule),
		}),
		(connection) => connection.socket.close(),
		{ interruptible: true },
	);
	const eventFiber = yield* Stream.runForEach(connection.events, (event) =>
		event._tag === "Data"
			? Effect.sync(() => Queue.offerUnsafe(incoming, event.chunk))
			: Effect.sync(() => {
					const waiter = MutableRef.get(drainWaiter);
					if (waiter) {
						MutableRef.set(drainWaiter, undefined);
						Deferred.doneUnsafe(waiter, Effect.succeed(void 0));
					}
				}),
	).pipe(
		Effect.onExit((exit) =>
			Effect.sync(() => {
				if (
					Exit.isSuccess(exit) ||
					exit.cause.reasons.every(Cause.isInterruptReason)
				) {
					finish();
					return;
				}
				const failure = Cause.squash(exit.cause);
				finish(
					failure instanceof TcpStreamError
						? failure
						: new TcpStreamError({
								operation: "read",
								message: unknownToMessage(failure),
								cause: failure,
							}),
				);
			}),
		),
		Effect.forkScoped,
	);
	const close = Effect.gen(function* () {
		finish();
		yield* Fiber.interrupt(eventFiber);
		yield* connection.socket.close();
	});
	const send = (data: Uint8Array) =>
		Semaphore.withPermits(
			writeLock,
			1,
		)(
			Effect.gen(function* () {
				let offset = 0;
				while (offset < data.byteLength) {
					const current = MutableRef.get(state);
					if (current._tag === "Closed")
						return yield* current.error ??
							new TcpStreamError({
								operation: "write",
								message: "Cannot send data on a closed TCP connection",
							});
					const waiter = Deferred.makeUnsafe<void, TcpStreamError>();
					MutableRef.set(drainWaiter, waiter);
					const result = yield* connection.socket.write(data.subarray(offset));
					if (result.bytesWritten < 0)
						return yield* new TcpStreamError({
							operation: "write",
							message: "Socket closed while writing",
						});
					if (result.bytesWritten === 0) {
						yield* Deferred.await(waiter);
						continue;
					}
					offset += result.bytesWritten;
					if (result.flushed) MutableRef.set(drainWaiter, undefined);
					else yield* Deferred.await(waiter);
				}
			}),
		);
	return TcpStream.of({
		stream: Stream.fromQueue(incoming),
		send,
		sendText: (text) => send(new TextEncoder().encode(text)),
		close,
	});
});

export const TcpStreamLayer = Layer.effect(TcpStream, makeTcpStream);
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
		return config
			? base.pipe(Layer.provide(ConnectionConfigLive(config)))
			: base;
	}
	return layer;
};
