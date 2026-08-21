import { Console, Effect, Fiber, Queue } from "effect";

// Creating a bounded queue with a capacity of 100
const _boundedQueue = Queue.bounded<number>(100);

// Creating a dropping queue with a capacity of 100
const _droppingQueue = Queue.dropping<number>(100);

// Creating a sliding queue with a capacity of 100
const _slidingQueue = Queue.sliding<number>(100);

// Creates an unbounded queue without a capacity limit
const _unboundedQueue = Queue.unbounded<number>();

/**
 In Effect there are three distinct completion states—success, failure, and interruption—and defects are just a special kind of failure:

Failure (typed error) – produced via Effect.fail, propagates as the declared error type.

Defect – produced by Effect.die, unexpected throws, or defects raised by the runtime. They bypass the typed error channel but still complete the fiber in a failed state. Finalizers run, the fiber stops, and whoever joins the fiber receives that defect wrapped in the Cause.

Interruption – triggered externally (e.g., Fiber.interrupt, scope shutdown). The fiber completes with an interruption cause, not a failure.

So defects do not interrupt the fiber. Instead, the fiber fails with an unchecked cause. When another fiber calls Fiber.join, it doesn’t become interrupted; it simply receives the same defect cause the child fiber produced. You can react to that cause (log it, convert it, etc.) just like any other failure.

 */

const _program1 = Effect.gen(function* () {
  const queue = yield* Queue.bounded<number>(100);
  // Adds 1 to the queue
  yield* Queue.offer(queue, 1);
});

const _program2 = Effect.gen(function* () {
  const queue = yield* Queue.bounded<number>(1);

  // Fill the queue with one item
  yield* Queue.offer(queue, 1);

  // Attempting to add a second item will suspend as the queue is full
  const fiber = yield* Effect.forkChild(Queue.offer(queue, 2));

  // Empties the queue to make space
  yield* Queue.take(queue);

  // Joins the fiber, completing the suspended offer
  yield* Fiber.join(fiber);

  // the size of the queue after additions
  const size = yield* Queue.size(queue);
  yield* Effect.log(`Size: ${size}`);

  return yield* Queue.take(queue);
});

// Shutting down a Queue
const _program3 = Effect.gen(function* () {
  const queue = yield* Queue.bounded<number>(3);

  // Forks a fiber that waits to take an item from the queue
  const fiber = yield* Effect.forkChild(Queue.take(queue));

  // Shuts down the queue, interrupting the fiber
  yield* Queue.shutdown(queue);

  // Joins the interrupted fiber
  const _f = yield* Fiber.join(fiber);
});
// Effect.runPromiseExit(program3).then(console.log);

const _program4 = Effect.gen(function* () {
  const queue = yield* Queue.bounded<number>(3);

  // Forks a fiber to await queue shutdown and log a message
  const fiber1 = yield* Effect.forkChild(
    Queue.await(queue).pipe(Effect.andThen(Console.log("shutting down"))),
  );

  // Forks a fiber that waits to take an item from the queue
  const _fiber2 = yield* Effect.forkChild(Queue.take(queue));

  // Shuts down the queue, triggering the await in the fiber
  yield* Queue.shutdown(queue);

  yield* Fiber.join(fiber1);
  // yield* Fiber.join(fiber2);
});

Effect.runPromiseExit(_program2).then(console.log);
// BunRuntime.runMain(_program2);
// NodeRuntime.runMain(_program2);
