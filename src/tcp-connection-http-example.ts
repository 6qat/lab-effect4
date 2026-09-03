import { BunRuntime } from "@effect/platform-bun";
import { Console, Data, Effect, Result, Stream } from "effect";

import { TcpStreamBunLive } from "./tcp-connection-bun.js";
import {
	type ConnectionConfigShape,
	TcpStream,
} from "./tcp-connection-common.js";
import { TcpStreamNodeLive } from "./tcp-connection-nodejs.js";
import { TcpStreamPlatformLive } from "./tcp-connection-platform.js";

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

export class UnsupportedEngineError extends Data.TaggedError(
	"UnsupportedEngineError",
)<{
	readonly engine: string;
}> {}

export type CliUrlError =
	| MissingCliArgError
	| UnsupportedProtocolError
	| InvalidUrlError;

export type EngineChoice = "bun" | "nodejs" | "platform";

export interface ParsedCliArgs {
	readonly engine: EngineChoice;
	readonly url: URL;
}

/**
 * Parses command-line arguments to extract target URL and optional TCP engine.
 * Defaults to "bun" if --engine is omitted (Q1 -> Option A).
 */
export const parseCliArgs = (
	argv: string[],
): Result.Result<ParsedCliArgs, CliUrlError | UnsupportedEngineError> => {
	let rawEngine = "bun";
	let urlInput: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;

		if (arg.startsWith("--engine=")) {
			rawEngine = arg.slice("--engine=".length);
		} else if (arg === "-e" || arg === "--engine") {
			const next = argv[i + 1];
			if (next !== undefined) {
				rawEngine = next;
				i++;
			}
		} else if (!arg.startsWith("-")) {
			urlInput = arg;
		}
	}

	if (urlInput === undefined) {
		return Result.fail(
			new MissingCliArgError({
				message:
					"Usage: bun src/tcp-connection-http-example.ts [--engine=bun|nodejs|platform] <http-or-https-url>",
			}),
		);
	}

	if (
		rawEngine !== "bun" &&
		rawEngine !== "nodejs" &&
		rawEngine !== "platform"
	) {
		return Result.fail(
			new UnsupportedEngineError({
				engine: rawEngine,
			}),
		);
	}

	try {
		const url = new URL(urlInput);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return Result.fail(
				new UnsupportedProtocolError({ protocol: url.protocol }),
			);
		}

		return Result.succeed({
			engine: rawEngine as EngineChoice,
			url,
		});
	} catch (cause) {
		return Result.fail(new InvalidUrlError({ input: urlInput, cause }));
	}
};

/**
 * Backward-compatible helper for parsing just the URL.
 */
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

const parsedCli = Effect.fromResult(parseCliArgs(Bun.argv.slice(2)));
const parsedRequestUrl = Effect.map(parsedCli, (parsed) => parsed.url);

/**
 * Constructs a ConnectionConfigShape from a URL.
 */
const makeConnectionConfig = (url: URL): ConnectionConfigShape => {
	const isHttps = url.protocol === "https:";
	const port =
		url.port === "" ? (isHttps ? 443 : 80) : Number.parseInt(url.port, 10);

	return {
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
	};
};

/**
 * Shared HTTP GET request execution requiring a provided TcpStream (Q2 -> Option A).
 */
const executeHttpRequest = (url: URL) =>
	Effect.gen(function* () {
		const tcp = yield* TcpStream;
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
	});

/**
 * 1. Executes the HTTP request using Bun's native socket implementation (tcp-connection-bun.ts).
 */
export const requestProgramBun = Effect.gen(function* () {
	const url = yield* parsedRequestUrl;
	const config = makeConnectionConfig(url);
	yield* executeHttpRequest(url).pipe(Effect.provide(TcpStreamBunLive(config)));
});

/**
 * 2. Executes the HTTP request using Node.js net/tls implementation (tcp-connection-nodejs.ts).
 */
export const requestProgramNodejs = Effect.gen(function* () {
	const url = yield* parsedRequestUrl;
	const config = makeConnectionConfig(url);
	yield* executeHttpRequest(url).pipe(
		Effect.provide(TcpStreamNodeLive(config)),
	);
});

/**
 * 3. Executes the HTTP request using @effect/platform Socket.Socket.run implementation (tcp-connection-platform.ts).
 */
export const requestProgramPlatform = Effect.gen(function* () {
	const url = yield* parsedRequestUrl;
	const config = makeConnectionConfig(url);
	yield* executeHttpRequest(url).pipe(
		Effect.provide(TcpStreamPlatformLive(config)),
	);
});

/**
 * Dispatches to the chosen engine program based on CLI flags.
 */
const selectedProgram = Effect.gen(function* () {
	const { engine } = yield* parsedCli;
	switch (engine) {
		case "bun":
			return yield* requestProgramBun;
		case "nodejs":
			return yield* requestProgramNodejs;
		case "platform":
			return yield* requestProgramPlatform;
	}
});

const main = selectedProgram.pipe(
	// Recover TCP errors with a friendly message.
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
			case "UnsupportedEngineError":
				return Console.error(
					`Unsupported engine "${error.engine}". Supported engines: bun, nodejs, platform`,
				);
			case "ConnectionConfigError":
				return Console.error(`Connection config error: ${error.message}`);
		}
	}),
);

BunRuntime.runMain(main as Effect.Effect<void, unknown, never>);
