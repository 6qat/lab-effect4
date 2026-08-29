import { Console, Effect, Option, pipe, Random, Result } from "effect";

// Function to validate weight and return an Option
const _validateWeightOption = (weight: number): Option.Option<number> =>
	// Some if the weight is valid, None otherwise
	weight >= 0 ? Option.some(weight) : Option.none();

// Function to validate weight or fail with an error
const _validateWeightOrFail = (
	weight: number,
): Result.Result<number, string> => {
	if (weight >= 0) {
		// Return the weight if valid
		return Result.succeed(weight);
	}
	// Fail with an error if invalid
	return Result.fail(`negative input: ${weight}`);
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
