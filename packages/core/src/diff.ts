/**
 * Pure, dependency-free line diff.
 *
 * A small LCS-based unified diff. It exists for two consumers: the observatory
 * / CLI file view, and the `mechanism` diff event the server attaches to the
 * file-write tools. Deliberately self-contained (no `diff` package) and
 * bounded: a pathological input pair falls back to a whole-file replace, and
 * oversized output is truncated.
 */

export interface UnifiedDiffOptions {
  /** Lines of unchanged context around each change (default `3`). */
  context?: number;
  /** Hard cap on the returned patch length in characters (default `20000`). */
  maxChars?: number;
}

type Op = " " | "-" | "+";

interface DiffLine {
  op: Op;
  text: string;
  /** 1-based line number this op sits at in `old` (does not advance for `+`). */
  oldNo: number;
  /** 1-based line number this op sits at in `new` (does not advance for `-`). */
  newNo: number;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // A trailing newline terminates the last line; it does not add a phantom
  // empty line (matching how editors and `git diff` count lines).
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Walk the LCS table backwards to produce an ordered edit script. Ties favor a
 * deletion first; any consistent choice yields a valid, applicable patch.
 */
function buildOps(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;

  // Guard the O(n*m) table on a pathological pair: report a full replace, which
  // is still honest (nothing was matched).
  if (n * m > 4_000_000) {
    return [
      ...oldLines.map((text, i) => ({
        op: "-" as Op,
        text,
        oldNo: i + 1,
        newNo: 1,
      })),
      ...newLines.map((text, i) => ({
        op: "+" as Op,
        text,
        oldNo: n + 1,
        newNo: i + 1,
      })),
    ];
  }

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        oldLines[i] === newLines[j]
          ? (dp[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0);
    }
  }

  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ op: " ", text: oldLines[i]!, oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (
      (dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)
    ) {
      ops.push({ op: "-", text: oldLines[i]!, oldNo: oldNo++, newNo });
      i++;
    } else {
      ops.push({ op: "+", text: newLines[j]!, oldNo, newNo: newNo++ });
      j++;
    }
  }
  while (i < n) {
    ops.push({ op: "-", text: oldLines[i]!, oldNo: oldNo++, newNo });
    i++;
  }
  while (j < m) {
    ops.push({ op: "+", text: newLines[j]!, oldNo, newNo: newNo++ });
    j++;
  }
  return ops;
}

/** Merge changed runs (plus `context` unchanged lines each side) into hunks. */
function buildHunks(ops: DiffLine[], context: number): DiffLine[][] {
  const changed: number[] = [];
  ops.forEach((line, index) => {
    if (line.op !== " ") changed.push(index);
  });
  if (changed.length === 0) return [];

  const groups: Array<[number, number]> = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(ops.length, changed[0]! + context + 1);
  for (let k = 1; k < changed.length; k++) {
    const index = changed[k]!;
    const nextStart = Math.max(0, index - context);
    const nextEnd = Math.min(ops.length, index + context + 1);
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      groups.push([start, end]);
      start = nextStart;
      end = nextEnd;
    }
  }
  groups.push([start, end]);
  return groups.map(([s, e]) => ops.slice(s, e));
}

/**
 * Render a unified diff for `oldText -> newText`. Returns `""` when identical.
 * The output carries hunks only (no `---`/`+++` file headers); it is meant to
 * be shown, not `patch`-ed to a file, though the hunks are standard shaped.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  opts: UnifiedDiffOptions = {},
): string {
  if (oldText === newText) return "";

  const context = Math.max(0, Math.floor(opts.context ?? 3));
  const maxChars = Math.max(0, Math.floor(opts.maxChars ?? 20_000));

  const ops = buildOps(splitLines(oldText), splitLines(newText));
  const hunks = buildHunks(ops, context);

  const out: string[] = [];
  for (const hunk of hunks) {
    const first = hunk[0]!;
    let oldCount = 0;
    let newCount = 0;
    for (const line of hunk) {
      if (line.op !== "+") oldCount++;
      if (line.op !== "-") newCount++;
    }
    out.push(`@@ -${first.oldNo},${oldCount} +${first.newNo},${newCount} @@`);
    for (const line of hunk) out.push(`${line.op}${line.text}`);
  }

  const patch = out.join("\n");
  if (patch.length > maxChars) {
    return `${patch.slice(0, maxChars)}\n... (diff truncated)`;
  }
  return patch;
}
