import { Effect } from "effect";

// Clean, native, and highly performant standard loop
const result = Effect.gen(function* () {
  let result = 1;

  while (result <= 5) {
    // You can yield* any effectful operations safely inside the loop
    result = yield* Effect.succeed(result + 1);
  }

  return result;
});

Effect.runPromise(result).then(console.log);
// Output: 6
