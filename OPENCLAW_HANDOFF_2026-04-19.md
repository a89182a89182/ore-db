# ORE 交班日誌

更新時間：2026-04-19 Asia/Taipei
適用對象：另一台電腦上的 OpenClaw
工作目錄：`C:\Users\YOSHI\Documents`

## 你現在要負責的事

### 1. ORE Weekly Snapshot
- Automation ID: `ore-weekly-snapshot`
- 設定檔：`C:\Users\YOSHI\.codex\automations\ore-weekly-snapshot\automation.toml`
- 記憶檔：`C:\Users\YOSHI\.codex\automations\ore-weekly-snapshot\memory.md`
- 目前排程：每週六 20:00 Asia/Taipei
- 主腳本：`C:\Users\YOSHI\Documents\ore-db\archive_players_snapshot.py`

目標：
- 抓 ORE 當前 live 球季資料
- 保存當天 raw HTML 到 `ore-db/live-YYYY-MM-DD/`
- 更新當前球季的 `ore-db/season-{season}/players.json`
- 另存 dated snapshot 到 `ore-db/season-{season}/snapshots/YYYY-MM-DD_players.json`
- 如果站上已有本季累積成績，合併到 `season_summary`
- 如果站上還沒有本季累積成績，也一樣要先把新球季名單存下來

### 2. ORE Sunday Preview
- Automation ID: `ore-sunday-preview`
- 設定檔：`C:\Users\YOSHI\.codex\automations\ore-sunday-preview\automation.toml`
- 記憶檔：`C:\Users\YOSHI\.codex\automations\ore-sunday-preview\memory.md`
- 目前排程：每週日 20:15 Asia/Taipei

目標：
- 根據 live roster + 本地歷史球季資料做下季戰力預測
- 產出兩聯盟排名、冠軍預測、fantasy team
- 需要參考 `season-*` 下的歷史資料，不可只看當季 roster

## 目前狀態

截至 2026-04-18 20:02:42 +08:00：
- live 球季已經是 `766`
- 目前日數是 `5`
- 已成功初始化 `season-766`
- 本地已存在：
  - `C:\Users\YOSHI\Documents\ore-db\season-766\players.json`
  - `C:\Users\YOSHI\Documents\ore-db\season-766\meta.json`
  - `C:\Users\YOSHI\Documents\ore-db\season-766\season_snapshot.json`
  - `C:\Users\YOSHI\Documents\ore-db\season-766\snapshots\2026-04-18_players.json`
  - `C:\Users\YOSHI\Documents\ore-db\live-2026-04-18\`
- 目前 `summary_rows = 0`
- 目前 `players_with_summary = 0`

這代表：
- 新球季資料已經先保住了
- 但站上目前還沒有可合併的 `AVG` / `ERA` 這類本季累積成績
- 這是正常狀態，不是失敗

## 目前資料到底有存什麼

### `season-{season}/players.json`
每位球員會存：
- 基本資料：`season`、`team`、`name`、`owner`、`category`、`position_or_role`
- 能力
  - 野手：`power`、`contact`、`speed`、`arm`、`defense`
  - 投手：`control`、`stamina`、`velocity`、`pitch_mix`
- 技能：`skills`
- 合約：`contract`、`cash`、`salary`
- 年齡與年資：`age`、`experience`
- 當前頁面數據
  - 野手：`current_batting`
  - 投手：`current_pitching`
- 生涯數據
  - 野手：`career_batting`
  - 投手：`career_pitching`
- 如果站上有本季累積成績，才會再多：
  - `season_summary`
  - 投手另有 `season_summary_role`

### `season-{season}/season_snapshot.json`
每隊會存：
- `team`、`league`、`last_season_rank`
- `current_status`
- `league_rank`
- `games_played`、`win_pct`、`wins`、`losses`、`ties`、`streak`
- `remaining_games`、`remaining_today_games`
- `batting_avg`、`era`、`runs_per_game`、`home_runs`、`steals`、`errors`
- 該隊完整 `batters` 與 `pitchers`

### `live-YYYY-MM-DD/`
raw HTML 快取，現在會保存：
- `saku_0.html` 到 `saku_11.html`
- `kakuninn.html`
- `history.html`

## 重要規則

### 規則 1：球季切換時，要先保新球季
只要 live 頁面顯示球季換到新季，就算還沒有 `AVG` / `ERA`，也要先把：
- `season-{season}/players.json`
- `season-{season}/meta.json`
- `season-{season}/season_snapshot.json`
- dated snapshot
全部存出來。

### 規則 2：不要再把舊快取當成最新資料
這件事 2026-04-17 已經出過一次錯。

曾經的 bug：
- live 抓不到時，腳本直接回退到本機最後一份 `live-*`
- 當時最新快取停在 `live-2026-04-13`
- 結果 2026-04-17 的 automation 把資料錯寫成 `season-765`

現在修正後：
- `scrape_ore.py` 每次成功抓 live，都會把 `saku_*.html` 落地到今天的 `live-YYYY-MM-DD`
- 回退快取時只接受 48 小時內的新鮮快取
- `archive_players_snapshot.py` 也會保存 `kakuninn.html`、`history.html`
- 如果只剩過舊快取，不要寫檔，應報 blocker

### 規則 3：沒有 summary 也算成功
如果 `kakuninn` 頁沒有 `AVG:` / `ERA:`：
- 仍然要存球員名單與球隊狀態
- `summary_rows` 應為 `0`
- `players_with_summary` 應為 `0`
- 不要把這種情況誤判為失敗

### 規則 4：Sunday Preview 不能只看當前 roster
做週日預測時，還要一起讀：
- `season-*/players.json`
- `season-*/season_snapshot.json`
- `season-*/meta.json`
- `season-*/championship.json`

## 你該怎麼做

### A. 手動跑 snapshot
在 `C:\Users\YOSHI\Documents` 執行：

```powershell
py -3 ore-db/archive_players_snapshot.py
```

成功後至少要看到：
- `season=766` 或當前 live 球季
- `players=192` 左右
- `latest_players=...season-{season}\players.json`
- `output=...snapshots\YYYY-MM-DD_players.json`

### B. 手動檢查當前球季
優先看：
- `C:\Users\YOSHI\Documents\ore-db\season-766\meta.json`
- `C:\Users\YOSHI\Documents\ore-db\season-766\players.json`
- `C:\Users\YOSHI\Documents\ore-db\live-2026-04-18\`

### C. 驗證 summary 是否已開始出現
判斷標準：
- `meta.json` 內 `summary_rows > 0`
- `players_with_summary > 0`

如果開始出現，代表這季已經可以真正累積 `season_summary`。

## 現在最重要的下一步

- 持續維護 `ore-weekly-snapshot`
- 每次跑完要確認寫入的是 live 當前球季，不是舊球季
- 等 `766` 球季出現 `AVG` / `ERA` 後，再確認 `season_summary` 已成功寫入
- `ore-sunday-preview` 也要繼續用同一套「先 live，失敗再新鮮快取，並明示來源」的原則

## 你不需要重新做的事

- 不需要重建 `season-766`，它已經存在
- 不需要回頭重修 2026-04-18 的 snapshot，除非你發現 live 內容和本地檔案不一致
- 不需要再把舊的 `live-2026-04-13` 當成 current season data

## 快速結論

一句話版本：

你現在的責任是保證 ORE 的 weekly snapshot 永遠跟著 live 當前球季走，先保住新球季名單，再在 summary 出現後補齊本季成績，而且絕對不能再讓過舊快取把資料寫回前一季。
