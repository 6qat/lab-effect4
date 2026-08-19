// biome-ignore lint/correctness/noUnusedImports: explanation
import { Console, Effect, type Option, pipe, Random } from "effect";

// This function returns : Effect.Effect<Option.Option<number>>
const validateWeightOption = (weight: number) =>
  // Conditionally execute the effect if the weight is non-negative
  Effect.when(
    Effect.succeed(weight),
    Effect.sync(() => weight >= 0),
  );

// Run with a valid weight
Effect.runPromise(validateWeightOption(100)).then(console.log);
/*
Output:
{
  _id: "Option",
  _tag: "Some",
  value: 100
}
*/

// Run with an invalid weight
Effect.runPromise(validateWeightOption(-5)).then(console.log);
/*
Output:
{
  _id: "Option",
  _tag: "None"
}
*/

// ---------------------------------------------------------------------------
// Additional flow-control examples

// when / unless
const logIfPositive = (n: number) =>
  Effect.when(
    Effect.sync(() => console.log(`positive ${n}`)),
    // Console.log(`positive ${n}`),
    Effect.sync(() => n > 0),
  );

const _logIfPositive2 = (n: number) =>
  Console.log(`positive ${n}`).pipe(Effect.when(Effect.sync(() => n > 0)));

const _logRandomly = () =>
  // Console.log('Random').pipe(Effect.whenEffect(Random.nextBoolean));
  // pipe(Console.log('Random'), Effect.whenEffect(Random.nextBoolean));
  Effect.when(Console.log("Random"), Random.nextBoolean);

const logIfZero = (n: number) =>
  Effect.when(
    Effect.sync(() => console.log(`zero ${n}`)),
    Effect.sync(() => n === 0),
  );

Effect.runPromise(logIfPositive(3));
Effect.runPromise(logIfPositive(-1)); // no-op
Effect.runPromise(logIfZero(0));
Effect.runPromise(logIfZero(2)); // no-op

// all with limited concurrency
const slow = (id: number, ms: number) =>
  Effect.sleep(`${ms} millis`).pipe(Effect.as(id));

Effect.runPromise(
  Effect.all(
    [slow(1, 200), slow(2, 200), slow(3, 200)],
    { concurrency: 2 }, // at most 2 in flight
  ),
).then((xs) => console.log("concurrency=2 ->", xs));

// all in validation mode: collect all failures instead of fail-fast
const effectsToValidate = [
  Effect.succeed("ok-1"),
  Effect.fail("err-1"),
  Effect.fail("err-2"),
] as const;

Effect.runPromise(
  Effect.all(effectsToValidate, { mode: "result" }).pipe(Effect.result),
).then((res) => console.log("validate mode ->", res));

const randomIntOption = Random.nextInt.pipe(Effect.when(Random.nextBoolean));

console.log("RANDOM", Effect.runSync(randomIntOption));

const iterableOfEffects: Iterable<Effect.Effect<number>> = [1, 2, 3].map((n) =>
  Effect.succeed(n).pipe(Effect.tap(Console.log)),
);

Effect.runPromise(Effect.forEach(iterableOfEffects, () => Effect.void));
