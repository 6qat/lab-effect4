import { Console, Data, Effect, Random } from "effect";

const result3 = Effect.forEach([1, 2, 3, 4, 5], (n, index) =>
	Console.log(`Currently at index ${index}`).pipe(Effect.as(n * 2)),
);

await Effect.runPromise(result3).then((x) => console.log("Value 3: ", x));

const result4 = // This is different - operates on a single Effect containing an array
	Effect.succeed([1, 2, 3, 4, 5]).pipe(
		Effect.map((array) => array.map((n) => n * 2)),
	);

await Effect.runPromise(result4).then((x) => console.log("Value 4: ", x));

const structOfEffects = {
	a: Effect.succeed(42).pipe(Effect.tap(Console.log)),
	b: Effect.succeed("Hello").pipe(Effect.tap(Console.log)),
};

//      ┌─── Effect<{ a: number; b: string; }, never, never>
//      ▼
const resultsAsStruct = Effect.all(structOfEffects);

await Effect.runPromise(resultsAsStruct).then((x) =>
	console.log("Structure: ", x),
);

const recordOfEffects: Record<string, Effect.Effect<number>> = {
	key1: Effect.succeed(1).pipe(Effect.tap(Console.log)),
	key2: Effect.succeed(2).pipe(Effect.tap(Console.log)),
};

//      ┌─── Effect<{ [x: string]: number; }, never, never>
//      ▼
const resultsAsRecord = Effect.all(recordOfEffects);

await Effect.runPromise(resultsAsRecord).then((x) =>
	console.log("Record: ", x),
);

// ====================================================================

// biome-ignore lint/complexity/noBannedTypes: explanation
class HttpError extends Data.TaggedError("HttpError")<{}> {}

//      ┌─── Effect<string, HttpError, never>
//      ▼
const program5 = Effect.gen(function* () {
	// Generate a random number between 0 and 1
	const n = yield* Random.next;

	// Simulate an HTTP error
	if (n < 0.5) {
		return yield* new HttpError();
	}

	return "some result";
});

await Effect.runPromise(program5).then(console.log);
