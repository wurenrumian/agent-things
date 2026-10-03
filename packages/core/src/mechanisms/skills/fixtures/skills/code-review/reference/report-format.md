# Report format

Produce exactly these sections, in this order.

## Summary

One paragraph. What the change does, whether it is safe to merge, and the single
most important finding. No bullet points here.

## Findings

One block per finding:

```
[severity] path/to/file.ext:LINE — short title
Evidence: the command / input / argument that proves it.
Impact: what breaks, and for whom.
Suggested fix: the smallest change that resolves it (optional).
```

## Not reviewed

Files you deliberately skipped and why, so the reader knows the report's bounds.

## Verdict

One of: `approve`, `approve with nits`, `request changes`, `block`.
