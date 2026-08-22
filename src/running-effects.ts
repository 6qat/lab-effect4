import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Exit, Fiber } from "effect";

// =========================================================================
// Effect.runSync — runs an effect synchronously and returns the success value.
// Throws if the effect fails or is interrupted.
// =========================================================================

const syncProgram = Effect.succeed(42).pipe(Effect.tap(Console.log));

const syncResult = Effect.runSync(syncProgram);
console.log("runSync result:", syncResult);

// =========================================================================
// Effect.runSyncExit — runs synchronously but returns an Exit instead of
// throwing. The Exit captures success, failure, or interruption.
// =========================================================================

const failingProgram = Effect.fail("boom");

const syncExit = Effect.runSyncExit(failingProgram);
console.log("runSyncExit:", Exit.isFailure(syncExit) ? "Failure" : "Success");

// =========================================================================
// Effect.runPromise — runs the effect and returns a Promise that resolves
// with the success value or rejects with the failure.
// In this example we demonstrate it via BunRuntime.runMain, which provides
// platform-specific services, signal handling, and exit-code management.
// =========================================================================

const promiseProgram = Effect.succeed("hello").pipe(
	Effect.delay("100 millis"),
	Effect.tap(Console.log),
	Effect.tap((value) => Console.log("runPromise resolved:", value)),
);

BunRuntime.runMain(promiseProgram);

// =========================================================================
// Effect.runPromiseExit — runs the effect and returns a Promise of an Exit,
// so failures don't reject the promise.
// In this example we demonstrate it via BunRuntime.runMain, which observes
// the resulting Exit and logs its outcome.
// =========================================================================

BunRuntime.runMain(
	Effect.exit(failingProgram).pipe(
		Effect.tap((exit) =>
			Console.log(
				"runPromiseExit:",
				Exit.isSuccess(exit) ? "Success" : "Failure",
			),
		),
	),
);

// =========================================================================
// Effect.runFork — runs the effect in the background and returns a Fiber.
// The effect is not awaited; join the fiber to get its result.
// =========================================================================

const forkedProgram = Effect.succeed("background").pipe(
	Effect.delay("100 millis"),
	Effect.tap(Console.log),
);

const fiber = Effect.runFork(forkedProgram);

BunRuntime.runMain(
	Fiber.join(fiber).pipe(
		Effect.tap((value) => Console.log("runFork joined:", value)),
	),
);

// =========================================================================
// Effect.runCallback — runs the effect and invokes a callback with the
// resulting Exit, which captures success, failure, or interruption.
// =========================================================================

Effect.runCallback(Effect.succeed("callback"), {
	onExit: (exit) =>
		console.log(
			"runCallback:",
			Exit.isSuccess(exit) ? "Success" : "Failure",
			Exit.isSuccess(exit) ? exit.value : exit.cause,
		),
});

// =========================================================================
// Choosing the right runner
// =========================================================================
/*
  - runSync        : effect completes immediately, no async work. Throws on failure.
  - runSyncExit    : same as runSync but returns an Exit instead of throwing.
  - runPromise     : async effect, returns a Promise. Rejects on failure.
  - runPromiseExit : async effect, returns a Promise<Exit>. Never rejects.
  - runFork        : fire-and-forget async execution, returns a Fiber.
  - runCallback    : async execution with a single onExit callback receiving an Exit.
  - BunRuntime.runMain : runs an Effect as the process entrypoint with platform
                         services, signal handling, and exit-code management.
*/
