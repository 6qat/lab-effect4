import { Console, Effect } from "effect";

const task1 = Effect.succeed(1).pipe(
  Effect.delay("200 millis"),
  Effect.tap(Console.log("task1 done")),
);
const task2 = Effect.succeed("hello").pipe(
  Effect.delay("200 millis"),
  Effect.tap(Console.log("task2 done")),
);

const effect = Effect.zip(task1, task2, { concurrent: true });

Effect.runPromise(effect).then((res) => console.log(res));

const task3 = Effect.zipWith(
  task1,
  task2,
  // Combines results into a single value
  (number, string) => number + string.length,
);

Effect.runPromise(task3).then(console.log);
