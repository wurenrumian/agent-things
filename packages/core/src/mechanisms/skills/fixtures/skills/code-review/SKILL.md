---
name: code-review
description: Review a diff or a set of changed files and report findings by severity, with a checklist and a fixed report format.
---

# Code review

You are acting as a careful, senior reviewer. Your job is to find real problems
in a change, not to praise it, and not to rewrite it unless asked. Follow the
process below in order. Do not skip the evidence step.

## 1. Establish the change under review

1. Identify exactly which files and hunks changed. If a diff is provided, use it;
   otherwise compute one (`git diff`, `git diff --staged`, or a named range).
2. Read the *whole* file around each hunk, not just the hunk. A reminder can be
   correct in isolation and wrong in context.
3. Note the intent of the change in one sentence. If the intent is unclear, ask
   before reviewing further.

## 2. Walk the checklist

For every changed file, apply the full checklist in `reference/checklist.md`.
The checklist is grouped into correctness, security, performance, tests,
accessibility, and style. A finding on the checklist is only a *candidate*; it
becomes a real finding only after the evidence step.

## 3. Evidence step

For each candidate finding, produce one of:

- a minimal reproduction (a command, a failing input, a stack trace), or
- a precise argument that references line numbers and the surrounding contract, or
- an explicit note that you could not verify it, in which case mark it as
  `unverified`.

Never report a candidate as a bug without evidence. "This looks suspicious" is
not a finding. "This throws when `items` is empty because line 42 indexes
`items[0]`" is.

## 4. Classify severity

Assign exactly one severity label per finding:

- **blocker** — data loss, security hole, crash on a documented path.
- **major** — incorrect behavior on an edge case, resource leak, N+1 on a hot path.
- **minor** — readability, naming, dead code, missing test for a non-critical path.
- **nit** — preference. Keep these to at most three and say they are optional.

## 5. Write the report

Use the exact structure in `reference/report-format.md`. The summary must be
readable on its own: a reviewer should be able to act on it without scrolling.
Order findings by severity, then by file, then by line.

## 6. Stop

When the report is complete, stop. Do not start fixing unless the user asked you
to. If you did fix something, say exactly what changed and what you did not touch.

## Anti-patterns

- Rewriting the author's design when a small change would do.
- Commenting on formatting a formatter already owns; run the formatter instead.
- Bundling unrelated nits into one finding to make the count look lower.
- Reporting the same root cause four times because it appears in four files;
  report it once and list the affected locations.
