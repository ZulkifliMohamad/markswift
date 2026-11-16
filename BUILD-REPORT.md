# BUILD-REPORT — markdown-render-speed-02 ("markswift")

Entry for the make.fun **markdown-render-speed-02** bounty (fast Markdown renderer).
Account: `@steady-koala-56`. Repo name: `markswift` (owner `ZulkifliMohamad`).
Built 2026-11-16, local git repo only; not submitted, no GitHub repo yet.

## What was built

A dependency-free, hand-rolled CommonMark 0.31.2 + GFM renderer in a single
ES module. `parse(markdown)` returns byte-identical HTML to marked 18.1.3
`marked.parse(markdown)` with default options (gfm true, breaks false,
pedantic false, async false). The code is my own: block lexer, inline lexer
with delimiter-run emphasis resolution, and renderer, written from the
CommonMark/GFM specs and verified against the vendored marked oracle. No
vendored marked, no practice data, no dependencies in the repo.

`main.ts` is the harness driver: reads every case from
`$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), renders each with `parse`,
writes the HTML strings in order as a JSON array to
`$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`).

## Files

| file | bytes | lines |
| --- | --- | --- |
| `parse.js` | 69,342 | 1,766 |
| `main.ts` | 845 | 23 |
| `README.md` | 3,006 | — |
| `LICENSE` (MIT) | 1,095 | — |
| `.makefun/owner.json` | 63 | — |
| **total (5 entry files)** | **74,351** | — |

Repo total 74,351 bytes, well under the 1,048,576-byte (1 MiB) cap.
Local commit: `06f4ca6117e9c50941f8e3d3196915114035c146` (root commit; the
BUILD-REPORT itself is committed on top of it — see git log for the final
HEAD). No practice data or vendored marked in the repo.

## Practice-set result

**720/720 cases pass** (680 CommonMark 0.31.2 spec examples + 28 GFM examples
+ 40 generated documents, ~2.9 MB of Markdown). Verified three ways:

- Compare harness vs `practice/reference/expected.json`: `passed 720/720`.
- End-to-end `node main.ts` with `MAKEFUN_INPUT_DIR`/`MAKEFUN_OUTPUT_DIR`
  pointed at the practice input: output `html.json` (720 strings) matches
  `expected.json` with 0 mismatches.
- Kit scorer (`program/scorer/main.ts`, run directly with node):
  `{"passed":1,"cases_passed":720,"cases_total":720}`, all 71 groups pass.

Additional fuzz verification against the vendored marked oracle, all with
zero diffs: 3,000 random inline-fragment cases, 4,000 random block-level
fragment cases, 5,000 mutations of practice-case Markdown (12,000 total).

## Timing vs house baseline

15 interleaved rounds over the full 720-case practice set, CPU time via
`process.cpuUsage` (the rank key the grader measures), Node v24.22.1 on the
build machine:

| renderer | CPU median | CPU mean | wall median |
| --- | --- | --- | --- |
| markswift (this entry) | 557 ms | 571 ms | 917 ms |
| marked 18.1.3 (house baseline) | 708 ms | 721 ms | 1,313 ms |

**CPU speedup: 1.27x median, 1.26x mean.** The two distributions are clearly
separated (mine 545–640 ms vs marked 676–763 ms across the 15 rounds), so the
entry should beat the baseline at 95% confidence. The 2x speedup target was
NOT reached: the renderer is a faithful re-implementation of marked's
algorithm, and the remaining cost is spread across list tokenization, the
text scanner, emphasis resolution, and masking, with no single cheap win
left. Two late text-scanner rewrites (per-char loop → 7 native searches →
single regex pass + separate email search) moved the median from ~661 ms to
~557 ms; each was re-verified with the full 12,000-case fuzz suite.

## grade-local / check results

- `grade-local --kit . --bot <repo> --driver process` (Docker is unavailable
  here): status `finished`, scores
  `{"cases_passed":720,"cases_total":720,"passed":1}`, checks 720 of 720
  points over 71 checks, L1 regrade reproduced byte for byte. Eligibility:
  `ranked yes, prize no, efficiency no (no_transcripts, coverage_below_gate,
  cost_unpriced)` — all three flags trace to the missing sealed transcripts,
  which only exist after submission. Note: the server harness runs Node
  v26.13.1, this machine v24.22.1, so the local `result_sha256` cannot equal
  the server's.
- `check --kit . --repo <repo>`: **5 passed, 0 failed, 15 skipped, 5 checked
  at submission.** `entry_size` passes (5 files, 74,351 bytes). The 15
  skipped checks are transcript checks that run on the site from the sealed
  recordings. The 5 at-submission checks are pending the public GitHub repo
  and push (`repo_public`, `repo_owner`, `repo_created_after_open`,
  `commit_in_repo`, `duplicate_snapshot`). Note from `repo_created_after_open`:
  the GitHub repo must be created at or after 2026-11-15T20:30:00Z.

## Recording status

Recording id **`01a1e375-d8a4-73b2-b9ed-9fedcc749925`**, started
2026-11-16T08:25:13.633Z from inside the unpacked kit, before any code was
written. Background process PID 15507 was killed after the build was done
(2026-11-16 ~15:58 WIB) and the process stopped, but the recording is
**HELD, NOT SEALED**. `record --finish 01a1e375-d8a4-73b2-b9ed-9fedcc749925`
(run 2026-11-16 ~15:59 WIB) reports: the recorded Muse app sessions carry
no usage row, and an entry of Muse app sessions without one fails
`thinking_priced`; no usage row was read
(`~/.makefun/muse-usage-markdown-render-speed-02.jsonl`: no file of rows
there). The finish command says to seal it with
`record --finish 01a1e375-d8a4-73b2-b9ed-9fedcc749925 --muse-usage
/home/hatch/.makefun/muse-usage-markdown-render-speed-02.jsonl` once that
file exists. The usage-rows file was NOT produced by this build session.
The finish output also warns that the parent agent's session
(`974a38f8…`, first message 2026-11-16T08:13:17Z) began before the
recording and was left out of the seal, and that 11 records of this build
session written after the recorder stopped are left out of the seal.

## What still blocks submission

1. **No GitHub repo yet.** The parent creates `ZulkifliMohamad/markswift`,
   pushes the local commit(s), and submits. Repo must be public and created
   at or after 2026-11-15T20:30:00Z; the submitted commit must be on a branch
   of it.
2. **Recording is held, not sealed (see above), and the session-timing
   risk.** RULES.txt says a session begun before the recording started
   fails the transcript check (`transcripts_witnessed`). This subagent
   session began before the recording started (the recording was started
   after I was spawned, because the repo had to exist first — the first
   record attempt failed with "not inside a git repository" until `git init`
   was run). The recording log and the `record --finish` output both carry
   the same warning, and the parent session was left out of the seal for
   the same reason. The seal also needs the usage-rows file described
   above. Until the recording is sealed, the entry cannot be submitted
   with it; a fresh recording + rebuild in a new session (the route Feb
   chose for ai-excited-01) is the fallback if the held seal cannot be
   completed.
3. **Speed margin.** 1.27x CPU, not the 2x target. It should still beat the
   baseline at 95% confidence, but the margin is thinner than intended.
