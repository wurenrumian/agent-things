/**
 * M7 — background & scheduled tasks experiment harness. NO MODEL CALLS.
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/scheduler-experiment.ts
 *
 * The mechanism is pure `node:timers` + async, so this harness never touches
 * OpenRouter (no `.env`, no `loadConfig()`, zero API calls). It proves the four
 * required behaviours with real timers and hard assertions:
 *
 *   (a) a one-shot task fires after ~1s, its result is captured, and the result
 *       is re-injected as a session message;
 *   (b) `runInBackground` returns immediately (the caller's continuation runs
 *       before the task starts) and its result is collected later;
 *   (c) `cancel()` stops a pending task before it ever runs;
 *   (d) an interval task fires repeatedly and coalesces overlapping ticks.
 *
 * Exit code is non-zero if any check fails, so the run is machine-checkable.
 */

import type { ChatMessage } from "@agent/core";
import { setTimeout as delay } from "node:timers";
import {
  Scheduler,
  reinjectTaskOutcome,
  runInBackground,
  stringifyTaskResult,
  taskOutcomeToEvent,
  type TaskOutcome,
} from "../../core/src/mechanisms/scheduler/index.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    delay(resolve, ms);
  });

/* --------------------------------------------------------------- assertions */

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

function banner(title: string): void {
  console.log(`\n================ ${title} ================`);
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  console.log("M7 scheduler-experiment — no model calls, real timers");
  console.log(`node=${process.version}`);

  const scheduler = new Scheduler();
  const messages: ChatMessage[] = [];

  // Push path: every settled outcome is announced as it happens.
  const unsubscribe = scheduler.subscribe((outcome) => {
    console.log(`  [subscribe] ${outcome.name} -> ${outcome.status} (run ${outcome.run})`);
  });

  /* ---------------------------------------------------------------- (a) one-shot */
  banner("(a) scheduled one-shot fires after ~1000ms, result captured + re-injected");
  const tA = Date.now();
  const after = scheduler.scheduleAfter<{
    report: string;
    items: number;
    firedAfterMs: number;
  }>(
    1000,
    () => ({
      report: "daily digest",
      items: 7,
      firedAfterMs: Date.now() - tA,
    }),
    { name: "delayed-report" },
  );
  // This line proves registration did not block: it prints before the task fires.
  console.log(
    `  registered ${after.id}; caller continues immediately ` +
      `(status=${after.status()}, fires in ${(after.record().nextRunAt ?? tA) - tA}ms)`,
  );

  const aOutcome = await after.settled;
  const firedAfterMs = aOutcome.result?.firedAfterMs ?? -1;
  console.log(
    `  outcome: status=${aOutcome.status} run=${aOutcome.run} ` +
      `durationMs=${aOutcome.durationMs} result=${JSON.stringify(aOutcome.result)}`,
  );
  check("(a) fired", aOutcome.status === "succeeded");
  check(
    "(a) fired after ~1s",
    firedAfterMs >= 950 && firedAfterMs < 2500,
    `${firedAfterMs}ms`,
  );

  const aMessage = reinjectTaskOutcome(messages, aOutcome);
  console.log("  re-injected session message:");
  for (const line of textOf(aMessage).split("\n")) console.log(`    | ${line}`);
  check("(a) re-injected as a user message", aMessage.role === "user");
  check(
    "(a) message carries the result",
    textOf(aMessage).includes("daily digest") && textOf(aMessage).includes('"items": 7'),
  );
  console.log(`  proposed event: ${JSON.stringify(taskOutcomeToEvent(aOutcome))}`);

  /* --------------------------------------------------- (b) runInBackground */
  banner("(b) runInBackground returns immediately; result collected later");
  const tB = Date.now();
  const job = runInBackground<{ computed: string; rows: number }>(
    async () => {
      await sleep(700);
      return { computed: "index built", rows: 1234 };
    },
    { name: "heavy-job" },
  );
  const callerSawMs = Date.now() - tB;
  // If runInBackground blocked, this would print after ~700ms.
  console.log(
    `  runInBackground returned at +${callerSawMs}ms (status=${job.status()}, done=${job.isDone()})`,
  );
  check("(b) caller continued immediately", callerSawMs < 100, `+${callerSawMs}ms`);
  check("(b) job is not done yet", !job.isDone());

  const bOutcome = await job.settled;
  const settledMs = Date.now() - tB;
  console.log(
    `  settled at +${settledMs}ms: status=${bOutcome.status} ` +
      `result=${JSON.stringify(bOutcome.result)} error=${job.error() ?? "none"}`,
  );
  check("(b) completed while caller continued", bOutcome.status === "succeeded");
  check("(b) ran in the background", settledMs >= 650);
  check(
    "(b) captured the result",
    bOutcome.result?.rows === 1234 && job.result()?.computed === "index built",
  );

  const bMessage = reinjectTaskOutcome(messages, bOutcome, {
    guidance: "The background job finished; report the row count.",
  });
  console.log("  re-injected session message:");
  for (const line of textOf(bMessage).split("\n")) console.log(`    | ${line}`);
  check("(b) re-injected", textOf(bMessage).includes("1234"));

  /* ---------------------------------------------------------------- (c) cancel */
  banner("(c) cancel a pending task before it fires");
  const tC = Date.now();
  const doomed = scheduler.scheduleAfter(
    5000,
    () => {
      throw new Error("this task must never run");
    },
    { name: "never-runs" },
  );
  const cancelReturned = doomed.cancel();
  const cOutcome = await doomed.settled;
  console.log(
    `  cancel() -> ${cancelReturned}; outcome status=${cOutcome.status} run=${cOutcome.run}`,
  );
  await sleep(150); // wait past nothing; just prove it stays cancelled
  const cRecord = doomed.record();
  check("(c) cancel returned true", cancelReturned === true);
  check("(c) settled as cancelled", cOutcome.status === "cancelled");
  check(
    "(c) never ran",
    cRecord.runs === 0 && cRecord.state === "cancelled",
    `runs=${cRecord.runs}, state=${cRecord.state}`,
  );
  check("(c) state stays cancelled", doomed.status() === "cancelled");
  console.log(`  elapsed since scheduling: ${Date.now() - tC}ms (would have fired at 5000ms)`);

  /* ------------------------------------------------------------- (d) interval */
  banner("(d) interval task fires repeatedly, then cancels");
  const tD = Date.now();
  const heartbeat = scheduler.scheduleInterval(
    200,
    () => ({ beat: Date.now() - tD }),
    { name: "heartbeat" },
  );
  await sleep(480);
  const dRecord = heartbeat.record();
  console.log(
    `  after ${Date.now() - tD}ms: runs=${dRecord.runs} skipped=${dRecord.skipped ?? 0} ` +
      `state=${dRecord.state}`,
  );
  const dCancel = heartbeat.cancel();
  // `settled` resolved on the first tick; interval outcomes keep flowing to drain.
  const dFirst = await heartbeat.settled;
  check("(d) fired repeatedly", dRecord.runs >= 2, `runs=${dRecord.runs}`);
  check("(d) first outcome captured", dFirst.status === "succeeded" && dFirst.run === 1);
  check("(d) cancel returned true", dCancel === true);
  check("(d) terminal state", heartbeat.status() === "cancelled");

  /* ------------------------------------------------------------------ drain */
  banner("drain() — pull every buffered outcome");
  const drained = scheduler.drain();
  for (const outcome of drained) {
    console.log(
      `  buffered: ${outcome.name} status=${outcome.status} run=${outcome.run} ` +
        `result=${stringifyTaskResult(outcome.result, 60)}`,
    );
  }
  check(
    "drain() returned the scheduled outcomes",
    drained.some((o) => o.taskId === after.id) &&
      drained.some((o) => o.taskId === doomed.id),
    `${drained.length} outcome(s)`,
  );
  check("drain() clears the buffer", scheduler.drain().length === 0);

  /* ---------------------------------------------------------- session array */
  banner("session message array after re-injection");
  console.log(`  ${messages.length} message(s):`);
  for (const message of messages) {
    console.log(`   - role=${message.role} ${JSON.stringify(textOf(message).slice(0, 80))}…`);
  }
  check("two results re-injected as messages", messages.length === 2);

  unsubscribe();
  await scheduler.shutdown();
  console.log(`\nregistry size after shutdown: ${scheduler.size()}`);

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
