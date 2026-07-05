param(
  [string]$OutRoot = '',
  [int]$Season = 0,
  [string]$DateLabel = (Get-Date -Format 'yyyy-MM-dd'),
  [string]$ManualFantasyList = '',
  [string]$ManualRoster = '',
  [string]$ManualLeaders = '',
  [string]$ManualTeamRankings = '',
  [int]$ExpectedFantasyRows = 0,
  [switch]$SkipLiveFetch,
  [string]$CredentialPath = 'C:\Users\YOSHI\.codex\secrets\ore-auth.credential.xml',
  [string]$LoginTeam = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$ScriptRoot = Split-Path -Parent $PSCommandPath
if (!$OutRoot) { $OutRoot = $ScriptRoot }

$OreUrl = 'http://game.tinycafe.com/ore/ore.cgi'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Codex ORE Fantasy Snapshot'
$Cp950 = [System.Text.Encoding]::GetEncoding(950)
$CookieJar = [System.Net.CookieContainer]::new()

function U {
  param([int[]]$CodePoints)
  return -join ($CodePoints | ForEach-Object { [char]$_ })
}

$Text = [ordered]@{
  LoginTeam = U @(0x7D71, 0x4E00, 0x7345, 0x968A)
  LoginButton = U @(0x767B, 0x5165)
  FantasyButton = U @(0x5922, 0x5E7B, 0x7403, 0x968A)
  LeagueRankButton = U @(0x672C, 0x5B63, 0x6392, 0x884C)
  RosterButton = U @(0x9663, 0x5BB9, 0x4ECB, 0x7D39)
  PleaseLogin = U @(0x8ACB, 0x5148, 0x767B, 0x5165)
  FullFantasyList = U @(0x672C, 0x5B63, 0x5922, 0x5E7B, 0x7403, 0x968A, 0x5B8C, 0x6574, 0x540D, 0x55AE)
  RankHeader = U @(0x6392, 0x540D)
  ChampionLabel = U @(0x51A0, 0x8ECD)
  ChineseLeague = U @(0x4E2D, 0x83EF, 0x806F, 0x76DF)
  TaiwanLeague = U @(0x53F0, 0x7063, 0x806F, 0x76DF)
  Salary = U @(0x5E74, 0x85AA)
  TripleStar = -join @([char]0x2605, [char]0x2605, [char]0x2605)
}

if (!$LoginTeam) { $LoginTeam = $Text.LoginTeam }

function Write-Utf8File {
  param(
    [string]$Path,
    [string]$Body
  )
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Body, [System.Text.UTF8Encoding]::new($false))
}

function Read-TextGuess {
  param([string]$Path)
  [byte[]]$bytes = [System.IO.File]::ReadAllBytes($Path)
  try {
    return [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
  } catch {
    return $Cp950.GetString($bytes)
  }
}

function Get-Sha256 {
  param([string]$TextValue)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($TextValue)
    return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $sha.Dispose()
  }
}

function ConvertTo-SafeJson {
  param(
    [object]$Value,
    [int]$Depth = 30
  )
  $json = ConvertTo-Json -InputObject $Value -Depth $Depth
  return [regex]::Replace($json, '[^\u0000-\u007F]', {
    param($Match)
    $escaped = foreach ($char in $Match.Value.ToCharArray()) {
      '\u{0:x4}' -f [int][char]$char
    }
    return ($escaped -join '')
  })
}

function Encode-FormComponent {
  param([string]$Value)
  $builder = [System.Text.StringBuilder]::new()
  foreach ($byte in $Cp950.GetBytes([string]$Value)) {
    $isAlphaNum = (
      ($byte -ge 0x30 -and $byte -le 0x39) -or
      ($byte -ge 0x41 -and $byte -le 0x5A) -or
      ($byte -ge 0x61 -and $byte -le 0x7A)
    )
    if ($isAlphaNum -or $byte -eq 0x2D -or $byte -eq 0x2E -or $byte -eq 0x5F) {
      [void]$builder.Append([char]$byte)
    } elseif ($byte -eq 0x20) {
      [void]$builder.Append('+')
    } else {
      [void]$builder.Append('%')
      [void]$builder.Append($byte.ToString('X2'))
    }
  }
  return $builder.ToString()
}

function ConvertTo-FormBody {
  param([System.Collections.IDictionary]$Form)
  $pairs = foreach ($key in $Form.Keys) {
    "$(Encode-FormComponent $key)=$(Encode-FormComponent ([string]$Form[$key]))"
  }
  return ($pairs -join '&')
}

function Invoke-OrePost {
  param([System.Collections.IDictionary]$Form)
  $body = ConvertTo-FormBody $Form
  $bytes = $Cp950.GetBytes($body)
  $request = [System.Net.HttpWebRequest]::Create($OreUrl)
  $request.Method = 'POST'
  $request.UserAgent = $UserAgent
  $request.ContentType = 'application/x-www-form-urlencoded'
  $request.CookieContainer = $CookieJar
  $request.ContentLength = $bytes.Length
  $request.Timeout = 30000
  $request.ReadWriteTimeout = 30000

  $requestStream = $request.GetRequestStream()
  try {
    $requestStream.Write($bytes, 0, $bytes.Length)
  } finally {
    $requestStream.Dispose()
  }

  $response = $request.GetResponse()
  try {
    $reader = [System.IO.StreamReader]::new($response.GetResponseStream(), $Cp950)
    try {
      return [pscustomobject]@{
        StatusCode = [int]$response.StatusCode
        Text = $reader.ReadToEnd()
      }
    } finally {
      $reader.Dispose()
    }
  } finally {
    $response.Dispose()
  }
}

function Invoke-OreGet {
  param([System.Collections.IDictionary]$Query)
  $queryText = ConvertTo-FormBody $Query
  $request = [System.Net.HttpWebRequest]::Create("$OreUrl`?$queryText")
  $request.Method = 'GET'
  $request.UserAgent = $UserAgent
  $request.CookieContainer = $CookieJar
  $request.Timeout = 30000
  $request.ReadWriteTimeout = 30000

  $response = $request.GetResponse()
  try {
    $reader = [System.IO.StreamReader]::new($response.GetResponseStream(), $Cp950)
    try {
      return [pscustomobject]@{
        StatusCode = [int]$response.StatusCode
        Text = $reader.ReadToEnd()
      }
    } finally {
      $reader.Dispose()
    }
  } finally {
    $response.Dispose()
  }
}

function Get-InputValue {
  param(
    [string]$Html,
    [string]$Name
  )
  $escaped = [regex]::Escape($Name)
  $tagMatch = [regex]::Match($Html, "<input\b[^>]*\bname\s*=\s*[""']?$escaped[""']?[^>]*>", 'IgnoreCase')
  if (!$tagMatch.Success) { return $null }
  $valueMatch = [regex]::Match($tagMatch.Value, "\bvalue\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>]+))", 'IgnoreCase')
  if (!$valueMatch.Success) { return '' }
  foreach ($index in 1..3) {
    if ($valueMatch.Groups[$index].Success) { return $valueMatch.Groups[$index].Value }
  }
  return ''
}

function Protect-HtmlSecrets {
  param([string]$Html)
  $secretNames = 'pass|kojin|ok2|ok3|ok4'
  return [regex]::Replace(
    $Html,
    "(?i)(name\s*=\s*[""']?(?:$secretNames)[""']?[^>]*\bvalue\s*=\s*)(?:""[^""]*""|'[^']*'|[^\s>]+)",
    '$1"[redacted]"'
  )
}

function Remove-Html {
  param([string]$Html)
  $text = [regex]::Replace($Html, '<br\s*/?>', "`n", 'IgnoreCase')
  $text = [regex]::Replace($text, '</(?:td|th)>', "`t", 'IgnoreCase')
  $text = [regex]::Replace($text, '</tr>', "`n", 'IgnoreCase')
  $text = [regex]::Replace($text, '<[^>]+>', "`t")
  $text = [System.Net.WebUtility]::HtmlDecode($text)
  $text = [regex]::Replace($text, '[ ]+', ' ')
  $text = [regex]::Replace($text, '\t+', "`t")
  $text = [regex]::Replace($text, '\s*\n\s*', "`n")
  return $text.Trim()
}

function Test-PleaseLogin {
  param([string]$Html)
  return $Html.Contains($script:Text.PleaseLogin)
}

function New-AuthStateFantasyForm {
  param(
    [string]$LoginHtml,
    [string]$Hello
  )
  $form = [ordered]@{}
  foreach ($name in @('saku', 'pass', 'sakusya', 'kojin', 'ok1', 'ok2', 'ok3', 'ok4', 'ok', 'team')) {
    $value = Get-InputValue -Html $LoginHtml -Name $name
    if ($null -ne $value) { $form[$name] = $value }
  }
  if ($Hello) { $form['hello'] = $Hello }
  $form['fantasy'] = $Text.FantasyButton
  return $form
}

function Get-InferredSeason {
  $seasonDirs = @(Get-ChildItem -LiteralPath $OutRoot -Directory -Filter 'season-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^season-(\d+)$' } |
    ForEach-Object { [int]$Matches[1] })
  if (!$seasonDirs.Count) { return 0 }
  return ($seasonDirs | Measure-Object -Maximum).Maximum
}

function Parse-FantasyRows {
  param([string]$TextValue)
  $pickColumns = @('C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'RP1', 'RP2', 'RP3', 'CP')
  $rows = @()
  foreach ($line in ($TextValue -split '\r?\n')) {
    $cols = @($line -split "`t")
    if ($cols.Count -lt 25) { continue }
    if ($cols[0].Trim() -notmatch '^\d+$') { continue }
    $picks = [ordered]@{}
    for ($i = 0; $i -lt $pickColumns.Count; $i++) {
      $picks[$pickColumns[$i]] = $cols[7 + $i].Trim()
    }
    $rows += [pscustomobject]@{
      rank = [int]$cols[0].Trim()
      account = $cols[1].Trim()
      averageAge = $cols[2].Trim()
      batterAverageSalary = $cols[3].Trim()
      pitcherAverageSalary = $cols[4].Trim()
      battingTotal = $cols[5].Trim()
      pitchingTotal = $cols[6].Trim()
      picks = $picks
    }
  }
  return @($rows)
}

function Convert-NumberOrNull {
  param([string]$Value)
  $number = 0.0
  if ([double]::TryParse($Value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    return $number
  }
  return $null
}

function Build-DerivedCategoryLeaders {
  param([object[]]$FantasyRows)
  $statRows = @()
  foreach ($row in $FantasyRows) {
    $batting = [regex]::Match([string]$row.battingTotal, '^\s*([0-9]+(?:\.[0-9]+)?)\s+([0-9]+)\D+([0-9]+)\D+([0-9]+)')
    $pitching = [regex]::Match([string]$row.pitchingTotal, '^\s*([0-9]+(?:\.[0-9]+)?)\s+([0-9]+)\D+([0-9]+)\D+([0-9]+)\s*K')
    $statRows += [pscustomobject]@{
      rank = $row.rank
      account = $row.account
      AVG = if ($batting.Success) { Convert-NumberOrNull $batting.Groups[1].Value } else { $null }
      HR = if ($batting.Success) { [int]$batting.Groups[2].Value } else { $null }
      RBI = if ($batting.Success) { [int]$batting.Groups[3].Value } else { $null }
      SB = if ($batting.Success) { [int]$batting.Groups[4].Value } else { $null }
      ERA = if ($pitching.Success) { Convert-NumberOrNull $pitching.Groups[1].Value } else { $null }
      W = if ($pitching.Success) { [int]$pitching.Groups[2].Value } else { $null }
      SV = if ($pitching.Success) { [int]$pitching.Groups[3].Value } else { $null }
      K = if ($pitching.Success) { [int]$pitching.Groups[4].Value } else { $null }
    }
  }

  $leaders = [ordered]@{}
  foreach ($spec in @(
    @{ key = 'AVG'; descending = $true },
    @{ key = 'HR'; descending = $true },
    @{ key = 'RBI'; descending = $true },
    @{ key = 'SB'; descending = $true },
    @{ key = 'ERA'; descending = $false },
    @{ key = 'W'; descending = $true },
    @{ key = 'SV'; descending = $true },
    @{ key = 'K'; descending = $true }
  )) {
    $key = $spec.key
    $available = @($statRows | Where-Object { $null -ne $_.$key })
    if ($spec.descending) {
      $leaders[$key] = @($available | Sort-Object -Property @{ Expression = $key; Descending = $true }, @{ Expression = 'rank'; Descending = $false } | Select-Object -First 10)
    } else {
      $leaders[$key] = @($available | Sort-Object -Property @{ Expression = $key; Descending = $false }, @{ Expression = 'rank'; Descending = $false } | Select-Object -First 10)
    }
  }
  return $leaders
}

function Parse-RosterEntries {
  param([string]$TextValue)
  $matches = [regex]::Matches($TextValue, '(?m)(?:^|\t)(C|1B|2B|3B|SS|LF|CF|RF|DH|SP|RP|CP)\.[ \t]*([^\r\n\t]+)')
  $entries = @()
  foreach ($match in $matches) {
    $entries += [pscustomobject]@{
      position = $match.Groups[1].Value
      name = $match.Groups[2].Value.Trim()
    }
  }
  return @($entries)
}

function Parse-LeaderRows {
  param([string]$TextValue)
  $rows = @()
  $current = ''
  foreach ($line in ($TextValue -split '\r?\n')) {
    $trimmed = $line.Trim()
    if (!$trimmed) { continue }
    if ($trimmed.Contains($Text.TripleStar)) {
      $clean = $trimmed.Replace($Text.TripleStar, '').Trim()
      if ($clean) { $current = $clean }
      continue
    }
    if (!$current) { continue }
    if ($trimmed -notmatch '^[0-9]+(?:\.[0-9]+)?\s+') { continue }
    $parts = @($trimmed -split '\s+' | Where-Object { $_ })
    if ($parts.Count -lt 2) { continue }
    $team = $null
    $account = $parts[1]
    if ($parts.Count -ge 3) {
      $team = $parts[1]
      $account = $parts[2]
    }
    $rows += [pscustomobject]@{
      category = $current
      value = $parts[0]
      team = $team
      account = $account
      rawLine = $trimmed
    }
  }
  return @($rows)
}

function Parse-TeamRankings {
  param([string]$TextValue)
  $rows = @()
  $leagueIndex = -1
  $leagueNames = @($Text.ChineseLeague, $Text.TaiwanLeague)
  $championPattern = [regex]::Escape($Text.ChampionLabel)
  $rawLines = @($TextValue -split '\r?\n')
  $logicalLines = @()
  for ($i = 0; $i -lt $rawLines.Count; $i++) {
    $trimmedLine = $rawLines[$i].Trim()
    if ($trimmedLine -match "^($championPattern|\d+)$" -and ($i + 1) -lt $rawLines.Count) {
      $nextLine = $rawLines[$i + 1].Trim()
      if ($nextLine -and $nextLine -notmatch "^($championPattern|\d+)$") {
        $logicalLines += "$trimmedLine`t$nextLine"
        $i += 1
        continue
      }
    }
    $logicalLines += $rawLines[$i]
  }
  foreach ($line in $logicalLines) {
    $trimmed = $line.Trim()
    if (!$trimmed) { continue }
    if ($trimmed.StartsWith($Text.RankHeader)) {
      $leagueIndex += 1
      continue
    }
    if ($trimmed -notmatch "^($championPattern|\d+)\s+") { continue }
    $cols = @($trimmed -split "`t")
    if ($cols.Count -lt 14) {
      $cols = @($trimmed -split '\s+' | Where-Object { $_ })
    }
    if ($cols.Count -lt 14) { continue }
    $rankLabel = $cols[0].Trim()
    $rankNumber = if ($rankLabel -eq $Text.ChampionLabel) { 1 } else { [int]$rankLabel }
    $league = if ($leagueIndex -ge 0 -and $leagueIndex -lt $leagueNames.Count) { $leagueNames[$leagueIndex] } else { "league-$($leagueIndex + 1)" }
    $statOffset = if ($cols.Count -ge 15) { 3 } else { 2 }
    $rows += [pscustomobject]@{
      league = $league
      rankLabel = $rankLabel
      rank = $rankNumber
      isChampion = ($rankLabel -eq $Text.ChampionLabel -or $rankNumber -eq 1)
      team = $cols[1].Trim()
      previousSeasonRank = if ($cols.Count -ge 15) { $cols[2].Trim() } else { $null }
      games = [int]$cols[$statOffset]
      wins = [int]$cols[$statOffset + 1]
      losses = [int]$cols[$statOffset + 2]
      ties = [int]$cols[$statOffset + 3]
      streak = [int]$cols[$statOffset + 4]
      winningPercentage = $cols[$statOffset + 5].Trim()
      battingAverage = $cols[$statOffset + 6].Trim()
      era = $cols[$statOffset + 7].Trim()
      runRate = $cols[$statOffset + 8].Trim()
      homeRuns = [int]$cols[$statOffset + 9]
      steals = [int]$cols[$statOffset + 10]
      errors = [int]$cols[$statOffset + 11]
    }
  }
  return @($rows)
}

function Convert-GroupCounts {
  param(
    [object[]]$Rows,
    [string]$Property
  )
  $counts = [ordered]@{}
  foreach ($group in ($Rows | Group-Object -Property $Property)) {
    if ($group.Name) { $counts[$group.Name] = $group.Count }
  }
  return $counts
}

function Save-Page {
  param(
    [string]$Name,
    [string]$Html,
    [string]$SnapshotDir
  )
  $safeHtml = Protect-HtmlSecrets $Html
  $text = Remove-Html $safeHtml
  $htmlPath = Join-Path $SnapshotDir "$Name.html"
  $textPath = Join-Path $SnapshotDir "$Name.txt"
  Write-Utf8File $htmlPath $safeHtml
  Write-Utf8File $textPath $text
  return [pscustomobject]@{
    name = $Name
    htmlPath = $htmlPath
    textPath = $textPath
    length = $safeHtml.Length
    sha256 = Get-Sha256 $safeHtml
    asksLogin = Test-PleaseLogin $safeHtml
    fantasyRows = @(Parse-FantasyRows $text).Count
    rosterEntries = @(Parse-RosterEntries $text).Count
  }
}

function Save-RawText {
  param(
    [string]$SourcePath,
    [string]$DestinationPath
  )
  $text = Read-TextGuess $SourcePath
  Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force
  return $text
}

function Build-Validation {
  param(
    [string]$FantasyText,
    [string]$RosterText,
    [string]$LeaderText,
    [bool]$LeadersExpected,
    [string]$TeamRankingText,
    [bool]$TeamRankingsExpected
  )

  $fantasyRows = @(Parse-FantasyRows $FantasyText)
  $ranks = @($fantasyRows | ForEach-Object { $_.rank })
  $rankSequential = $false
  if ($ranks.Count -gt 0) {
    $rankSequential = -not (@(0..($ranks.Count - 1) | Where-Object { $ranks[$_] -ne ($_ + 1) }).Count)
  }

  $rosterEntries = @(Parse-RosterEntries $RosterText)
  $leaderRows = @(Parse-LeaderRows $LeaderText)
  $teamRankings = @(Parse-TeamRankings $TeamRankingText)
  $positionCounts = Convert-GroupCounts $rosterEntries 'position'
  $leaderCategoryCounts = Convert-GroupCounts $leaderRows 'category'
  $teamRankingLeagueCounts = Convert-GroupCounts $teamRankings 'league'
  $salaryPattern = [regex]::Escape($Text.Salary) + ':\s*[\d,]+'

  $failReasons = @()
  $warnings = @()
  $expectedRowsLabel = if ($ExpectedFantasyRows -gt 0) { $ExpectedFantasyRows } else { 'not fixed' }

  if ($ExpectedFantasyRows -gt 0) {
    if ($fantasyRows.Count -ne $ExpectedFantasyRows) {
      $failReasons += "fantasy full list rows expected $ExpectedFantasyRows, got $($fantasyRows.Count)"
    }
  } elseif ($fantasyRows.Count -le 0) {
    $failReasons += 'fantasy full list rows were not parsed'
  }
  if ($fantasyRows.Count -gt 0 -and !$rankSequential) {
    $failReasons += 'fantasy ranks are not sequential from 1'
  }
  if ($fantasyRows.Count -gt 0) {
    $badPickRows = @($fantasyRows | Where-Object { $_.picks.Keys.Count -ne 18 })
    if ($badPickRows.Count) { $failReasons += "fantasy rows with non-18 pick count: $($badPickRows.Count)" }
  }
  if ($rosterEntries.Count -ne 216) {
    $failReasons += "roster entries expected 216, got $($rosterEntries.Count)"
  }
  $salaryLines = [regex]::Matches($RosterText, $salaryPattern).Count
  if ($salaryLines -ne 216) {
    $warnings += "roster salary lines expected 216, got $salaryLines"
  }
  if ($LeadersExpected) {
    if ($leaderCategoryCounts.Keys.Count -ne 8) {
      $failReasons += "leader categories expected 8, got $($leaderCategoryCounts.Keys.Count)"
    }
    foreach ($category in $leaderCategoryCounts.Keys) {
      if ($leaderCategoryCounts[$category] -ne 10) {
        $failReasons += "leader category '$category' expected 10 rows, got $($leaderCategoryCounts[$category])"
      }
    }
  } else {
    $warnings += 'category leader raw text was not provided'
  }
  if ($TeamRankingsExpected) {
    if ($teamRankings.Count -ne 12) {
      $failReasons += "team rankings expected 12 rows, got $($teamRankings.Count)"
    }
    $championRows = @($teamRankings | Where-Object { $_.isChampion })
    if ($championRows.Count -ne 2) {
      $failReasons += "team ranking champions expected 2, got $($championRows.Count)"
    }
    foreach ($league in $teamRankingLeagueCounts.Keys) {
      if ($teamRankingLeagueCounts[$league] -ne 6) {
        $failReasons += "team ranking league '$league' expected 6 rows, got $($teamRankingLeagueCounts[$league])"
      }
    }
  } else {
    $warnings += 'team ranking raw text was not provided'
  }

  $status = if ($failReasons.Count) { 'BLOCKED' } else { 'PASS' }
  return [ordered]@{
    status = $status
    failReasons = @($failReasons)
    warnings = @($warnings)
    expectedFantasyRows = $expectedRowsLabel
    fantasyRows = $fantasyRows.Count
    fantasyRankSequential = $rankSequential
    fantasyColumnShape = '25 columns; 18 player picks'
    rosterEntries = $rosterEntries.Count
    rosterSalaryLines = $salaryLines
    positionCounts = $positionCounts
    leaderRows = $leaderRows.Count
    leaderCategoryCounts = $leaderCategoryCounts
    teamRankingRows = $teamRankings.Count
    teamRankingLeagueCounts = $teamRankingLeagueCounts
  }
}

if ($Season -le 0) {
  $Season = Get-InferredSeason
}
if ($Season -le 0) {
  throw 'Unable to infer season; pass -Season explicitly.'
}

$manualMode = [bool]($ManualFantasyList -or $ManualRoster -or $ManualLeaders -or $ManualTeamRankings)
$modeLabel = if ($manualMode) { 'manual' } else { 'live' }
$snapshotDir = Join-Path $OutRoot "fantasy-snapshots\season-$Season\$DateLabel-$modeLabel"
New-Item -ItemType Directory -Force -Path $snapshotDir | Out-Null

$sourceFiles = [ordered]@{}
$pageFetches = @()
$access = [ordered]@{
  mode = $modeLabel
  liveAttempted = $false
  credentialPathPresent = [bool](Test-Path -LiteralPath $CredentialPath)
  credentialImported = $false
  credentialUsed = $false
  loginSucceeded = $false
  helloFound = $false
}

$fantasyText = ''
$rosterText = ''
$leaderText = ''
$teamRankingText = ''

if ($manualMode) {
  if (!$ManualFantasyList -or !$ManualRoster) {
    throw 'Manual mode requires -ManualFantasyList and -ManualRoster.'
  }
  $fantasyDest = Join-Path $snapshotDir 'fantasy_full_list_raw.txt'
  $rosterDest = Join-Path $snapshotDir 'roster_introduction_raw.txt'
  $fantasyText = Save-RawText -SourcePath $ManualFantasyList -DestinationPath $fantasyDest
  $rosterText = Save-RawText -SourcePath $ManualRoster -DestinationPath $rosterDest
  $sourceFiles['manualFantasyList'] = $fantasyDest
  $sourceFiles['manualRoster'] = $rosterDest
  if ($ManualLeaders) {
    $leaderDest = Join-Path $snapshotDir 'fantasy_category_leaders_raw.md'
    $leaderText = Save-RawText -SourcePath $ManualLeaders -DestinationPath $leaderDest
    $sourceFiles['manualLeaders'] = $leaderDest
  }
  if ($ManualTeamRankings) {
    $teamRankingDest = Join-Path $snapshotDir 'team_rankings_raw.tsv'
    $teamRankingText = Save-RawText -SourcePath $ManualTeamRankings -DestinationPath $teamRankingDest
    $sourceFiles['manualTeamRankings'] = $teamRankingDest
  }
} elseif (!$SkipLiveFetch) {
  $access.liveAttempted = $true
  if (!(Test-Path -LiteralPath $CredentialPath)) {
    $access['blockedReason'] = 'credential_missing'
  } else {
    try {
      $credential = Import-Clixml -LiteralPath $CredentialPath
      $access.credentialImported = $true
      $access.credentialUsed = $true
      $password = $credential.GetNetworkCredential().Password
      $login = Invoke-OrePost ([ordered]@{
        saku = $LoginTeam
        sakusya = $credential.UserName
        kojin = $password
        login = $Text.LoginButton
      })
      $access.loginSucceeded = -not (Test-PleaseLogin $login.Text)
      $pageFetches += Save-Page -Name 'login_sanitized' -Html $login.Text -SnapshotDir $snapshotDir
      $hello = Get-InputValue -Html $login.Text -Name 'hello'
      $access.helloFound = [bool]$hello
      if ($access.loginSucceeded -and $hello) {
        $roster = Invoke-OrePost ([ordered]@{ hello = $hello; kakuninn = $Text.RosterButton })
        $pageFetches += Save-Page -Name 'roster_introduction_live' -Html $roster.Text -SnapshotDir $snapshotDir
        $rosterText = Remove-Html (Protect-HtmlSecrets $roster.Text)

        $leagueRankChinese = Invoke-OrePost ([ordered]@{ hello = $hello; league_rank = $Text.LeagueRankButton; no = '0' })
        $pageFetches += Save-Page -Name 'team_rankings_live_chinese' -Html $leagueRankChinese.Text -SnapshotDir $snapshotDir
        $leagueRankTaiwan = Invoke-OrePost ([ordered]@{ hello = $hello; league_rank = $Text.LeagueRankButton; no = '3' })
        $pageFetches += Save-Page -Name 'team_rankings_live_taiwan' -Html $leagueRankTaiwan.Text -SnapshotDir $snapshotDir
        $teamRankingText = (Remove-Html (Protect-HtmlSecrets $leagueRankChinese.Text)) + "`n" + (Remove-Html (Protect-HtmlSecrets $leagueRankTaiwan.Text))

        $fantasy = Invoke-OrePost ([ordered]@{ hello = $hello; fantasy = $Text.FantasyButton })
        if (Test-PleaseLogin $fantasy.Text) {
          $fantasy = Invoke-OrePost (New-AuthStateFantasyForm -LoginHtml $login.Text -Hello $hello)
        }
        $pageFetches += Save-Page -Name 'fantasy_summary_live' -Html $fantasy.Text -SnapshotDir $snapshotDir
        $leaderText = Remove-Html (Protect-HtmlSecrets $fantasy.Text)

        $fullAttempts = @(
          [ordered]@{ hello = $hello; fantasy = $Text.FantasyButton; menu = $Text.FullFantasyList },
          [ordered]@{ hello = $hello; fantasy = $Text.FantasyButton; listType = 'all' },
          [ordered]@{ hello = $hello; fantasy = $Text.FantasyButton; finepix = $Text.FullFantasyList },
          [ordered]@{ hello = $hello; fantasy = $Text.FantasyButton; pickMyTeam = '0' }
        )
        $attemptIndex = 0
        foreach ($form in $fullAttempts) {
          $attemptIndex += 1
          try {
            $full = Invoke-OrePost $form
            $saved = Save-Page -Name ("fantasy_full_list_attempt_{0:00}" -f $attemptIndex) -Html $full.Text -SnapshotDir $snapshotDir
            $pageFetches += $saved
            $candidateText = Remove-Html (Protect-HtmlSecrets $full.Text)
            if (@(Parse-FantasyRows $candidateText).Count -gt 0 -and -not (Test-PleaseLogin $full.Text)) {
              $fantasyText = $candidateText
              break
            }
          } catch {
            $pageFetches += [pscustomobject]@{
              name = ("fantasy_full_list_attempt_{0:00}" -f $attemptIndex)
              error = $_.Exception.Message
            }
          }
        }

        if (!$fantasyText) {
          $getAttempts = @(
            [ordered]@{ hello = $hello; fantasy = $Text.FantasyButton; menu = $Text.FullFantasyList },
            [ordered]@{ hello = $hello; fantasy = $Text.FantasyButton; listType = 'all' }
          )
          foreach ($query in $getAttempts) {
            $attemptIndex += 1
            try {
              $full = Invoke-OreGet $query
              $saved = Save-Page -Name ("fantasy_full_list_attempt_{0:00}" -f $attemptIndex) -Html $full.Text -SnapshotDir $snapshotDir
              $pageFetches += $saved
              $candidateText = Remove-Html (Protect-HtmlSecrets $full.Text)
              if (@(Parse-FantasyRows $candidateText).Count -gt 0 -and -not (Test-PleaseLogin $full.Text)) {
                $fantasyText = $candidateText
                break
              }
            } catch {
              $pageFetches += [pscustomobject]@{
                name = ("fantasy_full_list_attempt_{0:00}" -f $attemptIndex)
                error = $_.Exception.Message
              }
            }
          }
        }

        if ($fantasyText) {
          $fullTextPath = Join-Path $snapshotDir 'fantasy_full_list_live.txt'
          Write-Utf8File $fullTextPath $fantasyText
          $sourceFiles['liveFantasyFullListText'] = $fullTextPath
        }
      }
    } catch {
      $access['blockedReason'] = $_.Exception.Message
    }
  }
}

$leadersExpected = [bool]($ManualLeaders -or ($leaderText -and $leaderText.Contains($Text.TripleStar)))
$teamRankingsExpected = [bool]($ManualTeamRankings -or $teamRankingText)
$validation = Build-Validation -FantasyText $fantasyText -RosterText $rosterText -LeaderText $leaderText -LeadersExpected $leadersExpected -TeamRankingText $teamRankingText -TeamRankingsExpected $teamRankingsExpected
$fantasyRows = @(Parse-FantasyRows $fantasyText)
$rosterEntries = @(Parse-RosterEntries $rosterText)
$leaderRows = @(Parse-LeaderRows $leaderText)
$derivedLeaders = Build-DerivedCategoryLeaders $fantasyRows
$teamRankings = @(Parse-TeamRankings $teamRankingText)

$fantasyRowsPath = Join-Path $snapshotDir 'fantasy_full_list_rows.json'
$rosterEntriesPath = Join-Path $snapshotDir 'roster_entries.json'
$leaderRowsPath = Join-Path $snapshotDir 'category_leaders.json'
$derivedLeadersPath = Join-Path $snapshotDir 'derived_category_leaders_from_full_list.json'
$teamRankingsPath = Join-Path $snapshotDir 'team_rankings.json'
Write-Utf8File $fantasyRowsPath ((ConvertTo-SafeJson -Value $fantasyRows -Depth 30) + "`n")
Write-Utf8File $rosterEntriesPath ((ConvertTo-SafeJson -Value $rosterEntries -Depth 30) + "`n")
Write-Utf8File $leaderRowsPath ((ConvertTo-SafeJson -Value $leaderRows -Depth 30) + "`n")
Write-Utf8File $derivedLeadersPath ((ConvertTo-SafeJson -Value $derivedLeaders -Depth 30) + "`n")
Write-Utf8File $teamRankingsPath ((ConvertTo-SafeJson -Value $teamRankings -Depth 30) + "`n")

$manifest = [ordered]@{
  generatedAt = (Get-Date).ToString('o')
  season = $Season
  dateLabel = $DateLabel
  mode = $modeLabel
  status = $validation.status
  validation = $validation
  access = $access
  sourceFiles = $sourceFiles
  pageFetches = @($pageFetches)
  outputs = [ordered]@{
    snapshotDir = $snapshotDir
    fantasyRows = $fantasyRowsPath
    rosterEntries = $rosterEntriesPath
    categoryLeaders = $leaderRowsPath
    derivedCategoryLeadersFromFullList = $derivedLeadersPath
    teamRankings = $teamRankingsPath
  }
}

$manifestPath = Join-Path $snapshotDir 'manifest.json'
Write-Utf8File $manifestPath ((ConvertTo-SafeJson -Value $manifest -Depth 40) + "`n")

$readme = @(
  "# ORE fantasy snapshot season $Season",
  "",
  "- Status: $($manifest.status)",
  "- Mode: $modeLabel",
  "- Fantasy rows: $($validation.fantasyRows)",
  "- Roster entries: $($validation.rosterEntries)",
  "- Leader rows: $($validation.leaderRows)",
  "- Team ranking rows: $($validation.teamRankingRows)",
  "- Manifest: $manifestPath"
) -join "`n"
Write-Utf8File (Join-Path $snapshotDir 'README.md') ($readme + "`n")

Write-Host "status=$($manifest.status)"
Write-Host "season=$Season"
Write-Host "snapshot=$snapshotDir"
Write-Host "manifest=$manifestPath"
if ($validation.failReasons.Count) {
  Write-Host "failReasons=$($validation.failReasons -join '; ')"
}
