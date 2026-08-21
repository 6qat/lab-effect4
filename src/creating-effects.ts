import * as NodeFS from "node:fs";
import * as NodeFS2 from "node:fs/promises";
import { $ } from "bun";

import { Data, Effect, Fiber } from "effect";

class ReadFileError extends Data.TaggedError("ReadFileError")<{
  readonly filename: string;
  readonly cause: unknown;
}> {}

const _readFile = (filename: string) =>
  Effect.callback<Buffer, ReadFileError>((resume) => {
    NodeFS.readFile(filename, (error, data) => {
      if (error) {
        // Resume with a failed Effect if an error occurs
        resume(Effect.fail(new ReadFileError({ filename, cause: error })));
      } else {
        // Resume with a succeeded Effect if successful
        resume(Effect.succeed(data));
      }
    });
  });

export const _readFile2 = (filename: string) =>
  Effect.tryPromise({
    // 1. Effect passes its fiber AbortSignal directly to Node
    try: (signal) => NodeFS2.readFile(filename, { signal }),
    // 2. Maps any thrown error into a typed, tagged error
    catch: (cause) => new ReadFileError({ filename, cause }),
  });

export const _readFileBun = (filename: string) =>
  Effect.tryPromise({
    try: () => Bun.file(filename).text(),
    catch: (cause) => new ReadFileError({ filename, cause }),
  });

//      ┌─── Effect<Buffer, Error, never>
//      ▼
const _p1 = _readFileBun("example.txt");

// =========================================================================
// =========================================================================

class WriteFileError extends Data.TaggedError("WriteFileError")<{
  readonly filename?: string;
  readonly cause?: unknown;
}> {}

// Bun.write accepts more than plain strings; widening the input type lets
// callers pass binary data or Blobs directly. We define our own runtime-neutral
// TypedArray union instead of exposing NodeJS.TypedArray in this Bun helper.
type TypedArray =
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigUint64Array
  | BigInt64Array
  | Float16Array
  | Float32Array
  | Float64Array;

type BunWritable = string | Blob | TypedArray | ArrayBufferLike;

const deleteFile = (filename: string) =>
  Effect.promise(() =>
    Bun.file(filename)
      .delete()
      .catch(() => undefined),
  );

const writeTemporaryFile = (filename: string, content: BunWritable) => {
  const write = Effect.callback<number, WriteFileError>((resume) => {
    let promise: Promise<number>;

    try {
      promise = Bun.write(filename, content);
    } catch (cause) {
      resume(Effect.fail(new WriteFileError({ filename, cause })));
      return;
    }

    promise.then(
      (bytesWritten) => resume(Effect.succeed(bytesWritten)),
      (cause) => resume(Effect.fail(new WriteFileError({ filename, cause }))),
    );

    // Bun.write cannot be aborted. If interrupted, wait for it to settle
    // before deleting the temporary file to avoid racing the write operation.
    return Effect.promise(async () => {
      await promise.catch(() => {});
      await Bun.file(filename)
        .delete()
        .catch(() => {});
    });
  });

  // Also clean up after an ordinary write failure. The interruption finalizer
  // above handles interruption while the write is still pending.
  return write.pipe(Effect.tapError(() => deleteFile(filename)));
};

export const writeFileBun = (filename: string, content: BunWritable) =>
  Effect.suspend(() => {
    const tmpFilename = `${filename}.${crypto.randomUUID()}.tmp`;

    const program = Effect.gen(function* () {
      const bytesWritten = yield* writeTemporaryFile(tmpFilename, content);

      yield* Effect.tryPromise({
        try: async () => {
          await $`mv ${tmpFilename} ${filename}`;
        },
        catch: (cause) => new WriteFileError({ filename, cause }),
      });

      return bytesWritten;
    });

    // Handles move failure or interruption during the move. After a
    // successful move, the temporary path no longer exists, so this is safe.
    return program.pipe(Effect.ensuring(deleteFile(tmpFilename)));
  });

// Simulates a long-running operation to write to a file
const writeFileWithCleanup = (filename: string, data: string) =>
  Effect.callback<void, Error>((resume) => {
    const writeStream = NodeFS.createWriteStream(filename);

    // When the stream is finished, resume with success
    writeStream.on("finish", () => resume(Effect.void));
    // In case of an error during writing, resume with failure
    writeStream.on("error", (err) => resume(Effect.fail(err)));

    // Start writing data to the file
    writeStream.write(data);
    // Properly close the stream to trigger 'finish' event
    writeStream.end();

    // Handle interruption by returning a cleanup effect
    return Effect.sync(() => {
      console.log(`Cleaning up ${filename}`);
      writeStream.destroy();
      NodeFS.unlinkSync(filename);
    });
  });

const _p2 = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(
    writeFileWithCleanup("example.txt", "Some long data..."),
  );
  // Simulate interrupting the fiber after 1 second
  yield* Effect.sleep("1 second");
  yield* Fiber.interrupt(fiber); // This will trigger the cleanup
  yield* Fiber.join(fiber);
});

// =========================================================================
// writeFileWithCleanupPromise: Idiomatic Promise-based version using
// node:fs/promises, Effect.tryPromise with AbortSignal, and Effect.onInterrupt
// for cleanup upon interruption.
// =========================================================================

export const writeFileWithCleanupPromise = (filename: string, data: string) =>
  Effect.tryPromise({
    // NodeFS2.writeFile natively accepts an AbortSignal, canceling the I/O if the fiber is interrupted
    try: (signal) => NodeFS2.writeFile(filename, data, { signal }),
    catch: (cause) => new WriteFileError({ cause }),
  }).pipe(
    // Runs when the fiber is interrupted, removing any partially-written file
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        console.log(`Cleaning up ${filename}`);
        await NodeFS2.unlink(filename).catch(() => {});
      }),
    ),
  );

export const _p2Promise = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(
    writeFileWithCleanupPromise("example.txt", "Some long data..."),
  );
  yield* Effect.sleep("1 second");
  yield* Fiber.interrupt(fiber); // Triggers the onInterrupt cleanup
  yield* Fiber.join(fiber);
});

// ===========================================================================

const _writeFileWithCleanupNoDie = (filename: string, data: string) =>
  Effect.callback<void, WriteFileError>((resume) => {
    try {
      const writeStream = NodeFS.createWriteStream(filename);

      // When the stream is finished, resume with success
      writeStream.on("finish", () => resume(Effect.void));
      // In case of an error during writing, resume with failure
      writeStream.on("error", (err) =>
        resume(new WriteFileError({ cause: err })),
      );

      // Start writing data to the file
      writeStream.write(data);
      // Properly close the stream to trigger 'finish' event
      writeStream.end();

      // Handle interruption by returning a cleanup effect
      // Already interrupted, cannot call resume() here
      return Effect.sync(() => {
        console.log(`Cleaning up ${filename}`);
        writeStream.destroy();
        NodeFS.unlinkSync(filename);
      });
    } catch (err) {
      // Safely routes synchronous throws to the typed error channel
      resume(new WriteFileError({ cause: err }));
    }
  });

// =========================================================================

/**
The Sequence Matters
When you call Fiber.interrupt(fiber):

- Effect runtime fires the abort signal
- Abort listener runs (your signal.addEventListener callback)
- If callback calls resume(): Operation completes, no interruption
- If callback doesn't call resume(): Fiber gets interrupted
- Return Effect cleanup runs

 */

// Tagged error for interruption — preserves type safety in the failure channel
class InterruptedError extends Data.TaggedError("InterruptedError")<{
  readonly cause?: Error;
}> {}

// A task that supports interruption using AbortSignal
const interruptibleTask = Effect.callback<void, InterruptedError>(
  (resume, signal) => {
    // Handle interruption
    signal.addEventListener("abort", () => {
      console.log("Abort signal received");
      clearTimeout(timeoutId);
      resume(
        Effect.fail(
          new InterruptedError({
            cause: new Error("Operation was interrupted"),
          }),
        ),
      );
    });

    // Simulate a long-running task
    const timeoutId = setTimeout(() => {
      console.log("Operation completed");
      resume(Effect.void);
    }, 2000);
  },
);

const _p3 = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(interruptibleTask);
  // Simulate interrupting the fiber after 1 second
  yield* Effect.sleep("1 second");
  yield* Fiber.interrupt(fiber);
  yield* Fiber.join(fiber);
});

// =========================================================================

class DivisionByZeroError extends Data.TaggedError("DivisionByZeroError")<{
  readonly cause?: Error;
}> {}

/*
   Without suspend, TypeScript infers a union of two Effect types:

   Inferred type:
     (a: number, b: number) =>
       Effect<never, DivisionByZeroError, never> | Effect<number, never, never>
*/
const _withoutSuspend = (a: number, b: number) =>
  b === 0 ? Effect.fail(new DivisionByZeroError({})) : Effect.succeed(a / b);

/*
   Using suspend to unify return types.

   Inferred type:
     (a: number, b: number) => Effect<number, DivisionByZeroError, never>
*/
const _withSuspend = (a: number, b: number) =>
  Effect.suspend(() =>
    b === 0 ? Effect.fail(new DivisionByZeroError({})) : Effect.succeed(a / b),
  );

// =========================================================================

Effect.runPromise(_p1).then((x) => console.log(x));
