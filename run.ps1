<#
.SYNOPSIS
    Runs Work Hub (serve.mjs), reachable on every interface by default, and
    restarts it when the `main` branch it is running from gains new commits.

.DESCRIPTION
    Work Hub is not a read-only viewer. It can start `claude` under your account,
    in your project folders, with your subscription - including with
    --dangerously-skip-permissions if the composer's Permissions select is set
    that way. Anything that can reach the bound address and port can do that.

    BIND
    The default is 0.0.0.0 - every interface this machine has, all at once, so
    the LAN address, the Tailscale 100.x address and the NordVPN Meshnet address
    all answer on the same port. Every one of them is printed on start. Any
    non-loopback bind requires an authenticator app paired with this machine;
    pair one with -Enroll before binding anything but loopback.

    Exposure options, in order of precedence when more than one is passed:
      1. -BindAddress <ip>   bind exactly that address and nothing else
      2. -Tailscale          resolve this machine's Tailscale IPv4 address
                              (via the Tailscale CLI) and bind only that
      3. -Loopback           bind 127.0.0.1 - nothing off this machine
      4. -Lan                bind 0.0.0.0 (the default; kept for compatibility)
      (none of the above)    bind 0.0.0.0

    Binding beyond loopback also needs a Windows Firewall inbound-allow rule for
    the port. This script only checks for one and prints the exact command to
    create it - creating one needs an elevated shell this script does not assume.

    SIGN IN
    Access is gated on a 6 digit code from an authenticator app (Authy, Google
    Authenticator, 1Password - anything that does standard TOTP). Run
    `.\run.ps1 -Enroll` once: it prints a QR code in this console, you scan it,
    you type back the code it starts showing, and the shared secret is written
    to $env:USERPROFILE\.work-hub\totp.json. Nothing about that leaves the
    machine, and the secret is never stored in this repo.

    From then on the page asks for a code instead of a pasted token. A correct
    code buys a 12 hour session in that browser; restarting the server ends
    every session.

    WATCH
    While the server runs, this script polls this repository every
    -WatchInterval seconds. When ALL of these hold it pulls and restarts node:
      - the checked-out branch is `main`
      - the working tree is clean (`git status --porcelain` is empty) - an
        in-progress edit is never interrupted, and watching resumes by itself
        once the tree is clean again
      - `origin/main` points at a different commit than HEAD
    The pull is `--ff-only`, so it never merges; a diverged local `main` is
    reported and the running server is left alone. Pass -NoWatch to disable.

    If node exits on its own - a crash, or bad code on main - this script
    restarts it, up to 3 attempts. A restart that stays up for 60 seconds
    resets the attempt counter; 3 failures in a row (each dying within 60s)
    make the script give up and exit with node's code, so a broken commit
    does not turn into an endless restart loop.

.PARAMETER Port
    TCP port to listen on. Default 5081 (same default as serve.mjs). Whatever is
    already listening on it is killed before node starts.

.PARAMETER Lan
    Bind 0.0.0.0 - every interface on this machine. This is now the default;
    the switch is kept so existing command lines keep working.

.PARAMETER Loopback
    Bind 127.0.0.1 only. Nothing off this machine can reach it.

.PARAMETER Tailscale
    Resolve this machine's Tailscale IPv4 address and bind exactly that. Fails
    with a clear message if Tailscale is not installed or not connected - it
    never falls back to a wider bind.

.PARAMETER BindAddress
    Bind exactly this address, and no other interface.

.PARAMETER Enroll
    Pair an authenticator app with this machine and exit. Prints a QR code in
    this console and waits for the 6 digit code it produces. Run it once, before
    the first non-loopback bind. Re-running it warns before replacing a pairing
    that already works.

.PARAMETER NoOtp
    Skip the code prompt entirely. Only accepted on a loopback bind, and it
    leaves every /api/* route open to anything that can reach 127.0.0.1 -
    including any page open in any browser tab on this machine.

.PARAMETER NoWatch
    Do not poll git. Run the server once, in the foreground, and stop there.

.PARAMETER WatchInterval
    Seconds between git checks. Default 60.

.PARAMETER OpenBrowser
    Once the server answers, launch the default browser there.

.EXAMPLE
    .\run.ps1 -Enroll
    Pair your authenticator. Do this first; it is a one-off.

.EXAMPLE
    .\run.ps1
    Every interface - LAN, Tailscale, Meshnet - behind a 6 digit code, and
    restarting itself whenever main moves.

.EXAMPLE
    .\run.ps1 -Loopback -NoWatch
    The old behaviour: 127.0.0.1 only, no git polling.

.NOTES
    Read the exposure section of README.md before running this on a network you
    do not fully trust.
#>
[CmdletBinding()]
param(
    [int]$Port = 5081,
    [switch]$Lan,
    [switch]$Loopback,
    [switch]$Tailscale,
    [string]$BindAddress,
    [switch]$Enroll,
    [switch]$NoOtp,
    [switch]$NoWatch,
    [int]$WatchInterval = 60,
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.3+ can turn a native command's stderr into a terminating error.
# git writes ordinary progress to stderr, so that would abort the watch loop on
# a perfectly successful fetch. Exit codes are checked explicitly instead. On
# Windows PowerShell this variable is simply unused.
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = $PSScriptRoot

# --- Enrollment: pair an authenticator, then stop ---------------------------
# Handled before anything else so it works on a machine with no git, no
# firewall rule and nothing bound.
if ($Enroll) {
    $nodeForEnroll = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeForEnroll) {
        Write-Error 'Node.js was not found on PATH. Install Node 18+ and retry.'
        exit 1
    }
    # The QR is drawn with half-block characters; a console left on the legacy
    # code page renders them as mojibake and no phone reads it.
    $previousEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        # No pass-through here: [CmdletBinding()] binds the declared parameters
        # and refuses everything else, so $args is always empty. --force,
        # --reset and --status are run directly: node src\enroll.mjs --force
        & $nodeForEnroll.Source (Join-Path $PSScriptRoot 'src\enroll.mjs')
        exit $LASTEXITCODE
    } finally {
        [Console]::OutputEncoding = $previousEncoding
    }
}

# --- Node present? ---------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error 'Node.js was not found on PATH. Install Node 18+ (developed against v26.7.0) and retry.'
    exit 1
}

# --- claude present? (every reply and the usage card depend on it) ----------
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCmd) {
    Write-Host 'WARNING: `claude` was not found on PATH. The Plan Usage card and every reply will fail until it is.' -ForegroundColor Yellow
}

# --- Resolve the bind address, in precedence order --------------------------
function Resolve-TailscaleIPv4 {
    $tailscaleCmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    $tailscaleExe = if ($tailscaleCmd) { $tailscaleCmd.Source } else { 'C:\Program Files\Tailscale\tailscale.exe' }

    if (-not (Test-Path $tailscaleExe)) {
        Write-Error "Tailscale CLI not found (checked PATH and '$tailscaleExe'). Install Tailscale, or use -BindAddress instead."
        exit 1
    }

    # Capture the whole output BEFORE filtering. Piping a native command straight into
    # `Select-Object -First 1` terminates its pipeline early, which leaves $LASTEXITCODE
    # non-zero even when the command succeeded.
    $out = & $tailscaleExe ip -4 2>&1
    $code = $LASTEXITCODE

    $ip = @($out) |
        ForEach-Object { "$_".Trim() } |
        Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' } |
        Select-Object -First 1

    if ($code -ne 0 -or [string]::IsNullOrWhiteSpace($ip)) {
        $joined = (@($out) -join ' | ')
        Write-Error "Tailscale did not return an IPv4 address (is it running and connected? try 'tailscale status'). Exit code: $code. Output: $joined"
        exit 1
    }
    return $ip
}

$selectionCount = @($BindAddress, $Tailscale, $Loopback, $Lan) | Where-Object { $_ } | Measure-Object | Select-Object -ExpandProperty Count
if ($selectionCount -gt 1) {
    Write-Host 'More than one bind switch was passed; using -BindAddress > -Tailscale > -Loopback > -Lan precedence.' -ForegroundColor Yellow
}

if ($BindAddress) {
    $bindHost = $BindAddress
} elseif ($Tailscale) {
    $bindHost = Resolve-TailscaleIPv4
    Write-Host "Resolved Tailscale address: $bindHost" -ForegroundColor Cyan
} elseif ($Loopback) {
    $bindHost = '127.0.0.1'
} else {
    # -Lan, and the no-switch default: every interface at once.
    $bindHost = '0.0.0.0'
}

$isExposed = $bindHost -ne '127.0.0.1' -and $bindHost -ne 'localhost'

# --- Firewall: check only, never create (needs elevation this script lacks) ---
# A rule only helps if it applies to the network profile (Domain/Private/Public)
# this machine is actually on. Profile is a [Flags] enum, so it is split from
# .ToString() ("Domain, Private" -> @('Domain','Private')) rather than matched
# with -contains directly.
function Test-FirewallAllowsPort {
    param([int]$Port)

    $activeProfiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty NetworkCategory -Unique |
        ForEach-Object { $_.ToString() }

    $rules = Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue
    foreach ($rule in $rules) {
        $ruleProfiles = $rule.Profile.ToString() -split ',\s*'
        $profileMatches = ($ruleProfiles -contains 'Any') -or ($activeProfiles | Where-Object { $ruleProfiles -contains $_ })
        if (-not $profileMatches) { continue }

        $portFilters = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
        foreach ($pf in $portFilters) {
            if ($pf.Protocol -eq 'TCP' -and ($pf.LocalPort -eq "$Port" -or $pf.LocalPort -eq 'Any')) {
                return $true
            }
        }
    }
    return $false
}

if ($isExposed) {
    if (-not (Test-FirewallAllowsPort -Port $Port)) {
        Write-Host ''
        Write-Host "No inbound Windows Firewall rule found allowing TCP port $Port." -ForegroundColor Yellow
        Write-Host 'Nothing outside this machine will connect until one exists. Run this in an ELEVATED PowerShell:' -ForegroundColor Yellow
        Write-Host "  New-NetFirewallRule -DisplayName 'Work Hub ($Port)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private"
        Write-Host ''
    }

    Write-Host ''
    Write-Host 'WARNING: Work Hub can run `claude` under YOUR account.' -ForegroundColor Red
    Write-Host 'Anyone who reaches the address below and can produce a code can read your .work/ folders, read every Claude Code' -ForegroundColor Red
    Write-Host 'transcript for the monitored projects, and start new Claude runs that edit files and spend your subscription.' -ForegroundColor Red
    if ($bindHost -eq '0.0.0.0') {
        Write-Host 'This bind covers EVERY interface - including whatever wifi you are on. Use -Loopback or -Tailscale to narrow it.' -ForegroundColor Red
    }
    Write-Host ''
}

# --- Git: is the watch loop even possible here? -----------------------------
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$watch = -not $NoWatch

if ($watch -and -not $gitCmd) {
    Write-Host 'WARNING: git was not found on PATH; auto-restart on new commits is off.' -ForegroundColor Yellow
    $watch = $false
}

# Runs git in the repo folder, returns trimmed stdout, and reports the exit code
# through [ref]$ExitCode so callers can tell "no output" from "command failed".
function Invoke-Git {
    param([string[]]$GitArgs, [ref]$ExitCode)
    # Windows PowerShell 5.1: with the script-level 'Stop' preference, 2>&1
    # turns git's first stderr line (e.g. an offline fetch) into a terminating
    # error and kills the watch loop. Scope it to Continue here; failure is
    # reported through the exit code, not the error stream.
    $ErrorActionPreference = 'Continue'
    $out = & $gitCmd.Source -C $repoRoot @GitArgs 2>&1
    if ($ExitCode) { $ExitCode.Value = $LASTEXITCODE }
    return (@($out) | ForEach-Object { "$_" }) -join "`n"
}

if ($watch) {
    $code = 0
    [void](Invoke-Git -GitArgs @('rev-parse', '--is-inside-work-tree') -ExitCode ([ref]$code))
    if ($code -ne 0) {
        Write-Host "WARNING: $repoRoot is not a git work tree; auto-restart on new commits is off." -ForegroundColor Yellow
        $watch = $false
    }
}

if ($watch -and $WatchInterval -lt 5) {
    Write-Host "WatchInterval $WatchInterval is below the 5s floor; using 5." -ForegroundColor Yellow
    $WatchInterval = 5
}

# --- Is an authenticator paired? --------------------------------------------
# serve.mjs refuses a non-loopback bind without one, but it does so after the
# firewall notice and the URL list, which reads like the server started. Say it
# here instead, and say how to fix it.
$enrollmentFile = Join-Path $env:USERPROFILE '.work-hub\totp.json'
$isEnrolled = Test-Path -LiteralPath $enrollmentFile

if ($isExposed -and -not $isEnrolled) {
    Write-Host ''
    Write-Error "No authenticator is paired with this machine, so a $bindHost bind would be wide open. Pair one first:  .\run.ps1 -Enroll"
    exit 1
}
if ($NoOtp -and $isExposed) {
    Write-Error "-NoOtp cannot be combined with a $bindHost bind. Drop it, or add -Loopback."
    exit 1
}
if (-not $isEnrolled) {
    Write-Host "No authenticator paired, so nothing is gated. Pair one with:  .\run.ps1 -Enroll" -ForegroundColor Yellow
    Write-Host ''
}

# --- Build the reachable-URL list -------------------------------------------
function Get-ReachableIPv4Addresses {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '127.*' } |
        Select-Object -ExpandProperty IPAddress
}

# Loopback only answers when we actually bound it (or bound everything). Binding a
# specific address such as a Tailscale IP means 127.0.0.1 is REFUSED, so listing it
# would hand the operator a dead URL - and would hang -OpenBrowser below.
$loopbackWorks = $bindHost -in @('0.0.0.0', '127.0.0.1', 'localhost', '::')

Write-Host 'Reachable at:' -ForegroundColor Green
if ($loopbackWorks) { Write-Host "  http://127.0.0.1:$Port/" }
if ($bindHost -eq '0.0.0.0') {
    foreach ($ip in (Get-ReachableIPv4Addresses)) { Write-Host "  http://$ip`:$Port/" }
} elseif ($isExposed) {
    Write-Host "  http://$bindHost`:$Port/"
}
Write-Host ''

# --- Optionally open the browser once the server answers -------------------
# Poll the address actually bound: with -Tailscale/-BindAddress loopback never
# answers, so polling it would spin out the retry budget and open nothing.
$localUrl = if ($loopbackWorks) { "http://127.0.0.1:$Port/" } else { "http://$bindHost`:$Port/" }
if ($OpenBrowser) {
    Start-Job -ScriptBlock {
        param($url)
        for ($i = 0; $i -lt 40; $i++) {
            try {
                $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
                if ($resp.StatusCode -eq 200) { Start-Process $url; return }
            } catch {
                Start-Sleep -Milliseconds 250
            }
        }
    } -ArgumentList $localUrl | Out-Null
}

# --- Free the port before binding it ----------------------------------------
# A previous run that lost its console, or anything else holding the port, makes
# node exit immediately with "Port N is already in use". Kill whatever is
# listening (and its children - serve.mjs spawns `claude`) and carry on.
function Stop-ProcessOnPort {
    param([int]$Port)

    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $listeners) { return }

    $owners = $listeners |
        Select-Object -ExpandProperty OwningProcess -Unique |
        Where-Object { $_ -and $_ -ne 0 -and $_ -ne $PID }

    foreach ($owner in $owners) {
        $existing = Get-Process -Id $owner -ErrorAction SilentlyContinue
        $name = if ($existing) { $existing.ProcessName } else { 'unknown' }
        Write-Host "Port $Port is held by $name (PID $owner); killing it." -ForegroundColor Yellow
        & taskkill.exe /PID $owner /T /F 2>&1 | Out-Null
        if ($existing) { [void]$existing.WaitForExit(5000) }
    }

    # taskkill returns before Windows tears the socket down, so wait for the port
    # itself rather than for the process.
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 250
    }
    Write-Host "Port $Port is still in use after killing its owner; node will report the conflict." -ForegroundColor Yellow
}

Stop-ProcessOnPort -Port $Port

# --- Run the server ---------------------------------------------------------
$serveScript = Join-Path $repoRoot 'src\serve.mjs'
$nodeArgs = @($serveScript, '--port', "$Port", '--host', $bindHost)
if ($NoOtp) { $nodeArgs += '--no-otp' }

# Start-Process joins -ArgumentList with spaces and quotes nothing, so any
# argument holding a space (a repo path under "Program Files") has to arrive
# already quoted.
function Format-Arg {
    param([string]$Value)
    if ($Value -match '\s') { return '"' + $Value + '"' }
    return $Value
}

function Start-Server {
    $quoted = @($nodeArgs | ForEach-Object { Format-Arg $_ })
    Write-Host "Starting: node $($nodeArgs -join ' ')" -ForegroundColor DarkGray
    # -NoNewWindow so node shares this console: its output lands here, and Ctrl+C
    # reaches it as well as this script.
    return Start-Process -FilePath $nodeCmd.Source -ArgumentList $quoted -NoNewWindow -PassThru
}

# Kill the whole tree, not just node. serve.mjs spawns `claude` children; killing
# only the parent would leave them running against your subscription with nothing
# left to collect their output.
function Stop-ServerTree {
    param($Process)
    if (-not $Process -or $Process.HasExited) { return }
    & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null
    if (-not $Process.WaitForExit(5000)) {
        try { $Process.Kill() } catch { }
    }
}

if (-not $watch) {
    Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray
    Write-Host ''
    # Invoked directly (not Start-Process) so it shares this console's process group:
    # Ctrl+C delivers CTRL_C_EVENT to both this shell and node, and node exits on
    # SIGINT by default - no orphaned process left behind.
    & $nodeCmd.Source @nodeArgs
    exit $LASTEXITCODE
}

$restartAttempts = 0
$maxRestartAttempts = 3
$stableAfterSeconds = 60

Write-Host "Watching origin/main every ${WatchInterval}s; restarts on a new commit when main is clean, and on a crash (up to $maxRestartAttempts quick failures in a row)." -ForegroundColor DarkGray
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray
Write-Host ''

$proc = Start-Server
$startedAt = Get-Date
$fetchFailing = $false

try {
    while ($true) {
        # Doubles as the poll interval and as the wait for node to die on its own.
        # Ctrl+C reaches node too, so this returns promptly instead of sitting out
        # the full interval.
        if ($proc.WaitForExit($WatchInterval * 1000)) {
            $exitCode = $proc.ExitCode
            # A run that survived a while was a real deployment, not a failed
            # start - give the next crash a fresh set of attempts.
            if (((Get-Date) - $startedAt).TotalSeconds -ge $stableAfterSeconds) {
                $restartAttempts = 0
            }
            $restartAttempts++
            if ($restartAttempts -gt $maxRestartAttempts) {
                Write-Host ''
                Write-Host "Server exited with code $exitCode and died within ${stableAfterSeconds}s on $maxRestartAttempts restarts in a row; giving up." -ForegroundColor Yellow
                exit $exitCode
            }
            Write-Host ''
            Write-Host "Server exited with code $exitCode; restarting (attempt $restartAttempts of $maxRestartAttempts)." -ForegroundColor Yellow
            $proc = Start-Server
            $startedAt = Get-Date
            continue
        }

        $code = 0
        $branch = Invoke-Git -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD') -ExitCode ([ref]$code)
        if ($code -ne 0 -or $branch -ne 'main') { continue }

        $dirty = Invoke-Git -GitArgs @('status', '--porcelain') -ExitCode ([ref]$code)
        if ($code -ne 0 -or -not [string]::IsNullOrWhiteSpace($dirty)) { continue }

        [void](Invoke-Git -GitArgs @('fetch', '--quiet', 'origin', 'main') -ExitCode ([ref]$code))
        if ($code -ne 0) {
            # Only announce the transition, so a flaky link does not print every tick.
            if (-not $fetchFailing) {
                Write-Host 'git fetch failed (offline?); still serving, will retry.' -ForegroundColor Yellow
                $fetchFailing = $true
            }
            continue
        }
        if ($fetchFailing) {
            Write-Host 'git fetch recovered.' -ForegroundColor DarkGray
            $fetchFailing = $false
        }

        $localSha = Invoke-Git -GitArgs @('rev-parse', 'HEAD') -ExitCode ([ref]$code)
        if ($code -ne 0) { continue }
        $remoteSha = Invoke-Git -GitArgs @('rev-parse', 'origin/main') -ExitCode ([ref]$code)
        if ($code -ne 0 -or $localSha -eq $remoteSha) { continue }

        Write-Host ''
        Write-Host "main moved: $($localSha.Substring(0,7)) -> $($remoteSha.Substring(0,7)). Pulling." -ForegroundColor Cyan

        $pullOut = Invoke-Git -GitArgs @('pull', '--ff-only', 'origin', 'main') -ExitCode ([ref]$code)
        if ($code -ne 0) {
            # Diverged local main, or a pull that would need a merge. Leave the
            # running server alone rather than restarting into a half-updated tree.
            Write-Host 'git pull --ff-only failed; leaving the running server as it is.' -ForegroundColor Yellow
            Write-Host $pullOut -ForegroundColor Yellow
            continue
        }

        Write-Host 'Restarting the server on the new commit.' -ForegroundColor Cyan
        Stop-ServerTree -Process $proc
        $proc = Start-Server
        $startedAt = Get-Date
        Write-Host ''
    }
} finally {
    # Ctrl+C lands here too: never leave a detached node (and its claude children)
    # holding the port after this console is gone.
    Stop-ServerTree -Process $proc
}
