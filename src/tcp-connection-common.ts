import {
	Context,
	Data,
	type Duration,
	type Effect,
	Result,
	Schedule,
	type Stream,
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
