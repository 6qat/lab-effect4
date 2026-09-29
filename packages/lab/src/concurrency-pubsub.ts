import { Console, Effect, Fiber, PubSub, Stream } from "effect";

const _program = Effect.scoped(
	Effect.gen(function* () {
		const pubsub = yield* PubSub.bounded<string>(2);

		// Creates a dropping PubSub with a capacity of 2
		const _droppingPubSub = PubSub.dropping<string>(2);

		// Creates a sliding PubSub with a capacity of 2
		const _slidingPubSub = PubSub.sliding<string>(2);

		// Creates an unbounded PubSub with unlimited capacity
		const _unboundedPubSub = PubSub.unbounded<string>();

		// Two subscribers
		const sub1 = yield* PubSub.subscribe(pubsub);
		const sub2 = yield* PubSub.subscribe(pubsub);

		// Publish a message to the pubsub
		yield* PubSub.publish(pubsub, "Hello from a PubSub!");

		// Each subscriber receives the message
		console.log(`Subscriber 1: ${yield* PubSub.take(sub1)}`);
		console.log(`Subscriber 2: ${yield* PubSub.take(sub2)}`);
	}),
);

// Effect.runFork(program);
// await new Promise(() => {
//   return 0;
// });
// await Effect.runPromise(program).catch(console.error);
/*
Output:
Subscriber 1: Hello from a PubSub!
Subscriber 2: Hello from a PubSub!
*/

const _program2 = Effect.scoped(
	Effect.gen(function* () {
		const pubsub = yield* PubSub.unbounded<string>();

		// Subscribe in the main fiber BEFORE forking — the subscription is
		// registered synchronously, so no messages published after this line
		// can be missed regardless of when the fork actually runs.
		const subscription = yield* PubSub.subscribe(pubsub);

		// Fork to consume exactly 2 messages from the subscription queue
		const fiber = yield* Effect.forkChild(
			Effect.gen(function* () {
				console.log(yield* PubSub.take(subscription));
				console.log(yield* PubSub.take(subscription));
			}),
		);

		yield* PubSub.publish(pubsub, "hello");
		yield* PubSub.publish(pubsub, "world");

		yield* Fiber.join(fiber);
	}),
);

// Effect.runPromise(program2).catch(console.error);

// =========================================================================
// program3: Converting a PubSub to a Stream, producing and consuming in
// separate fibers. No Effect.scoped needed here because Stream automatically
// manages its own subscription scope during execution.
// =========================================================================

const program3 = Effect.gen(function* () {
	const pubsub = yield* PubSub.unbounded<string>();

	// Create a stream from the PubSub subscription and fork a consumer fiber.
	// Stream.fromPubSub automatically handles subscription and cleanup.
	const consumerFiber = yield* Stream.fromPubSub(pubsub).pipe(
		Stream.take(3),
		Stream.runForEach((msg) => Console.log(`Stream consumer got: ${msg}`)),
		Effect.forkChild,
	);

	// Fork a producer fiber that publishes messages over time
	const producerFiber = yield* Effect.gen(function* () {
		const messages = ["message 1", "message 2", "message 3"];
		for (const msg of messages) {
			yield* Effect.sleep("100 millis");
			console.log(`Producer sending: ${msg}`);
			yield* PubSub.publish(pubsub, msg);
		}
	}).pipe(Effect.forkChild);

	// Wait for both the producer and consumer fibers to complete
	yield* Fiber.joinAll([producerFiber, consumerFiber]);
});

Effect.runPromise(program3).catch(console.error);
