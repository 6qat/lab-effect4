import { Clock, Effect, Random } from "effect";

//      ┌─── Effect<void, never, never>
//      ▼
const program1 = Effect.gen(function* () {
	const now = yield* Clock.currentTimeMillis;
	yield* Effect.log(`Application started at ${new Date(now)}`);
});

Effect.runPromise(program1);
// Output: Application started at <current time>

// =======================================================================

// A program that logs a random number
const program2 = Effect.gen(function* () {
	console.log(yield* Random.next);
});

Effect.runPromise(program2);
// Example Output: 0.23208633934454326 (varies each run)

// Override the Random service with a seeded generator
const override2 = program2.pipe(Random.withSeed("myseed"));

Effect.runPromise(override2);
// Output: 0.6862142528438508 (consistent output with the seed)

// =======================================================================

const _bytes = crypto.getRandomValues(new Uint8Array(32));
