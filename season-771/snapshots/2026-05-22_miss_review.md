# 2026-05-22 Fantasy Miss Review

## Scope

- Reviewed the season 770 fantasy result visible on the public ORE home/news page, posted `05/15 22:45`.
- Public outcome summary showed 75 participants. Category winners included `HR owner=老子`, `SB owner=傑尼斯`, and `SV owner=瑟七拳擊手`.
- The complete crowd-pick list was not fetched. Stored credentials imported and were used, but authenticated fantasy attempts still returned only the public home/news page.
- No full season-770 Codex lineup artifact was found locally, so this review uses `2026-05-15_fantasy_audit_status.json` plus the public outcome summary.

## HR+SV

This was not a total model collapse on hitters. The audit had 6 batter slot winners and all 9 batter slots in the top 3. The miss was mostly in the saves side.

- Selected CP: `落月民` finished with 20 saves, rank 7 of 99.
- Save leaders were `摸摸二世` 32 SV, `龜甲斐` 30 SV, and `朗希八神` 25 SV.
- Two selected RP slots, `老弱殘兵` and `台鳳`, finished with only 1 save each.

Why it missed:

- The save model did not penalize RP slots hard enough. Middle relievers with good control/stamina or useful skills were allowed to look relevant for a saves target, even though their real save path was nearly zero.
- CP selection leaned too much on historical/player traits and not enough on team save opportunity and closer monopoly. `落月民` was playable, but not category-winning.
- The model should have treated non-CP saves as near-zero unless the current roster/context clearly shows RP save usage.

## SB+SV

The closer choice was actually good: `龜甲斐` finished rank 2 with 30 saves. The biggest preventable miss was the 3B steal pick.

- Selected 3B: `勒邦占士一` finished with 0 steals, rank 9 of 11 at 3B.
- Actual 3B steal leaders included `方舟十三` 12 SB, `章國珍` 11 SB, and `嘴平伊之助` 11 SB.
- Source profile warning signs were already there: speed 5, no steal skill, and career 19 SB in 2502 AB.
- One RP slot, `台鳳`, also contributed only 1 save.

Why it missed:

- The SB model over-trusted sparse/position-filling logic. A player with speed 5, no steal skill, and low career SB rate should not survive into an SB lineup.
- Position scarcity was handled too softly. At weak positions, the model accepted a low-steal 3B instead of using stricter floor rules.
- The model did not separate "can hit enough to stay useful" from "can actually win the steal category"; `勒邦占士一` had acceptable general batter value, but not an SB profile.

## Process Fixes

- Always include a miss-review section in weekly fantasy audit output, even when the complete crowd-pick list is blocked.
- Save generated Codex lineups as structured JSON for each target season, not only text/status summaries.
- Add hard filters for SB lineups: minimum speed, steal-skill bonus, career/current SB rate, and position-specific steal floor.
- Add hard penalties for RP save projections unless current evidence shows the RP is receiving saves.
- For CP picks, rank save opportunity first: team strength, expected close-game volume, current closer role, and prior closer usage should outweigh generic pitcher ability.
