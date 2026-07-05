# ORE Fantasy Draft Skill

Use this skill for:

- ORE fantasy lineup generation
- HR-mode lineup selection
- SB-mode lineup selection
- ORE lineup legality checking

## Required Reads

Before using this skill:

1. Read `C:\Users\YOSHI\.codex\automations\ore-sunday-preview\openclaw-handoff.md`
2. Read `C:\Users\YOSHI\.codex\automations\ore-sunday-preview\memory.md`
3. Treat `.openclaw` paths as legacy-only. New ORE tools, reports, and review artifacts belong under `C:\Users\YOSHI\Documents\ore-db`.

## Canonical Solver

The canonical solver is:

- `C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\draft.js`
- `C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\projection.js`
- Sunday K/SV/RBI public report renderer: `C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\render-k-sv-rbi-html-report.js`.
- Reusable K/ERA signal audit: `C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\audit-k-era-signal.js`.
- Reusable league-rank signal audit: `C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\audit-league-rank-signal.js`.
- Reusable post-result category position loop: `C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\review-category-position-loop.js`.
- First-place item selector for the next Sunday run: `C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\select-first-place-items.js`.
- Weight-profile trainer and diagnostic overfit sandbox: `C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\fit-item-weight-profile.js`.

Do not base new ORE fantasy decisions on old archive-parsing utilities or exploratory scripts.

## Inputs

The solver should use:

- live ORE first when available
- newest local `C:\Users\YOSHI\Documents\ore-db\live-*` fallback if live fails
- current season local files under `C:\Users\YOSHI\Documents\ore-db\season-*`
- historical season files as model-training input only
- `C:\Users\YOSHI\Documents\ore-db\reports\ore_projection_snapshot.json` as the standings / forecast artifact

## Hard Rules

- Same-player direct history carry-forward weight is `0`
- Historical results train the projection model only; never add team-name, championship, or prior-rank bonuses
- For formal fantasy lineups, age `43+` is retirement/regeneration risk and must be hard-excluded, not merely downweighted. Age `42` is still usable. If live pitcher rows expose a player as `(43)`, that player must be excluded even when the source match is missing.
- Sunday fantasy item priority is first-place-oriented and must be chosen from the latest complete Friday outcome review. Do not hard-code K/SV/RBI if newer evidence shows another item has stronger first-place probability. SB is review-only unless explicitly requested, because other GMs can manipulate team stealing strategy.
- K RP strikeout calibration is regularized in `draft.js`: do not restore the old high RP skill multiplier (`skillScore * 5.0`) unless a before/after review using prior seasons as training and a later season as holdout shows first-place improvement. The 2026-06-26 SV weight experiment was rejected and reverted because it worsened holdout results.
- Official Sunday runs may use only `diagnosticOnly=false` weight profiles. A `diagnosticOnly=true` profile must require explicit `--allow-diagnostic-profile` and is never a production recommendation profile.
- Friday outcome review must run the weight-profile trainer after a PASS all-item review: private `diagnostic-overfit`, oracle capacity check, miss matrix, and formal `train-holdout`. The success metric is item rank `#1`; top10/top3 are diagnostics only. An item may stop short of rank `#1` only when oracle capacity check also marks it as a hard blocker.
- `盜壘戰術 = 1` is a hard no-run gate for SB reasoning
- If submission readiness marks the primary fantasy item as `red`, or as caution-level with no safe item/variant alternate, return `recheck_required` instead of a direct submit action
- Outcome review must derive the target season from the delivered public report URL/title before writing training labels
- Illegal lineups must not be returned
- For one-category modes, the target category core is primary and non-target positions are legal fillers. In ERA/W/SV/K pitcher modes, pitchers are the scoring core and batters are legal fillers; in AVG/HR/RBI/SB batter modes, batters are the scoring core and pitchers are legal fillers. Do not judge one-category lineups by overall fantasy rank.

## Legality Checklist

Every final lineup must pass:

- 18 total
- 9 batters
- 9 pitchers
- 5 SP
- 3 RP
- 1 CP
- full batter grid
- all 12 teams represented
- max 2 players per team

## Commands

Refresh the projection artifact:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\projection.js
```

HR mode:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\draft.js hr
```

SB mode:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\draft.js sb
```

K/ERA current-result signal audit after paired K and ERA drafts:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\audit-k-era-signal.js --season-dir=<fresh season dir>
```

Use this audit before final weekly item priority recommendations. It compares the selected K and ERA variants with current K/ERA leaderboards, reports top10/top20 overlap, best current variant, and missed current leaders.

League ranking current-result signal audit after projection:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\audit-league-rank-signal.js --season-dir=<fresh season dir>
```

Use this audit before final ranking recommendations. It compares projected league rankings with current standings, reports exact rank matches, average rank error, champion-pick alignment, and largest current rank drifts.

Post-result category position loop:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\review-category-position-loop.js --public-html <delivered public report html> --actual-dir <fantasy snapshot dir> --items all --out <review json> --md-out <review md>
```

Use this after complete fantasy results are archived. It covers AVG/HR/RBI/SB/ERA/W/SV/K, compares each delivered variant against actual GM rosters by category-relevant positions first when variants exist, checks whether any exact core/full match won first place, records top10 role/position consensus only as diagnostic context, and writes account-overlap evidence so the next weekly model loop learns from the right target instead of overall fantasy rank. In ORE fantasy, only first place is prize-winning; do not describe top10/top3 as success.

First-place item selection calibration:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\select-first-place-items.js --training-review <prior complete all-item review json> --holdout-review <latest complete all-item review json> --delivered-verdict <latest Sunday outcome verdict json> --user-accounts <prediction-user account review json> --target-season <target season> --max-training-season <source/training season> --out <selection json> --md-out <selection md>
```

Use this after the all-item outcome review. It treats prior completed seasons as training evidence and the latest completed season as holdout judgment, then updates Sunday item priority toward first-place probability. It must not feed holdout winners back into player scoring weights. Scoped weight changes are allowed only when the miss pattern is visible from training evidence and the later holdout improves without breaking the training result.

When rendering the formal combined K/ERA HTML report, pass both audit JSON files and require them:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\render-k-era-html-report.js --audit=<item audit json> --league-audit=<league audit json> --require-audits
```

Validation must fail if either audit is missing or if the audit target/source season, source day, or report input paths do not match the rendered projection/K/ERA artifacts. Rerun the audits instead of reusing stale JSON.

Weekly goal monitor:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\YOSHI\.codex\automations\ore-weekly-snapshot\run-weekly-goal-monitor.ps1 -Publish
```

Use this for Friday or pre-deadline monitoring of Lei's goal. It runs a fresh scrape, rebuilds projection plus K/ERA drafts, runs both audits, renders with `--require-audits`, publishes the validated report, and writes `ore_<targetSeason>_weekly_goal_monitor_summary_<date>.json/md`.

Optional output path:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\draft.js hr --out C:\path\to\report.json
```

Weight profile:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\draft.js hr --weight-profile C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\weight-profiles\formal-latest.json
```

Private diagnostic overfit sandbox:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\fit-item-weight-profile.js --mode diagnostic-overfit
```

Formal train/holdout profile generation:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\fit-item-weight-profile.js --mode train-holdout
```

Friday first-place trainer loop after all-item PASS:

```powershell
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\fit-item-weight-profile.js --mode diagnostic-overfit --date-label <yyyy-MM-dd> --source-season <sourceSeason> --target-season <targetSeason> --season-dir <source season dir> --live-dir <source live dir> --final-season-dir <target season dir> --fantasy-dir <complete fantasy snapshot dir> --max-training-season <sourceSeason> --reports-dir C:\Users\YOSHI\Documents\ore-db\reports
node C:\Users\YOSHI\Documents\ore-db\skills\ore-fantasy-draft\fit-item-weight-profile.js --mode train-holdout --date-label <yyyy-MM-dd> --source-season <sourceSeason> --target-season <targetSeason> --season-dir <source season dir> --live-dir <source live dir> --final-season-dir <target season dir> --fantasy-dir <complete fantasy snapshot dir> --max-training-season <sourceSeason> --reports-dir C:\Users\YOSHI\Documents\ore-db\reports
```

## Expected Behavior

- Refresh or reuse a current `ore_projection_snapshot.json` before ranking teams or selecting players
- Standings logic should come from projected player stats aggregated into team offense / pitching scores
- If live fetch succeeds, use live data and record that source
- If live fetch fails, use the newest valid local fallback and record that source
- If no legal lineup exists, fail explicitly
- Never output a fake or incomplete “best effort” lineup as if it were legal
