# Contributing

Issues and focused pull requests are welcome.

```bash
npm ci
npm run check
```

Keep account/workspace identities isolated. Never add code that copies, swaps,
prints, or commits credential values. Tests must use generated fixtures only.
Changes to authentication, locking, deletion, or shell integration should include
both a success test and a failure-path test on macOS or Linux.

Use conventional, imperative commit subjects and explain user-visible behavior in
the pull request. Do not claim that a running Codex process can change account or
that a conversation can cross workspace policy boundaries.
