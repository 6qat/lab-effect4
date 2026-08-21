import { Console, Effect, Layer, Stream } from "effect";
import {
  ConnectionConfigLive,
  TcpStream,
  TcpStreamLive,
} from "./tcp-connection.js";

const getUrl = (): URL => {
  const input = Bun.argv[2];

  if (input === undefined) {
    console.error("Usage: bun src/tcp-connection-http-example.ts <http-url>");
    process.exit(1);
  }

  try {
    const url = new URL(input);

    if (url.protocol !== "http:") {
      console.error(
        `Unsupported protocol ${url.protocol}; this example supports only plain HTTP`,
      );
      process.exit(1);
    }

    return url;
  } catch {
    console.error(`Invalid HTTP URL: ${input}`);
    process.exit(1);
  }
};

const url = getUrl();
const port = url.port === "" ? 80 : Number.parseInt(url.port, 10);
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

const program = Effect.gen(function* () {
  const tcp = yield* TcpStream;

  yield* tcp.sendText(request);

  // The server closes the connection because the request includes
  // `Connection: close`, which completes the response stream.
  const chunks = yield* Stream.runCollect(tcp.stream);

  // Decode incrementally so a multi-byte UTF-8 character split across TCP
  // chunks is reconstructed correctly.
  const decoder = new TextDecoder();
  const response =
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
    decoder.decode();

  yield* Console.log(response);
}).pipe(
  Effect.catchTag("TcpStreamError", (error) =>
    Console.error(
      `TCP ${error.operation} error: ${error.message}`,
      error.cause,
    ),
  ),
);

const connectionConfigLayer = ConnectionConfigLive(
  url.hostname,
  port,
  [],
  "",
  "",
  "",
);

const tcpLayer = TcpStreamLive().pipe(Layer.provide(connectionConfigLayer));

const main = program.pipe(Effect.provide(tcpLayer));

Effect.runPromise(main).catch((cause) => {
  console.error("Unexpected failure:", cause);
});
