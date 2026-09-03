import { BunRuntime } from "@effect/platform-bun";
import { Console, Data, Effect, Layer, Result, Stream } from "effect";

import {
	ConnectionConfigLive,
	TcpStream,
	TcpStreamLive,
} from "./tcp-connection.js";

export class MissingCliArgError extends Data.TaggedError("MissingCliArgError")<{
	readonly message: string;
}> {}

export class UnsupportedProtocolError extends Data.TaggedError(
	"UnsupportedProtocolError",
)<{
	readonly protocol: string;
}> {}

export class InvalidUrlError extends Data.TaggedError("InvalidUrlError")<{
	readonly input: string;
	readonly cause?: unknown;
}> {}

export type CliUrlError =
	| MissingCliArgError
	| UnsupportedProtocolError
	| InvalidUrlError;

export const parseCliUrl = (
	input: string | undefined,
): Result.Result<URL, CliUrlError> => {
	if (input === undefined) {
		return Result.fail(
			new MissingCliArgError({
				message:
					"Usage: bun src/tcp-connection-http-example.ts <http-or-https-url>",
			}),
		);
	}

	try {
		const url = new URL(input);

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return Result.fail(
				new UnsupportedProtocolError({ protocol: url.protocol }),
			);
		}

		return Result.succeed(url);
	} catch (cause) {
		return Result.fail(new InvalidUrlError({ input, cause }));
	}
};

const parsedRequest = Effect.map(
	Effect.fromResult(parseCliUrl(Bun.argv[2])),
	(url) => {
		const isHttps = url.protocol === "https:";
		const port =
			url.port === "" ? (isHttps ? 443 : 80) : Number.parseInt(url.port, 10);
		return { url, isHttps, port };
	},
);

const requestProgram = Effect.gen(function* () {
	const { url, isHttps, port } = yield* parsedRequest;

	const requestTarget = `${url.pathname}${url.search}`;

	const request = [
		`GET ${requestTarget} HTTP/1.1`,
		`Host: ${url.host}`,
		"Connection: close",
		"User-Agent: effect-tcp-example/1.0",
		"Accept: */*",
		"",
		"",
	].join("\r\n");

	yield* Effect.gen(function* () {
		const tcp = yield* TcpStream;

		yield* tcp.sendText(request);

		// The server closes the connection because the request includes
		// `Connection: close`, which completes the response stream.
		const chunks = yield* Stream.runCollect(tcp.stream);

		// Decode incrementally so a multibyte UTF-8 character split across TCP
		// chunks is reconstructed correctly.
		const decoder = new TextDecoder();
		const response =
			chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
			decoder.decode();

		yield* Console.log(response);
	}).pipe(
		Effect.provide(
			TcpStreamLive().pipe(
				Layer.provide(
					ConnectionConfigLive({
						host: url.hostname,
						port,
						...(isHttps
							? {
									tls: {
										serverName: url.hostname,
										rejectUnauthorized: true,
										ALPNProtocols: "http/1.1",
									},
								}
							: {}),
					}),
				),
			),
		),
	);
});

const main = requestProgram.pipe(
	// Recover TCP errors with a friendly message (original behavior).
	Effect.catchTag("TcpStreamError", (error) =>
		Console.error(
			`TCP ${error.operation} error: ${error.message}`,
			error.cause,
		),
	),
	// Log CLI usage errors without clearing them, so runMain exits non-zero.
	Effect.tapError((error) => {
		switch (error._tag) {
			case "MissingCliArgError":
				return Console.error(error.message);
			case "UnsupportedProtocolError":
				return Console.error(
					`Unsupported protocol ${error.protocol}; expected http: or https:`,
				);
			case "InvalidUrlError":
				return Console.error(`Invalid HTTP(S) URL: ${error.input}`);
			case "ConnectionConfigError":
				return Console.error(`Connection config error: ${error.message}`);
		}
	}),
);

BunRuntime.runMain(main as Effect.Effect<void, unknown, never>);
