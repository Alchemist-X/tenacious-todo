# tenacious-todo — Eval Criteria

Run from repo root:

```
node eval/eval.mjs
```

The harness uses an **isolated store** via the env var `TENACIOUS_HOME`, pointing at a
fresh temp dir per run, so the eval never touches the real `~/.tenacious-todo`.

> The project MUST honor `TENACIOUS_HOME` for the store path (data dir = `$TENACIOUS_HOME`
> when set, else `~/.tenacious-todo`). If it does not, the eval refuses to mutate the real
> store and fails the store-dependent criteria (this is an isolation requirement, not a
> soft preference).

Output contract: for each criterion print `PASS C<N>: ...` or `FAIL C<N>: <why>`,
end with `RESULT: X/Y passed`, and exit `0` only if all (non-skipped) pass, else `1`.

---

## C1 — help
`node todo.js --help`, `node todo.js -h`, and bare `node todo.js` each:
- exit `0`
- print usage to **STDOUT** (not stderr)
- list the commands: `add`, `list`, `done`, `rm`, `snooze`, `stats`, `today`, `overdue`.

## C2 — round-trip
- `add` a task with text/priority/due → it appears in `list` with the correct
  text, priority, and due.
- `done <id>` marks it done.
- `rm <id>` removes it.

Robust assertions prefer `list --json`. If `--json` is absent, the harness falls back to
reading the isolated `tasks.json` store file directly (the store is the source of truth).

## C3 — recurring
- `add ... --repeat weekdays --due <date>` then `done <id>` → a **NEXT** occurrence
  is created (same text, not done, with a strictly later due date).
- `--repeat monthly` MUST NOT silently no-op. Pass if **either**:
  - it reschedules correctly (a later next occurrence is created on `done`), **or**
  - it is **rejected at add-time** with a clear non-zero-exit error.

  (Known bug: silent no-op — task is added but `done` creates no next occurrence and no
  error is raised. That FAILS this criterion.)

## C4 — snooze
- `snooze <id> 2h` defers the task's due/notify window (snoozeUntil set ~2h ahead).
- `daemon.js --once` does **NOT** notify a snoozed task (no "Notified:" log line for it).

## C5 — daemon --once
- With a PAST-due, non-snoozed task in the isolated store, `node daemon.js --once`
  exits `0` and logs a notification attempt (a `Notified:` line, or a `[WARN] Failed to
  notify` line — osascript may be a no-op/blocked in CI, but the exit must be 0).
- With quiet-hours configured to cover "now", `daemon.js --once` exits `0` and logs a
  quiet-hours **skip**, and does NOT log a notification.

## C6 — list filters
Seeded with known attributes, each returns the correct subset:
- `list --overdue` → only past-due, not-done, not-snoozed tasks.
- `list --today`   → only not-done tasks due today.
- `list --done`    → only done tasks.
- `list --tag <t>` → only tasks carrying tag `<t>`.

## C7 — no-TTY no-color
Piping `list` output (stdout is NOT a TTY, as it is when spawned) contains **NO** ANSI
escape sequences (no `\x1b[` / `[` codes).

## C8 — packaging
- `package.json` exists with a `"bin"` entry (e.g. `todo`).
- The bin target file starts with the shebang `#!/usr/bin/env node`.
- Running that bin with `--help` works (exit 0, prints usage) — i.e. it is npx-able.

## C9 — tests
- `node --test` (run against the project's test files) runs **>= 4** tests covering pure
  store ops (`computeNextDue`, filtering, snooze math), and **all pass**.

---

## Aesthetic (implemented; judged later, not pass/fail here)
- Colorized list table stays clean and aligned.
- Relative due times ("in 2h", "3d overdue").
- Helpful `--help`.
