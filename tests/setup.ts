// Runs BEFORE dotenv/config (see vitest.config.ts), so these values win over whatever is in .env:
// the auth rate limiter (10/min by default) is far too tight for a test file that signs up, logs in,
// refreshes and logs out several accounts in a row.
process.env.AUTH_RATE_LIMIT = "100000";
// the general API rate limiter (100/min by default) is far too tight for the full suite, which fires many
// requests per minute per IP across every test file sharing one process (see planner-isolation.test.ts).
process.env.API_RATE_LIMIT = "100000";
process.env.LOG_LEVEL = "silent"; // keep `npm test` output readable; the app's own request logger stays quiet
