# csv-reader-speed-01-run-20261121

[![bounty](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/adhityanaufal26/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/adhityanaufal26/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard)

A faster drop-in for make.fun's csv-reader 1.0.0: `solve.js` exports `run({text, header})` returning exactly csv-reader's `{columns, rows, errors}` answer on every input — BOM handling, stray CRs, quoted fields with doubled quotes and embedded line breaks, quote junk, unterminated quotes, and ragged rows all included — while scanning each text once with bulk slices instead of per-character string building. Verified identical to the reference on the practice set and on tens of thousands of generated broken-CSV cases, at roughly a tenth of the reference's CPU time locally.

## Run it

`node main.ts` reads `/input/cases.json` and writes `/output/answers.json` (set `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` locally to choose other directories). Node 22, no dependencies.

Built for [make.fun](https://make.fun/).
