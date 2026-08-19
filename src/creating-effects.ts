import * as NodeFS from "node:fs";
import { Data, Effect, Fiber } from "effect";

const readFile = (filename: string) =>
  Effect.callback<Buffer, Error>((resume) => {
    NodeFS.readFile(filename, (error, data) => {
      if (error) {
        // Resume with a failed Effect if an error occurs
        resume(Effect.fail(error));
      } else {
        // Resume with a succeeded Effect if successful
        resume(Effect.succeed(data));
      }
    });
  });

//      ┌─── Effect<Buffer, Error, never>
//      ▼
const _p1 = readFile("example.txt");

// =========================================================================

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

// ===========================================================================

class WriteFileError extends Data.TaggedError("WriteFileError")<{
  readonly cause?: unknown;
}> {}

const _writeFileWithCleanupNoDie = (filename: string, data: string) =>
  Effect.callback<void, WriteFileError>((resume) => {
    try {
      const writeStream = NodeFS.createWriteStream(filename);

      // When the stream is finished, resume with success
      writeStream.on("finish", () => resume(Effect.void));
      // In case of an error during writing, resume with failure
      writeStream.on("error", (err) =>
        resume(Effect.fail(new WriteFileError({ cause: err }))),
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
      resume(Effect.fail(new WriteFileError({ cause: err })));
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

const p3 = Effect.gen(function* () {
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

Effect.runPromise(p3).then((x) => console.log(x));
