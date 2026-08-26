import { Context, Data, Effect, Layer, type Stream } from "effect";
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
	) => Effect.Effect<void, TcpStreamError>;
	readonly rawStream: Stream.Stream<Uint8Array, TcpStreamError>;
}

export class CedroClient extends Context.Service<
	CedroClient,
	CedroClientShape
>()("CedroClient") {}

export const makeCedroClient = Effect.gen(function* () {
	const tcp = yield* TcpStream;
	const config = yield* CedroConfig;

	const authenticate = () =>
		Effect.gen(function* () {
			if (!config.magicToken || !config.username || !config.password) {
				return yield* new CedroProtocolError({
					message: "Missing required Cedro credentials or magic token",
				});
			}

			// Format Cedro authentication command frame
			const authPayload = `AUTH|${config.magicToken}|${config.username}|${config.password}\n`;
			yield* tcp.sendText(authPayload);
		});

	const subscribe = (tickers: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			const subPayload = `SUB|${tickers.join(",")}\n`;
			yield* tcp.sendText(subPayload);
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
