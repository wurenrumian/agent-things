# Review checklist

Apply every item to every changed file. Mark each as pass, fail, or not-applicable.

## Correctness

- Off-by-one and boundary conditions (empty input, single element, max size).
- Null / undefined / optional values on the unhappy path.
- Error propagation: is a failure swallowed, or surfaced with enough context?
- Async ordering: unawaited promises, races, and accidental parallel writes.
- Idempotency for retried operations.

## Security

- Untrusted input reaching a shell, a query, or a path join.
- Path traversal: does a user-controlled segment escape the intended root?
- Secrets in logs, error messages, or committed files.
- Authorization checked at the point of use, not only at the edge.

## Performance

- N+1 queries or repeated whole-file reads inside a loop.
- Unbounded growth: caches, buffers, and arrays without eviction.
- Work done eagerly that could be deferred.

## Tests

- Does the change come with a test that fails before and passes after?
- Are edge cases from the correctness section covered?
- Are tests deterministic (no sleeps, no network, no wall-clock dependence)?

## Accessibility and UX

- Keyboard reachability for interactive elements.
- Labels for inputs; alt text for meaningful images.
- Contrast and focus visibility not regressed.

## Style

- Naming matches the surrounding code.
- Dead code, commented-out blocks, and debug prints removed.
- Public API changes documented in the same change.
