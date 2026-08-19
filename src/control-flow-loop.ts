import { Effect } from "effect";

// A loop that runs 5 times, collecting each iteration's result
const result = Effect.gen(function* () {
  const list: number[] = [];
  let count = 1;

  while (count <= 5) {
    yield* Effect.log(`Processing step ${count}`);
    list.push(count);
    count++;
  }

  return list;
});

Effect.runPromise(result).then(console.log);
// Output: [1, 2, 3, 4, 5]
