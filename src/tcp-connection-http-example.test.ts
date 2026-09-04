import { describe, expect, it } from "bun:test";
import { Effect, Exit, Result } from "effect";
import { TcpStreamBunLive } from "./tcp-connection-bun.js";
import {
	executeHttpRequest,
	makeConnectionConfig,
	parseCliArgs,
	parseCliUrl,
} from "./tcp-connection-http-example.js";
import { TcpStreamNodejsLive } from "./tcp-connection-nodejs.js";
import { TcpStreamPlatformLive } from "./tcp-connection-platform.js";

describe("tcp-connection-http-example CLI argument parsing", () => {
	it("parses positional URL and defaults engine to bun", () => {
		const result = parseCliArgs(["https://example.com/test"]);
		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isSuccess(result)) {
			expect(result.success.engine).toBe("bun");
			expect(result.success.url.href).toBe("https://example.com/test");
		}
	});

	it("parses equal-separated --engine=<choice> for all supported engines", () => {
		for (const engine of ["bun", "nodejs", "platform"] as const) {
			const result = parseCliArgs([
				`--engine=${engine}`,
				"https://example.com/",
			]);
			expect(Result.isSuccess(result)).toBe(true);
			if (Result.isSuccess(result)) {
				expect(result.success.engine).toBe(engine);
				expect(result.success.url.href).toBe("https://example.com/");
			}
		}
	});

	it("parses space-separated --engine <choice> for all supported engines", () => {
		for (const engine of ["bun", "nodejs", "platform"] as const) {
			const result = parseCliArgs([
				"--engine",
				engine,
				"https://example.com/api",
			]);
			expect(Result.isSuccess(result)).toBe(true);
			if (Result.isSuccess(result)) {
				expect(result.success.engine).toBe(engine);
				expect(result.success.url.href).toBe("https://example.com/api");
			}
		}
	});

	it("parses short option -e <choice> and -e=<choice>", () => {
		const res1 = parseCliArgs(["-e", "nodejs", "http://localhost:8080"]);
		expect(Result.isSuccess(res1)).toBe(true);
		if (Result.isSuccess(res1)) {
			expect(res1.success.engine).toBe("nodejs");
			expect(res1.success.url.href).toBe("http://localhost:8080/");
		}

		const res2 = parseCliArgs(["-e=platform", "http://localhost:8080"]);
		expect(Result.isSuccess(res2)).toBe(true);
		if (Result.isSuccess(res2)) {
			expect(res2.success.engine).toBe("platform");
		}
	});

	it("supports URL before --engine flag", () => {
		const result = parseCliArgs(["https://example.com", "--engine", "nodejs"]);
		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isSuccess(result)) {
			expect(result.success.engine).toBe("nodejs");
			expect(result.success.url.href).toBe("https://example.com/");
		}
	});

	it("fails with UnsupportedEngineError on unknown engine", () => {
		const result = parseCliArgs(["--engine=deno", "https://example.com"]);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure._tag).toBe("UnsupportedEngineError");
		}
	});

	it("fails with UnsupportedEngineError on missing flag value", () => {
		const result = parseCliArgs(["--engine"]);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure._tag).toBe("UnsupportedEngineError");
		}
	});

	it("fails with MissingCliArgError when URL is omitted", () => {
		const result = parseCliArgs(["--engine", "bun"]);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure._tag).toBe("MissingCliArgError");
		}
	});

	it("fails with UnsupportedProtocolError on non-http(s) scheme", () => {
		const result = parseCliArgs(["ftp://files.example.com/doc"]);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure._tag).toBe("UnsupportedProtocolError");
		}
	});

	it("fails with InvalidUrlError on malformed URL string", () => {
		const result = parseCliArgs(["not-a-valid-url"]);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure._tag).toBe("InvalidUrlError");
		}
	});

	it("backward-compatible parseCliUrl helper", () => {
		expect(Result.isFailure(parseCliUrl(undefined))).toBe(true);
		expect(Result.isFailure(parseCliUrl("invalid"))).toBe(true);
		expect(Result.isSuccess(parseCliUrl("https://example.com"))).toBe(true);
	});
});

describe("tcp-connection-http-example execution across all 3 engines", () => {
	const httpResponseRaw =
		"HTTP/1.1 200 OK\r\n" +
		"Content-Type: text/plain\r\n" +
		"Content-Length: 13\r\n" +
		"Connection: close\r\n" +
		"\r\n" +
		"Hello, World!";

	const setupEchoHttpServer = (port: number) => {
		return Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: {
				data(socket) {
					socket.write(httpResponseRaw);
					socket.end();
				},
			},
		});
	};

	it("executes HTTP request using Bun engine", async () => {
		const port = 59401;
		const server = setupEchoHttpServer(port);
		try {
			const url = new URL(`http://127.0.0.1:${port}/test-bun`);
			const config = makeConnectionConfig(url);
			const program = executeHttpRequest(url).pipe(
				Effect.provide(TcpStreamBunLive(config)),
			);
			const exit = await Effect.runPromiseExit(program);
			expect(Exit.isSuccess(exit)).toBe(true);
			if (Exit.isSuccess(exit)) {
				expect(exit.value).toContain("Hello, World!");
				expect(exit.value).toContain("HTTP/1.1 200 OK");
			}
		} finally {
			server.stop(true);
		}
	});

	it("executes HTTP request using Nodejs engine", async () => {
		const port = 59402;
		const server = setupEchoHttpServer(port);
		try {
			const url = new URL(`http://127.0.0.1:${port}/test-nodejs`);
			const config = makeConnectionConfig(url);
			const program = executeHttpRequest(url).pipe(
				Effect.provide(TcpStreamNodejsLive(config)),
			);
			const exit = await Effect.runPromiseExit(program);
			expect(Exit.isSuccess(exit)).toBe(true);
			if (Exit.isSuccess(exit)) {
				expect(exit.value).toContain("Hello, World!");
				expect(exit.value).toContain("HTTP/1.1 200 OK");
			}
		} finally {
			server.stop(true);
		}
	});

	it("executes HTTP request using Platform engine", async () => {
		const port = 59403;
		const server = setupEchoHttpServer(port);
		try {
			const url = new URL(`http://127.0.0.1:${port}/test-platform`);
			const config = makeConnectionConfig(url);
			const program = executeHttpRequest(url).pipe(
				Effect.provide(TcpStreamPlatformLive(config)),
			);
			const exit = await Effect.runPromiseExit(program);
			expect(Exit.isSuccess(exit)).toBe(true);
			if (Exit.isSuccess(exit)) {
				expect(exit.value).toContain("Hello, World!");
				expect(exit.value).toContain("HTTP/1.1 200 OK");
			}
		} finally {
			server.stop(true);
		}
	});
});
