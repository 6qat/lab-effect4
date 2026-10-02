import { Context, Data, Effect, Layer, Result, type Stream } from "effect";
import { frameLines } from "./line-framing.js";
import { TcpStream, type TcpStreamError } from "./tcp-connection.js";

export class CedroProtocolError extends Data.TaggedError("CedroProtocolError")<{
	readonly message: string;
	readonly cause?: unknown;
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

export interface CedroClientShape {
	/** Sends login fields in order; completion does not confirm server acceptance. */
	readonly authenticate: () => Effect.Effect<
		void,
		TcpStreamError | CedroProtocolError
	>;
	readonly subscribe: (
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

export const makeCedroClient = Effect.gen(function* () {
	const tcp = yield* TcpStream;
	const config = yield* CedroConfig;

	const formatAuthCommand = (
		config: CedroConfigShape,
	): Result.Result<string, CedroProtocolError> => {
		if (!config.magicToken || !config.username || !config.password) {
			return Result.fail(
				new CedroProtocolError({
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
				new CedroProtocolError({
					message: "Cedro login fields must not contain line breaks",
				}),
			);
		}
		return Result.succeed(
			`${config.magicToken}\n${config.username}\n${config.password}\n`,
		);
	};

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

	return CedroClient.of({
		authenticate,
		subscribe,
		rawStream: tcp.stream,
		lines: frameLines(tcp.stream),
	});
});

export const CedroConfigLive = (config: CedroConfigShape) =>
	Layer.succeed(CedroConfig, config);

export const CedroClientLive = Layer.effect(CedroClient, makeCedroClient);
