import type * as tls from "node:tls";
import {
	Context,
	Data,
	type Duration,
	type Effect,
	Layer,
	Result,
	Schedule,
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
	readonly stream: import("effect").Stream.Stream<Uint8Array, TcpStreamError>;
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
	readonly tls?: boolean | Bun.TLSOptions | tls.ConnectionOptions;
	readonly retry?: RetryPolicyConfig | false;
	readonly retrySchedule?: Schedule.Schedule<unknown, unknown>;
	readonly connectTimeout?: Duration.Input;
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
	let schedule = Schedule.exponential(
		config?.initialDelay ?? "100 millis",
		config?.factor ?? 2,
	);
	if (config?.jitter ?? true) schedule = Schedule.jittered(schedule);
	return Schedule.upTo(schedule, {
		times: config?.maxAttempts ?? 5,
		duration: config?.maxDuration ?? "30 seconds",
	});
};
