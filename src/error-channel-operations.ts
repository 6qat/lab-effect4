import { Data, Effect, pipe, Random, Result } from "effect";

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

class InvalidUserPayloadError extends Data.TaggedError(
	"InvalidUserPayloadError",
)<{
	readonly reason: string;
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
	readonly id: number;
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
function _isUser(obj: unknown): obj is User {
	if (typeof obj !== "object" || obj === null) {
		return false;
	}

	const record = obj as Record<string, unknown>;
	return typeof record.id === "number" && typeof record.name === "string";
}

const validateUser = (
	obj: unknown,
): Result.Result<User, UnauthorizedError | InvalidUserPayloadError> => {
	if (obj === null || obj === undefined) {
		return Result.fail(new UnauthorizedError({ reason: "unauthorized" }));
	}
	if (typeof obj !== "object") {
		return Result.fail(
			new InvalidUserPayloadError({ reason: "Expected object" }),
		);
	}
	const rec = obj as Record<string, unknown>;
	if (typeof rec.id !== "number" || typeof rec.name !== "string") {
		return Result.fail(
			new InvalidUserPayloadError({ reason: "Missing id or name" }),
		);
	}
	return Result.succeed({ id: rec.id, name: rec.name });
};

// No pipeline do Effect:
const _program2 = Effect.gen(function* () {
	const raw = yield* Effect.promise(() => auth());
	const user = yield* Effect.fromResult(validateUser(raw));
	return user.name;
});
