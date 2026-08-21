import {
  Cause,
  Context,
  Data,
  Effect,
  Layer,
  MutableRef,
  Queue,
  Semaphore,
  Stream,
} from "effect";

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

export interface ConnectionConfigShape {
  readonly host: string;
  readonly port: number;
  readonly magicToken?: string;
  readonly username?: string;
  readonly password?: string;
  readonly tickers?: ReadonlyArray<string>;
}

export class ConnectionConfig extends Context.Service<
  ConnectionConfig,
  ConnectionConfigShape
>()("ConnectionConfig") {}

type ConnectionState =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Closed"; readonly error?: TcpStreamError };

type EndableSocket = {
  readonly end: () => void;
};

const unknownToMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const makeTcpStream = Effect.gen(function* () {
  const config = yield* ConnectionConfig;
  const incoming = yield* Queue.unbounded<
    Uint8Array,
    TcpStreamError | Cause.Done
  >();
  const writeLock = yield* Semaphore.make(1);

  const state = MutableRef.make<ConnectionState>({ _tag: "Open" });
  const hasEndedSocket = MutableRef.make(false);

  // Undefined error means graceful completion
  const finishIncoming = (error?: TcpStreamError): boolean => {
    const currentState = MutableRef.get(state);

    // Ensure completion happens only once
    if (currentState._tag === "Closed") {
      return false;
    }

    if (error) {
      MutableRef.set(state, { _tag: "Closed", error });
      Queue.failCauseUnsafe(incoming, Cause.fail(error));
    } else {
      MutableRef.set(state, { _tag: "Closed" });
      Queue.endUnsafe(incoming);
    }

    return true;
  };

  const endSocket = (socket: EndableSocket): void => {
    if (!MutableRef.compareAndSet(hasEndedSocket, false, true)) {
      return;
    }

    try {
      socket.end();
    } catch {
      // Closing is idempotent and best-effort; a prior socket failure is
      // already represented by the incoming stream's error channel.
    }
  };

  const connect = Effect.tryPromise<Bun.Socket<undefined>, TcpStreamError>({
    try: () =>
      Bun.connect<undefined>({
        hostname: config.host,
        port: config.port,
        socket: {
          binaryType: "uint8array",
          data(_socket, data) {
            Queue.offerUnsafe(incoming, data);
          },
          error(socket, cause) {
            const error = new TcpStreamError({
              operation: "read",
              message: `Socket error: ${unknownToMessage(cause)}`,
              cause,
            });

            finishIncoming(error);
            endSocket(socket);
          },
          close() {
            MutableRef.set(hasEndedSocket, true);
            finishIncoming();
          },
        },
      }),
    catch: (cause) =>
      new TcpStreamError({
        operation: "connect",
        message: `Connection failed: ${unknownToMessage(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.timeout("3 seconds"),
    Effect.mapError((cause) =>
      cause instanceof TcpStreamError
        ? cause
        : new TcpStreamError({
            operation: "connect",
            message: "Connection timeout",
            cause,
          }),
    ),
  );

  const socket = yield* Effect.acquireRelease(connect, (socket) =>
    Effect.sync(() => {
      finishIncoming();
      endSocket(socket);
    }),
  );

  const failConnection = (error: TcpStreamError): Effect.Effect<void> =>
    Effect.sync(() => {
      finishIncoming(error);
      endSocket(socket);
    });

  const send = (data: Uint8Array): Effect.Effect<void, TcpStreamError> =>
    Semaphore.withPermits(
      writeLock,
      1,
    )(
      Effect.gen(function* () {
        const currentState = MutableRef.get(state);
        if (currentState._tag === "Closed") {
          return yield* currentState.error ??
            new TcpStreamError({
              operation: "write",
              message: "Connection is closed",
            });
        }

        const bytesWritten = yield* Effect.try({
          try: () => socket.write(data),
          catch: (cause) =>
            new TcpStreamError({
              operation: "write",
              message: `Socket write failed: ${unknownToMessage(cause)}`,
              cause,
            }),
        });

        if (bytesWritten !== data.byteLength) {
          return yield* new TcpStreamError({
            operation: "write",
            message: `Partial write: wrote ${bytesWritten} of ${data.byteLength} bytes`,
          });
        }
      }).pipe(Effect.tapError(failConnection)),
    );

  return TcpStream.of({
    stream: Stream.fromQueue(incoming),
    send,
    sendText: (data) => send(new TextEncoder().encode(data)),
    close: Effect.sync(() => {
      finishIncoming();
      endSocket(socket);
    }),
  });
});

export const TcpStreamLive = () => Layer.effect(TcpStream, makeTcpStream);

export const ConnectionConfigLive = (
  host: string,
  port: number,
  tickers: ReadonlyArray<string>,
  magicToken: string,
  username: string,
  password: string,
) =>
  Layer.succeed(ConnectionConfig, {
    host,
    port,
    tickers,
    magicToken,
    username,
    password,
  });
