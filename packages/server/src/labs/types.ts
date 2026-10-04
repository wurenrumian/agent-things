/**
 * L3 — Labs: the shapes shared by the catalog, the runner, the routes and the
 * web client.
 *
 * A "lab" is one of the `packages/server/scripts/*-experiment.ts` harnesses,
 * surfaced in the observatory so a learner can run it with one click and watch
 * its output stream live. The registry in `registry.ts` is the **allowlist**:
 * the server only ever spawns a script named there, never a caller-supplied
 * path.
 */

/** A lab either needs no network (`offline`) or calls OpenRouter (`api`). */
export type LabKind = "offline" | "api";

/** One catalog entry. Everything the web UI needs to describe a lab. */
export interface Lab {
  /** Stable slug, also the URL segment for `POST /api/labs/:id/run`. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Which mechanism the lab demonstrates (skills, cache, hooks, …). */
  mechanism: string;
  /** `offline` = zero API calls; `api` = hits OpenRouter. */
  kind: LabKind;
  /** Provider calls the lab makes (only meaningful when `kind === "api"`). */
  apiCalls?: number;
  /** Rough wall-clock estimate in seconds (advisory, for the UI). */
  estSeconds?: number;
  /** File name under `packages/server/scripts/` — the allowlisted target. */
  script: string;
  /** The recorded run doc for this mechanism, relative to the repo root. */
  docsRun: string;
  /** One-line description shown in the Labs tab. */
  blurb: string;
}

/**
 * One frame of the run SSE stream. `start` announces the child; `stdout` /
 * `stderr` carry one output line each; `exit` is terminal and carries the
 * process code and elapsed time (or a timeout marker).
 */
export type LabFrame =
  | { type: "start"; id: string; command: string }
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | {
      type: "exit";
      code: number | null;
      durationMs: number;
      /** `true` when `LAB_TIMEOUT_MS` fired and the process tree was killed. */
      timedOut?: boolean;
      /** Present when the process could not be spawned at all. */
      error?: string;
    };
