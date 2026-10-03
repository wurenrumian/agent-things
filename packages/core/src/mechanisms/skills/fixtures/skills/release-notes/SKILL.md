---
name: release-notes
description: Turn a range of merged commits into user-facing release notes grouped by impact, then check them for leaks.
---

# Release notes

Write release notes for humans who did not read the commits.

## Inputs

- The commit range (default: last tag to `HEAD`).
- The audience (default: users of the product, not contributors).

## Steps

1. List the commits in the range. Discard pure refactors, formatting, and CI-only
   changes *unless* they change observable behavior.
2. Group what remains under: **Added**, **Changed**, **Fixed**, **Removed**,
   **Security**. Omit empty groups.
3. Rewrite each entry in user terms. Name the thing the user controls, not the
   internal symbol. "Fix crash when opening a project with no files" beats
   "guard against empty file list".
4. Link each entry to its pull request when a number is available.
5. Run the leak check before publishing: internal hostnames, ticket ids, customer
   names, and unreleased codenames must not appear.

## Output shape

A title line (`# <version> — <date>`), then the groups as `##` sections with
`-` bullets. Keep the whole document under 400 words; link out for detail.
