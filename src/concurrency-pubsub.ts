import { Console, Effect, Fiber, PubSub, Stream } from "effect";

const program = Effect.scoped(
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
await Effect.runPromise(program).catch(console.error);
/*
Output:
Subscriber 1: Hello from a PubSub!
Subscriber 2: Hello from a PubSub!
*/

const program2 = Effect.scoped(
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

Effect.runPromise(program2).catch(console.error);
