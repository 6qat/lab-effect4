import { Effect, Layer, Schema } from "effect";
import { Job, type JobStore, MemoryJobStore, Worker } from "effect-mq";

export type { JobStore };

export class SendEmail extends Job.make("SendEmail", {
	payload: { to: Schema.String, subject: Schema.String },
	success: Schema.String, // typed result
	idempotencyKey: ({ to, subject }) => `${to}:${subject}`,
	metadata: ({ to }) => ({ to }), // queryable context
	queue: "email",
	defaults: {
		attempts: 3,
		backoff: { type: "exponential", delay: "1 second" },
	},
}) {}

export const program = Effect.gen(function* () {
	// fire and forget: returns the JobId
	const _jobId = yield* SendEmail.enqueue({
		to: "ada@example.com",
		subject: "hi",
	});

	// ...or enqueue and await the typed result
	const _messageId = yield* SendEmail.execute(
		{ to: "grace@example.com", subject: "now" },
		{ delay: "5 seconds", priority: 2 },
	);
});

export const RunnerLive = SendEmail.toLayer(
	(_payload) =>
		Effect.map(Worker.CurrentJob, ({ jobId }) => `message-${jobId}`),
	{ concurrency: 5 },
).pipe(
	Layer.provideMerge(Worker.layer()),
	Layer.provideMerge(MemoryJobStore.layer), // swap for Postgres/Redis below
);
