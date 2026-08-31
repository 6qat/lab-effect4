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

const result2 = Effect.forEach(
	Array.from({ length: 5 }, (_, i) => i + 1),
	(count) =>
		Effect.gen(function* () {
			yield* Effect.log(`Processing step ${count}`);
			return count;
		}),
	{ concurrency: "unbounded" },
);

Effect.runPromise(result2).then(console.log);
