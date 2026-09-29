// Returning a `Result` guarantees to the caller that:
// - It **never blocks the thread or microtask queue**.
// - It **does not require an Effect runtime** to read the value.
// - Se a falha é um "não encontrou" esperado e ninguém vai inspecionar o
// porquê, Option é mais simples. Result com um canal de erro que nunca é lido é ruído.

import { Result } from "effect";

// Lightweight, instant, zero fiber/runtime overhead
const parseAge = (
	input: string,
): Result.Result<number, "InvalidNumber" | "Negative"> => {
	const n = Number(input);
	if (Number.isNaN(n)) return Result.fail("InvalidNumber");
	if (n < 0) return Result.fail("Negative");
	return Result.succeed(n);
};

const result = parseAge("10");

console.log(
	result.pipe(
		Result.match({
			onSuccess: (n) => n,
			onFailure: (e) => e,
		}),
	),
);

const total = Result.gen(function* () {
	const a = yield* parseAge("20"); // extracts the .success value or short-circuits
	const b = yield* parseAge("30");
	return a + b;
});

if (Result.isSuccess(total)) {
	console.log(total.success);
} else {
	console.log(total.failure);
}
