/** Only use before any durable write, when retrying corrected input cannot duplicate a job. */
export class SubmissionRejected extends Error {}
