# PR-C-2B-4B-3 Clock / Drain / Wait / Restart Recovery

## Scope and status

Design baseline: PR #69, `ca88ccc4326a2e48f0848e9dd4a155b489b97033`.
Contracts: [4B-3 MVP](../technology-stack.md#pr-c-2b-4b3-mvp), D-03 / D-04,
[acceptance plan](c-impl-5b4-history-trust-restart-recovery.md#pr-c-2b-4b3-plan).

This implements internal control and automated tests only. It does not wire the
production OS, HTTP adapter, startup/shutdown or Scheduler/Coordinator. Issue #16
and PR-C remain incomplete. No Schema, Migration, Quota limits, Frontend or design
contract changes are included. No production DB/API/Pi operation is performed.

The user explicitly approved these implementation boundaries:

- Preserve the old `HistoryTrustMonitor` semantics. Add an authenticated History
  path to the **existing** Gate, Quota Guard and Quota Repository. CONSERVATIVE
  never sets the old Monitor to TRUSTED or supplies fixed legacy trust booleans.
- Test Wait completion with a Fake clock. Production must refuse Wait-based
  exclusion until a verified precision/continuity input is implemented.

## Implementation and authority

- `HistoryRecovery` in the existing internal `history-boundaries.ts` owns the
  dedicated Recovery stop reason, Freeze/Drain, boundary evidence, Window waits
  and recovery assessment. No independent Service/Process or general framework.
- Source handles are opaque WeakMap identities, bound to the actual Runtime,
  Quota Repository/Connection, Gate binding, Clock and committed Startup object.
  `TRUSTED / CONSERVATIVE` output is History decision material, **not a Permit**.
  BLOCKED/unverified/expired History is refused. There is no API accepting a
  caller-supplied CONSERVATIVE boolean or an allow decision from an earlier read.
- The new path reuses the existing Guard and conservative evaluator. A precheck
  rejects invalid History before a new Tx-Q; BEGIN IMMEDIATE then re-reads current
  Metadata, all Consumption and Ranges and re-authenticates Runtime/Wait evidence.
  The legacy Guard/Monitor path stays unchanged when no Source is bound.
- Gate retains its Clock, owner-specific Global/Provider/Recovery/management
  reasons, Epoch, Permit, in-flight and F-02 checks. It additionally requires live
  authenticated History and the reservation's registered Runtime Valid fact.
  It rechecks Epoch/stop state after the History read and before Permit consumption.
- Freeze increments the local registration generation. Pending Tx-Q is resolved
  through the existing read-only Reconcile while registration remains prohibited.
  Recovery retains the same Runtime instance and consumes internal resume evidence
  once. An old Trial/Attempt/Permit is never revived.
- Drain requires closed Gate, IDLE after owned Lifecycle completion, no active
  Attempt/pending reservation, and resolved shared Connection/Transaction state.
  Abort or fulfilled/rejected HTTP Promise alone does not suffice.
- Without a finer trusted checkpoint, invalidate the current recovery interval
  conservatively, starting after the previous confirmed recovery checkpoint (or
  Startup cutoff initially). Drain determines the final Sequence. Existing Range
  boundaries and earlier confirmed intervals remain immutable. Unsafe gaps or
  unappendable/overlapping ranges block; they are not repaired or merged.
- Range evidence is returned only by the existing successful Range transaction.
  Its inspector also checks the actual persisted boundary. Unknown commits are
  never retried or guessed successful; committed Consumption is never cancelled.
- Old/uncertain timestamps get structural validation and full counting, not global
  wall-time ordering/future-time rejection. Trusted Runtime rows retain ordering
  and future-time checks for the existing Window algorithm. The previous 4B-1/2
  timestamp tests were updated only for this explicitly approved D-03 distinction.
- F-01 Runtime provisioning evidence requires the existing Repository's private
  successful-COMMIT receipt and actual current Scope/Metadata. Empty DB/ACTIVE
  alone cannot issue it. The persisted NULL Startup cutoff remains NULL; only the
  effective Runtime cutoff becomes zero.

## Wait, recheck and restart boundaries

Wait targets are independently bound to Startup or confirmed Range, Scope, Process,
Window and endpoint. 1 minute / 65 minutes / 25 hours are unchanged. Clock Epoch
or wall Trust failure and an observation gap alone do not expire healthy Waits.
Backwards/invalid/failed/discontinuous monotonic readings expire them; restart
requires revalidation and a new origin. Process restart restores no old Wait proof.

`wait-clock.ts` returns null in production. Fake verified readings are installed
only by mocking that internal module in tests. No production option/boolean can
assert assurance. Platform precision, real elapsed-time bounds (including the
1-second Window's 1-minute wait), continuity and sleep settings remain unverified.

`HistoryRecheck` provides A (safe wall deadline), B (monotonic deadline) and C
(explicitly supplied fallback period) **assessment notifications only**. It has no
5-minute default, never resumes held Scheduler states, and cannot send/reserve.
Missed/thrown notifications retain the next periodic opportunity; stop prevents
rearming. Production notification wiring and selection of C's period remain open.

Restart uses the existing successful Atomic Startup and new cutoff. Old Source,
Evidence and Trial identities cannot cross Connections/Startup Scope. Ordinary
crash recovery does not automatically impose manual 25-hour quarantine. Independent
management stops and SUSPENDED remain effective. CONSERVATIVE can resume when all
independent conditions and conservative quota allow; all Window waits need not be
complete. `historyCleanEligible()` is only the History portion of a CLEAN candidate
and is false for CONSERVATIVE. No CLEAN update or administrator Recovery is added.

## B43 acceptance mapping

All entries below describe internal automated coverage, not production integration
or hardware validation. Main suite: `tests/backend/history-recovery.test.ts`;
additional existing suites and the production Wait-port test are listed below.

| ID     | Internal automated coverage                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| B43-01 | Clock loss during Tx-Q evaluation/Commit; synchronous stop/Freeze; no new HTTP; final Drain Sequence                                               |
| B43-02 | Settled headers/Abort with unfinished Lifecycle retain Flight and prevent Drain                                                                    |
| B43-03 | Actual saved/not_saved unknown resolution through read-only Reconcile; unresolved remains closed; no re-reservation                                |
| B43-04 | Conservative affected suffix; immutable distinct repeated Ranges and exclusive classification                                                      |
| B43-05 | Local generation and Epoch validation; old Trial/Attempt refused after same-instance recovery                                                      |
| B43-06 | Range rollback and Commit unknown emit no Wait/authority; Consumption remains                                                                      |
| B43-07 | Old/uncertain reversed/future timestamps retain full counts; Valid timestamp validation retained                                                   |
| B43-08 | Sequence/Scope/data/owner mismatch and forged Source/Drain/Wait/Resume rejected; transient BUSY classified separately                              |
| B43-09 | Window boundaries, Range binding, independent waits, forged/mismatched proof regression and changed Range rejection                                |
| B43-10 | Clock epoch loss and long observation gap preserve continuous monotonic waits                                                                      |
| B43-11 | Reverse/throw/malformed/discontinuous readings expire proofs; new origin; production assurance absent => no exclusion                              |
| B43-12 | Real new-Connection Startup cutoff; old Source/Trial invalid; F-01 success versus empty/unknown provisioning                                       |
| B43-13 | BEGIN IMMEDIATE latest revalidation; changed History/Valid row and saved-without-registration denied; no second Tx-Q on gap                        |
| B43-14 | Any exhausted Window blocks; no inferred uncertain release time; Consumption and Control State unchanged                                           |
| B43-15 | Clock recovery versus independent Recovery/management/SUSPENDED; final read/confirmation invalidation race                                         |
| B43-16 | Normal crash candidate without mandatory admin quarantine; CONSERVATIVE is not History CLEAN eligibility; no CLEAN write                           |
| B43-17 | All-wait and partially-waited CONSERVATIVE positive sends through Fake Adapter; A/B/C, missed notification, stopped notification and bounded Timer |

Existing `history-runtime-range.test.ts` adds two frozen Reconcile cases. Existing
`history-evaluation.test.ts` and `conservative-quota.test.ts` retain structural,
classification, scope, overlapping and forged/mismatched Wait regressions. Existing
PR-B / C-1 / C-2 / C-Impl-3 / Gate / HTTP / H54-related suites remain in the full run.

## Verification

- Added 56 tests relative to PR #69: 53 Recovery integration cases, 1 closed
  production Wait-port case, and 2 frozen Reconcile cases in the existing suite.
- Windows full suite: **1284 PASS / 56 Linux-only Skip, 1340 total**; 34 files
  passed and 2 Linux-only files skipped. Existing suites remain included.
- Strict `npm run check` (Lint, Format, Type Check, full Test): PASS in a separate
  LF source snapshot built from Git plus the reviewed diff. Backend Build: PASS.
- Original Windows worktree Lint/Type Check/Test/Build and `git diff --check`:
  PASS. Its default Format Check reports unrelated CRLF checkout files; none were
  reformatted. The LF snapshot uses `git -c core.autocrlf=false archive` so archive
  conversion cannot carry the Windows checkout's line endings into validation.
- Local `npm ci` could not build the native addon without Windows C++ Build Tools.
  `npm ci --ignore-scripts` installed the same lockfile; the package's bundled
  native addon loaded successfully and executed all Windows SQLite tests.
  No dependency/configuration changes were made. Linux CI uses normal `npm ci`.
- The PR's latest-Head **Quality checks** records the Linux default-install,
  strict-format, type and complete-test result. Consult that Check for its final
  conclusion; the Windows skips above are not reported as Linux passes.

No actual Provider HTTP, Pi validation or production DB work.

## Additional review (Claude Code handover)

Read-only review of `8262c35` found no implementation defect; no source file
changed. B43-01 to B43-17 keep their meaning. Three internal regression cases
were added to `history-recovery.test.ts` for paths the mapping did not exercise
end to end:

- **B43-15/17 Quota hold is reassessed by B/C notifications; lost or untrusted
  rechecks keep stops**: `recheckHint()` with `HistoryRecheck` and no
  `recheckAtMs`. A lost B notification and an untrusted-Clock C notification
  recover nothing; a later C retry recovers. Notification never sends, and the
  independent management stop remains until its owner releases it.
- **B43-04/05/09 second in-process Clock failure waits per Range and revokes the
  interval's Trial**: after a successful recovery, a second failure appends
  Range 2 without changing Range 1. Range 1's completed 1m Wait does not exclude
  Range 2. The recovered interval's Trial/reservation is refused; a new Runtime
  Valid then sends.
- **B43-06 second-failure Range COMMIT unknown keeps earlier Range and stays
  closed**: the Connection is blocked; no Wait/authority is issued; Range 1 and
  Consumption rows remain; recovery stays refused after all Wait periods.

The new per-Range case fails if Wait evidence is matched without its Range ID and
end Sequence. The B/C case fails if periodic notifications stop after a lost one.
Production Coordinator/notification wiring remains absent; these cases do not
claim automatic production resume.

Windows: full suite **1287 PASS / 56 Linux-only Skip, 1343 total**; Lint, Type
Check, Backend Build and `git diff --check` PASS. Default Format Check fails
only on CRLF checkout files outside `.gitattributes` (including this file); see
the LF snapshot note in Verification.

## Follow-up PR-C

Production OS synchronization/monotonic assurance; trusted HTTP/Body Lifecycle
wiring; Startup/Shutdown/Scheduler/Coordinator connection; C fallback period and
notification wiring; F-03 management persistence; exceptional administrator Recovery
and isolation, CLEAN lifecycle, PR-D publication/Pending and PR-E DB Recovery/backup.
