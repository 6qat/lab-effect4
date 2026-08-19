import { Effect, Random, Console, Option, pipe } from "effect";

// Function to validate weight and return an Option
const validateWeightOption = (
	weight: number,
): Effect.Effect<Option.Option<number>> => {
	if (weight >= 0) {
		// Return Some if the weight is valid
		return Effect.succeed(Option.some(weight));
	}
	// Return None if the weight is invalid
	return Effect.succeed(Option.none());
};

// Function to validate weight or fail with an error
const validateWeightOrFail = (
	weight: number,
): Effect.Effect<number, string> => {
	if (weight >= 0) {
		// Return the weight if valid
		return Effect.succeed(weight);
	}
	// Fail with an error if invalid
	return Effect.fail(`negative input: ${weight}`);
};

// Modern, recommended approach using Generators
const flipTheCoin = Effect.gen(function* () {
	const isHeads = yield* Random.nextBoolean;

	if (isHeads) {
		yield* Console.log("Heads");
	} else {
		yield* Console.log("Tails");
	}
});

Effect.runFork(flipTheCoin);

const flipTheCoin2 = pipe(
	Random.nextBoolean,
	Effect.flatMap((isHeads) =>
		isHeads ? Console.log("Heads") : Console.log("Tails"),
	),
);

Effect.runFork(flipTheCoin2);
