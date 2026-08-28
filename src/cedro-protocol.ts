import { Context, Data, Effect, Layer, Result, type Stream } from "effect";
import { TcpStream, type TcpStreamError } from "./tcp-connection.js";

export class CedroProtocolError extends Data.TaggedError("CedroProtocolError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export interface CedroConfigShape {
	readonly magicToken: string;
	readonly username: string;
	readonly password: string;
	readonly tickers: ReadonlyArray<string>;
}

export class CedroConfig extends Context.Service<
	CedroConfig,
	CedroConfigShape
>()("CedroConfig") {}

export interface CedroClientShape {
	readonly authenticate: () => Effect.Effect<
		void,
		TcpStreamError | CedroProtocolError
	>;
	readonly subscribe: (
		tickers: ReadonlyArray<string>,
	) => Effect.Effect<void, TcpStreamError | CedroProtocolError>;
	readonly rawStream: Stream.Stream<Uint8Array, TcpStreamError>;
}

export class CedroClient extends Context.Service<
	CedroClient,
	CedroClientShape
>()("CedroClient") {}

export const makeCedroClient = Effect.gen(function* () {
	const tcp = yield* TcpStream;
	const config = yield* CedroConfig;

	// 1. Função pura usando Result
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
		return Result.succeed(
			`AUTH|${config.magicToken}|${config.username}|${config.password}\n`,
		);
	};

	// 2. No CedroClient (I/O com Effect):
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
	});
});

export const CedroConfigLive = (config: CedroConfigShape) =>
	Layer.succeed(CedroConfig, config);

export const CedroClientLive = Layer.effect(CedroClient, makeCedroClient);
