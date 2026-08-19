import { Deferred, Effect, Fiber } from "effect";

const _program1 = Effect.gen(function* () {
	const deferred = yield* Deferred.make<number, string>();

	// Complete the Deferred successfully
	yield* Deferred.succeed(deferred, 1);

	// Awaiting the Deferred to get its value
	const value = yield* Deferred.await(deferred);

	yield* Effect.log(value);
});

const _program2 = Effect.gen(function* () {
	const deferred = yield* Deferred.make<number, string>();

	// Attempt to fail the Deferred
	const firstAttempt = yield* Deferred.fail(deferred, "oh no!");

	// Attempt to succeed after it has already been completed
	const secondAttempt = yield* Deferred.succeed(deferred, 1);

	// Polling the Deferred to check if it's completed
	const _done1 = yield* Deferred.poll(deferred);

	const value = yield* Deferred.await(deferred);

	console.log(value);
	console.log([firstAttempt, secondAttempt]);

	// const _x = Effect.transposeOption(Option.some(1));
});

const program3 = Effect.gen(function* () {
	const deferred = yield* Deferred.make<string, string>();

	// Completes the Deferred with a value after a delay
	const taskA = Effect.gen(function* () {
		console.log("Starting task to complete the Deferred");
		yield* Effect.sleep("1 second");
		console.log("Completing the Deferred");
		return yield* Deferred.succeed(deferred, "hello world");
	});

	// Waits for the Deferred and prints the value
	const taskB = Effect.gen(function* () {
		console.log("Starting task to get the value from the Deferred");
		const value = yield* Deferred.await(deferred);
		console.log("Got the value from the Deferred");
		return value;
	});

	// Run both fibers concurrently
	const fiberA = yield* Effect.forkChild(taskA);
	const fiberB = yield* Effect.forkChild(taskB);

	// Wait for both fibers to complete
	const both = yield* Fiber.joinAll([fiberA, fiberB]);

	console.log(both);
});

Effect.runPromise(program3);
