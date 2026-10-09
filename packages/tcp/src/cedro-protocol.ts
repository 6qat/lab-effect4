import { Context, Data, Effect, Layer, Result, type Stream } from "effect";
import { frameLines } from "./line-framing.js";
import { TcpStream, type TcpStreamError } from "./tcp-connection.js";

export class CedroProtocolError extends Data.TaggedError("CedroProtocolError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Unusable local credentials. Fatal: the supervisor never retries this. */
export class CedroConfigurationError extends Data.TaggedError(
	"CedroConfigurationError",
)<{
	readonly message: string;
}> {}

export interface CedroConfigShape {
	readonly magicToken: string;
	readonly username: string;
	readonly password: string;
	readonly tickers?: ReadonlyArray<string>;
}

export class CedroConfig extends Context.Service<
	CedroConfig,
	CedroConfigShape
>()("CedroConfig") {}

/**
 * Validates Cedro login credentials: every field present, none containing a
 * line break. Reports the first failure in check order.
 */
export const validateCedroCredentials = (
	config: CedroConfigShape,
): Result.Result<void, CedroConfigurationError> => {
	if (!config.magicToken || !config.username || !config.password) {
		return Result.fail(
			new CedroConfigurationError({
				message: "Missing required Cedro credentials or magic token",
			}),
		);
	}
	if (
		[config.magicToken, config.username, config.password].some((value) =>
			/[\r\n]/.test(value),
		)
	) {
		return Result.fail(
			new CedroConfigurationError({
				message: "Cedro login fields must not contain line breaks",
			}),
		);
	}
	return Result.succeed(undefined);
};

export interface CedroClientShape {
	/** Sends login fields in order; completion does not confirm server acceptance. */
	readonly authenticate: () => Effect.Effect<
		void,
		TcpStreamError | CedroConfigurationError
	>;
	readonly subscribe: (
		tickers: ReadonlyArray<string>,
	) => Effect.Effect<void, TcpStreamError | CedroProtocolError>;
	readonly subscribeTrades: (
		tickers: ReadonlyArray<string>,
	) => Effect.Effect<void, TcpStreamError | CedroProtocolError>;
	readonly rawStream: Stream.Stream<Uint8Array, TcpStreamError>;
	/** Framed line stream: raw TCP bytes decoded to UTF-8 and split on line boundaries. */
	readonly lines: Stream.Stream<string, TcpStreamError>;
}

export class CedroClient extends Context.Service<
	CedroClient,
	CedroClientShape
>()("CedroClient") {}

export const formatTradeSubCommand = (
	ticker: string,
): Result.Result<string, CedroProtocolError> => {
	const trimmed = ticker.trim();
	if (!trimmed) {
		return Result.fail(
			new CedroProtocolError({
				message: "Cedro trade ticker must be non-empty",
			}),
		);
	}
	if (/[\r\n]/.test(ticker)) {
		return Result.fail(
			new CedroProtocolError({
				message: "Cedro trade ticker must not contain line breaks",
			}),
		);
	}
	return Result.succeed(`GQT ${trimmed} S\n`);
};

export const isCedroAuthRejection = (line: string): boolean => {
	const lower = line.toLowerCase();
	return (
		lower.includes("authentication failed") ||
		lower.includes("invalid password") ||
		lower.includes("invalid username") ||
		lower.includes("access denied") ||
		lower.includes("login failed") ||
		lower.includes("login incorreto") ||
		lower.includes("senha incorreta") ||
		lower.includes("usuario ou senha") ||
		lower.startsWith("error|auth") ||
		lower.startsWith("auth_error")
	);
};

export const makeCedroClient = Effect.gen(function* () {
	const tcp = yield* TcpStream;
	const config = yield* CedroConfig;

	const formatAuthCommand = (
		config: CedroConfigShape,
	): Result.Result<string, CedroConfigurationError> =>
		Result.map(
			validateCedroCredentials(config),
			() => `${config.magicToken}\n${config.username}\n${config.password}\n`,
		);

	const authenticate = () =>
		Effect.gen(function* () {
			const payload = yield* Effect.fromResult(formatAuthCommand(config));
			yield* tcp.sendText(payload);
		});

	const formatSubCommand = (
		tickers: ReadonlyArray<string>,
	): Result.Result<string, CedroProtocolError> => {
		if (tickers.length === 0) {
			return Result.fail(
				new CedroProtocolError({ message: "At least one ticker is required" }),
			);
		}
		return Result.succeed(`SUB|${tickers.join(",")}\n`);
	};

	const subscribe = (tickers: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			const payload = yield* Effect.fromResult(formatSubCommand(tickers));
			yield* tcp.sendText(payload);
		});

	const subscribeTrades = (tickers: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			if (tickers.length === 0) {
				return yield* Effect.fail(
					new CedroProtocolError({
						message: "At least one ticker is required for trade subscription",
					}),
				);
			}
			let payload = "";
			for (const ticker of tickers) {
				const cmd = yield* Effect.fromResult(formatTradeSubCommand(ticker));
				payload += cmd;
			}
			yield* tcp.sendText(payload);
		});

	return CedroClient.of({
		authenticate,
		subscribe,
		subscribeTrades,
		rawStream: tcp.stream,
		lines: frameLines(tcp.stream),
	});
});

export const CedroConfigLive = (config: CedroConfigShape) =>
	Layer.succeed(CedroConfig, config);

export const CedroClientLive = Layer.effect(CedroClient, makeCedroClient);
