param(
  [Parameter(Mandatory = $true)]
  [string]$SeasonDir,
  [Parameter(Mandatory = $true)]
  [string]$Out,
  [string]$MdOut,
  [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
  [string]$CredentialPath = 'C:\Users\YOSHI\.codex\secrets\ore-auth.credential.xml',
  [string]$LoginTeam = '',
  [string]$SanitizedHtmlOut
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$OreUrl = 'http://game.tinycafe.com/ore/ore.cgi'
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Codex ORE Fantasy Public Audit'
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
  PleaseLogin = U @(0x8ACB, 0x5148, 0x767B, 0x5165)
  FantasyPrefix = (U @(0x5922, 0x5E7B, 0x7403, 0x968A, 0xFF1A))
  SeasonTotal = U @(0x672C, 0x5B63, 0x5171)
  ParticipantSuffix = U @(0x4EBA, 0x53C3, 0x52A0)
  PrizePool = U @(0x734E, 0x91D1, 0x7E3D, 0x984D)
  PerItemPrize = U @(0x5404, 0x9805, 0x76EE, 0x8D0F, 0x5BB6, 0x53EF, 0x7372, 0x5F97)
  ConsolationAward = U @(0x3010, 0x5B89, 0x6170, 0x734E, 0x3011)
  ParticipationAward = U @(0x3010, 0x53C3, 0x52A0, 0x734E, 0x3011)
  NameCountSuffix = U @(0x540D)
  ItemHr = U @(0x672C, 0x6253)
  ItemSb = U @(0x76DC, 0x58D8)
  ItemK = U @(0x4E09, 0x632F)
  ItemEra = U @(0x9632, 0x7387)
  ItemAvg = U @(0x6253, 0x7387)
  ItemRbi = U @(0x6253, 0x9EDE)
  ItemW = U @(0x52DD, 0x5834)
  ItemSv = U @(0x6551, 0x63F4)
}

if (!$LoginTeam) {
  $LoginTeam = $Text.LoginTeam
}

function Read-JsonFile {
  param([string]$Path)
  return Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
}

function Write-Utf8File {
  param(
    [string]$Path,
    [string]$Body
  )
  if (!$Path) { return }
  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Body, [System.Text.UTF8Encoding]::new($false))
}

function Get-JsonProp {
  param(
    [object]$Object,
    [string]$Name
  )
  if ($null -eq $Object) { return $null }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
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
  param([System.Collections.Specialized.OrderedDictionary]$Form)
  $pairs = foreach ($key in $Form.Keys) {
    "$(Encode-FormComponent $key)=$(Encode-FormComponent ([string]$Form[$key]))"
  }
  return ($pairs -join '&')
}

function Invoke-OrePost {
  param([System.Collections.Specialized.OrderedDictionary]$Form)
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
      $text = $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      Text = $text
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

function New-AuthStateFantasyForm {
  param(
    [string]$LoginHtml,
    [string]$Hello
  )
  $form = [ordered]@{}
  foreach ($name in @('saku', 'pass', 'sakusya', 'kojin', 'ok1', 'ok2', 'ok3', 'ok4', 'ok', 'team')) {
    $value = Get-InputValue -Html $LoginHtml -Name $name
    if ($null -ne $value) {
      $form[$name] = $value
    }
  }
  if ($Hello) {
    $form['hello'] = $Hello
  }
  $form['fantasy'] = $Text.FantasyButton
  return $form
}

function Test-PleaseLogin {
  param([string]$Html)
  return $Html.Contains($Text.PleaseLogin)
}

function Protect-HtmlSecrets {
  param([string]$Html)
  $secretNames = 'pass|kojin|ok2|ok3|ok4'
  $safe = [regex]::Replace(
    $Html,
    "(?i)(name\s*=\s*[""']?(?:$secretNames)[""']?[^>]*\bvalue\s*=\s*)(?:""[^""]*""|'[^']*'|[^\s>]+)",
    '$1"[redacted]"'
  )
  return $safe
}

function Remove-Html {
  param([string]$Html)
  $text = [regex]::Replace($Html, '<br\s*/?>', "`n", 'IgnoreCase')
  $text = [regex]::Replace($text, '<[^>]+>', ' ')
  $text = [System.Net.WebUtility]::HtmlDecode($text)
  $text = [regex]::Replace($text, '[ \t]+', ' ')
  $text = [regex]::Replace($text, '\s*\n\s*', "`n")
  return $text.Trim()
}

function Split-NameList {
  param([string]$Text)
  if (!$Text) { return @() }
  return @($Text -split '\s*,\s*' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Convert-ItemLabel {
  param([string]$Label)
  if ($Label -eq $Text.ItemHr) { return 'HR' }
  if ($Label -eq $Text.ItemSb) { return 'SB' }
  if ($Label -eq $Text.ItemK) { return 'K' }
  if ($Label -eq $Text.ItemEra) { return 'ERA' }
  if ($Label -eq $Text.ItemAvg) { return 'AVG' }
  if ($Label -eq $Text.ItemRbi) { return 'RBI' }
  if ($Label -eq $Text.ItemW) { return 'W' }
  if ($Label -eq $Text.ItemSv) { return 'SV' }
  return $Label
}

function Parse-FantasySummary {
  param([string]$Html)
  $summary = [ordered]@{
    outcomeSummaryFound = $false
    outcomeTimestamp = $null
    participantCount = $null
    prizePool = $null
    perItemPrize = $null
    categoryWinners = @()
    consolation = [ordered]@{ count = $null; names = @() }
    participation = [ordered]@{ count = $null; names = @() }
    playerPicksStatus = 'not_checked'
    pageMarkers = [ordered]@{
      hasListType = [bool]($Html -match 'name\s*=\s*["'']?listType')
      hasPickMyTeam = [bool]($Html -match 'name\s*=\s*["'']?pickMyTeam')
      hasFinepix = [bool]($Html -match 'name\s*=\s*["'']?finepix')
    }
  }

  $overviewPattern =
    '(\d{2}/\d{2}\s+\d{2}:\d{2})\s*-\s*<font[^>]*>\s*' +
    [regex]::Escape($Text.FantasyPrefix) +
    [regex]::Escape($Text.SeasonTotal) +
    '\s*<B>(\d+)</B>\s*' +
    [regex]::Escape($Text.ParticipantSuffix) +
    '.*?' +
    [regex]::Escape($Text.PrizePool) +
    '\s*<B>([^<]+)</B>.*?' +
    [regex]::Escape($Text.PerItemPrize) +
    '\s*<B>([^<]+)</B>'
  $overview = [regex]::Match($Html, $overviewPattern, 'IgnoreCase')
  if ($overview.Success) {
    $summary.outcomeSummaryFound = $true
    $summary.outcomeTimestamp = $overview.Groups[1].Value
    $summary.participantCount = [int]$overview.Groups[2].Value
    $summary.prizePool = $overview.Groups[3].Value
    $summary.perItemPrize = $overview.Groups[4].Value
  }

  $winnerLine = [regex]::Match($Html, [regex]::Escape($Text.FantasyPrefix) + '((?:\[[^\]]+\]<B>[^<]+</B>\s*)+)', 'IgnoreCase')
  if ($winnerLine.Success) {
    $winners = foreach ($match in [regex]::Matches($winnerLine.Groups[1].Value, '\[([^\]]+)\]<B>([^<]+)</B>')) {
      [ordered]@{
        item = Convert-ItemLabel $match.Groups[1].Value
        rawItem = $match.Groups[1].Value
        winner = $match.Groups[2].Value
      }
    }
    $summary.categoryWinners = @($winners)
  }

  $consolationPattern =
    [regex]::Escape($Text.FantasyPrefix) +
    '<B>' + [regex]::Escape($Text.ConsolationAward) + '</B>\([^)]*?<B>(\d+)</B>' +
    [regex]::Escape($Text.NameCountSuffix) +
    '\)\s*([^<]+)</font>'
  $consolation = [regex]::Match($Html, $consolationPattern, 'IgnoreCase')
  if ($consolation.Success) {
    $summary.consolation = [ordered]@{
      count = [int]$consolation.Groups[1].Value
      names = @(Split-NameList $consolation.Groups[2].Value)
    }
  }

  $participationPattern =
    [regex]::Escape($Text.FantasyPrefix) +
    '<B>' + [regex]::Escape($Text.ParticipationAward) + '</B>\([^)]*?<B>(\d+)</B>' +
    [regex]::Escape($Text.NameCountSuffix) +
    '\)\s*([^<]+)</font>'
  $participation = [regex]::Match($Html, $participationPattern, 'IgnoreCase')
  if ($participation.Success) {
    $summary.participation = [ordered]@{
      count = [int]$participation.Groups[1].Value
      names = @(Split-NameList $participation.Groups[2].Value)
    }
  }

  if ($summary.pageMarkers.hasListType -or $summary.pageMarkers.hasPickMyTeam -or $summary.pageMarkers.hasFinepix) {
    $summary.playerPicksStatus = 'candidate_controls_detected_but_not_parsed'
  } elseif ($summary.outcomeSummaryFound) {
    $summary.playerPicksStatus = 'player_picks_unavailable_on_result_page'
  } else {
    $summary.playerPicksStatus = 'not_found'
  }

  return $summary
}

function New-Result {
  param(
    [string]$Status,
    [string]$Reason,
    [object]$Source,
    [object]$Access,
    [object]$Fantasy,
    [object[]]$Findings = @()
  )
  return [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    dateLabel = $Date
    status = $Status
    reason = $Reason
    source = $Source
    access = $Access
    fantasy = $Fantasy
    findings = @($Findings)
  }
}

$metaPath = Join-Path $SeasonDir 'meta.json'
if (!(Test-Path -LiteralPath $metaPath)) {
  throw "Missing meta.json: $metaPath"
}
$meta = Read-JsonFile $metaPath
$sourceSeason = [int](Get-JsonProp $meta 'season')
$targetSeason = $sourceSeason + 1
$sourceDay = Get-JsonProp $meta 'day'
if ($null -eq $sourceDay) { $sourceDay = Get-JsonProp $meta 'current_day' }
$source = [ordered]@{
  seasonDir = $SeasonDir
  season = [string]$sourceSeason
  day = if ($null -eq $sourceDay) { $null } else { [string]$sourceDay }
  scrapedAt = Get-JsonProp $meta 'scraped_at'
  targetSeason = $targetSeason
}

$access = [ordered]@{
  publicAttempted = $true
  publicStatus = 'not_attempted'
  credentialPathPresent = [bool](Test-Path -LiteralPath $CredentialPath)
  credentialImported = $false
  credentialUsed = $false
  loginAttempted = $false
  loginSucceeded = $false
  loginStatusCode = $null
  fantasyAttempted = $false
  fantasySucceeded = $false
  fantasyStatusCode = $null
  fantasyNavigation = $null
  fantasyFallbackAttempted = $false
  fantasyFallbackStatusCode = $null
  sanitizedHtmlPath = $null
}

$emptyFantasy = [ordered]@{
  outcomeSummaryFound = $false
  categoryWinners = @()
  playerPicksStatus = 'not_checked'
}

try {
  $public = Invoke-OrePost ([ordered]@{ fantasy = $Text.FantasyButton })
  $access.publicStatus = if (Test-PleaseLogin $public.Text) { 'auth_required' } else { 'available_without_login' }
} catch {
  $access.publicStatus = 'public_fetch_failed'
}

if (!(Test-Path -LiteralPath $CredentialPath)) {
  $result = New-Result `
    -Status 'blocked_credential_missing' `
    -Reason 'Stored ORE credential is missing; public fantasy page requires login.' `
    -Source $source `
    -Access $access `
    -Fantasy $emptyFantasy `
    -Findings @('Public fantasy page requires login, and no stored credential was available.')
  Write-Utf8File $Out (($result | ConvertTo-Json -Depth 30) + "`n")
  if ($MdOut) {
    Write-Utf8File $MdOut "# ORE $targetSeason Fantasy Public Audit`n`n- Status: $($result.status)`n- Reason: $($result.reason)`n"
  }
  exit 0
}

try {
  $credential = Import-Clixml -LiteralPath $CredentialPath
  $access.credentialImported = $true
} catch {
  $result = New-Result `
    -Status 'blocked_credential_import_failed' `
    -Reason 'Stored ORE credential could not be decrypted by this Windows user.' `
    -Source $source `
    -Access $access `
    -Fantasy $emptyFantasy `
    -Findings @('Credential import failed; no plaintext secret was logged.')
  Write-Utf8File $Out (($result | ConvertTo-Json -Depth 30) + "`n")
  if ($MdOut) {
    Write-Utf8File $MdOut "# ORE $targetSeason Fantasy Public Audit`n`n- Status: $($result.status)`n- Reason: $($result.reason)`n"
  }
  exit 0
}

$access.credentialUsed = $true
$access.loginAttempted = $true
$password = $credential.GetNetworkCredential().Password

try {
  $login = Invoke-OrePost ([ordered]@{
    saku = $LoginTeam
    sakusya = $credential.UserName
    kojin = $password
    login = $Text.LoginButton
  })
  $access.loginStatusCode = $login.StatusCode
  $access.loginSucceeded = -not (Test-PleaseLogin $login.Text)
} catch {
  $result = New-Result `
    -Status 'blocked_login_fetch_failed' `
    -Reason 'Authenticated login request failed before the fantasy page could be inspected.' `
    -Source $source `
    -Access $access `
    -Fantasy $emptyFantasy `
    -Findings @('Login request failed; no plaintext secret was logged.')
  Write-Utf8File $Out (($result | ConvertTo-Json -Depth 30) + "`n")
  if ($MdOut) {
    Write-Utf8File $MdOut "# ORE $targetSeason Fantasy Public Audit`n`n- Status: $($result.status)`n- Reason: $($result.reason)`n"
  }
  exit 0
}

if (!$access.loginSucceeded) {
  $result = New-Result `
    -Status 'blocked_login_rejected' `
    -Reason 'ORE rejected the stored credential or requested login again.' `
    -Source $source `
    -Access $access `
    -Fantasy $emptyFantasy `
    -Findings @('Login response still requested login; no fantasy picks were reviewed.')
  Write-Utf8File $Out (($result | ConvertTo-Json -Depth 30) + "`n")
  if ($MdOut) {
    Write-Utf8File $MdOut "# ORE $targetSeason Fantasy Public Audit`n`n- Status: $($result.status)`n- Reason: $($result.reason)`n"
  }
  exit 0
}

$hello = Get-InputValue -Html $login.Text -Name 'hello'
if (!$hello) {
  $result = New-Result `
    -Status 'blocked_login_state_missing' `
    -Reason 'Login succeeded but the navigation hello token was not found.' `
    -Source $source `
    -Access $access `
    -Fantasy $emptyFantasy `
    -Findings @('Unable to navigate to fantasy page because hello token was missing.')
  Write-Utf8File $Out (($result | ConvertTo-Json -Depth 30) + "`n")
  if ($MdOut) {
    Write-Utf8File $MdOut "# ORE $targetSeason Fantasy Public Audit`n`n- Status: $($result.status)`n- Reason: $($result.reason)`n"
  }
  exit 0
}

$access.fantasyAttempted = $true
try {
  $fantasy = Invoke-OrePost ([ordered]@{
    hello = $hello
    fantasy = $Text.FantasyButton
  })
  $access.fantasyStatusCode = $fantasy.StatusCode
  $access.fantasySucceeded = -not (Test-PleaseLogin $fantasy.Text)
  $access.fantasyNavigation = 'hello'
} catch {
  $result = New-Result `
    -Status 'blocked_fantasy_fetch_failed' `
    -Reason 'Login succeeded, but the fantasy page request failed.' `
    -Source $source `
    -Access $access `
    -Fantasy $emptyFantasy `
    -Findings @('Fantasy page request failed after login.')
  Write-Utf8File $Out (($result | ConvertTo-Json -Depth 30) + "`n")
  if ($MdOut) {
    Write-Utf8File $MdOut "# ORE $targetSeason Fantasy Public Audit`n`n- Status: $($result.status)`n- Reason: $($result.reason)`n"
  }
  exit 0
}

if (!$access.fantasySucceeded) {
  $access.fantasyFallbackAttempted = $true
  try {
    $fantasyFallback = Invoke-OrePost (New-AuthStateFantasyForm -LoginHtml $login.Text -Hello $hello)
    $access.fantasyFallbackStatusCode = $fantasyFallback.StatusCode
    if (-not (Test-PleaseLogin $fantasyFallback.Text)) {
      $fantasy = $fantasyFallback
      $access.fantasySucceeded = $true
      $access.fantasyNavigation = 'auth_state'
    }
  } catch {
    $access.fantasyFallbackStatusCode = $null
  }
}

if (!$access.fantasySucceeded) {
  $blockedFantasy = [ordered]@{
    outcomeSummaryFound = $false
    categoryWinners = @()
    playerPicksStatus = 'blocked_auth_required_after_login'
  }
  $result = New-Result `
    -Status 'blocked_fantasy_auth_required_after_login' `
    -Reason 'Fantasy page still requested login after authenticated navigation.' `
    -Source $source `
    -Access $access `
    -Fantasy $blockedFantasy `
    -Findings @('Authenticated fantasy page was not accessible.')
  Write-Utf8File $Out (($result | ConvertTo-Json -Depth 30) + "`n")
  if ($MdOut) {
    Write-Utf8File $MdOut "# ORE $targetSeason Fantasy Public Audit`n`n- Status: $($result.status)`n- Reason: $($result.reason)`n"
  }
  exit 0
}

if (!$SanitizedHtmlOut) {
  $SanitizedHtmlOut = [System.IO.Path]::ChangeExtension($Out, '.sanitized.html')
}
$access.sanitizedHtmlPath = $SanitizedHtmlOut
Write-Utf8File $SanitizedHtmlOut (Protect-HtmlSecrets $fantasy.Text)

$fantasySummary = Parse-FantasySummary $fantasy.Text
$status = if ($fantasySummary.outcomeSummaryFound) { 'available_result_summary' } else { 'available_no_outcome_summary' }
$findings = @()
if ($fantasySummary.outcomeSummaryFound) {
  $findings += "Parsed fantasy result summary from $($fantasySummary.outcomeTimestamp)."
}
if ($fantasySummary.playerPicksStatus -eq 'player_picks_unavailable_on_result_page') {
  $findings += 'The accessible fantasy page exposes season result winners and prize lists, but not each participant player-pick roster.'
}
if (($fantasySummary.categoryWinners | Where-Object { $_.item -in @('HR', 'SB', 'K', 'ERA') }).Count -gt 0) {
  $findings += 'HR/SB/K/ERA winner categories are available as historical outcome signals, not current-pick consensus.'
}

$result = New-Result `
  -Status $status `
  -Reason 'Authenticated fantasy page inspected successfully.' `
  -Source $source `
  -Access $access `
  -Fantasy $fantasySummary `
  -Findings $findings

Write-Utf8File $Out (($result | ConvertTo-Json -Depth 30) + "`n")

if ($MdOut) {
  $winnerLines = @($fantasySummary.categoryWinners | ForEach-Object {
    "- $($_.item) ($($_.rawItem)): $($_.winner)"
  })
  if (!$winnerLines.Count) { $winnerLines = @('- none parsed') }
  $markdown = @(
    "# ORE $targetSeason Fantasy Public Audit",
    "",
    "- Status: $($result.status)",
    "- Source: season $sourceSeason day $sourceDay; scraped at $($source.scrapedAt)",
    "- Public access: $($access.publicStatus)",
    "- Login used stored credential: $($access.credentialUsed); loginSucceeded=$($access.loginSucceeded)",
    "- Fantasy outcome timestamp: $($fantasySummary.outcomeTimestamp)",
    "- Participants: $($fantasySummary.participantCount); per-item prize: $($fantasySummary.perItemPrize)",
    "- Player-pick roster status: $($fantasySummary.playerPicksStatus)",
    "",
    "Category winners:",
    "",
    ($winnerLines -join "`n"),
    "",
    "Findings:",
    "",
    (($findings | ForEach-Object { "- $_" }) -join "`n")
  ) -join "`n"
  Write-Utf8File $MdOut ($markdown + "`n")
}

Write-Host "Fantasy public audit JSON: $Out"
Write-Host "Fantasy public audit Markdown: $MdOut"
