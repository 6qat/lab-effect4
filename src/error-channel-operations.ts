import { Data, Effect, pipe, Random } from "effect";

class MessageError extends Data.TaggedError("MessageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{
  readonly reason: "unauthorized";
}> {}

class NegativeRandomError extends Data.TaggedError("NegativeRandomError")<{
  readonly message: string;
}> {}

//      ┌─── Effect<number, string, never>
//      ▼
const simulatedTask = Effect.fail("Oh no!").pipe(Effect.as(1));

//      ┌─── Effect<number, MessageError, never>
//      ▼
const _mapped = Effect.mapError(
  simulatedTask,
  (message) => new MessageError({ message }),
);

//      ┌─── Effect<boolean, MessageError, never>
//      ▼
const _modified = Effect.mapBoth(simulatedTask, {
  onFailure: (message) => new MessageError({ message }),
  onSuccess: (n) => n > 0,
});

// Fail with a custom error if predicate is false
const _task1 = Effect.filterOrFail(
  Random.nextBetween(-1, 1),
  (n) => n >= 0,
  () => "random number is negative",
);

// Fail with a tagged error if the predicate is false
const _task2 = Effect.filterOrFail(
  Random.nextBetween(-1, 1),
  (n) => n >= 0,
  () => new NegativeRandomError({ message: "random number is negative" }),
);

// The v4 equivalent of filterOrDieMessage is also filterOrFail with a
// specific error value.
const _task3 = Effect.filterOrFail(
  Random.nextBetween(-1, 1),
  (n) => n >= 0,
  () => new NegativeRandomError({ message: "random number is negative" }),
);

// Run an alternative effect if predicate is false
const _task4 = Effect.filterOrElse(
  Random.nextBetween(-1, 1),
  (n) => n >= 0,
  () => _task3,
);

// ==========================================================================

// Define a user interface
interface User {
  readonly name: string;
}

// Simulate an asynchronous authentication function
declare const auth: () => Promise<User | null>;

const _program = pipe(
  Effect.promise(() => auth()),
  // Use filterOrFail with a custom type guard to ensure user is not null
  Effect.filterOrFail(
    (user): user is User => user !== null, // Type guard
    () => new UnauthorizedError({ reason: "unauthorized" }),
  ),
  // 'user' now has the type `User` (not `User | null`)
  Effect.map((user) => user.name),
);

// Custom type guard
function _isUser(obj: any): obj is User {
  return obj && typeof obj.id === "number" && typeof obj.name === "string";
}
