<#
.SYNOPSIS
    Runs Work Hub (serve.mjs) with an explicit, deliberate choice of which
    network interface it is reachable on.

.DESCRIPTION
    Work Hub is not a read-only viewer. It can start `claude` under your account,
    in your project folders, with your subscription - including with
    --dangerously-skip-permissions if the composer's Permissions select is set
    that way. Anything that can reach the bound address and port can do that.

    This wrapper defaults to loopback-only, and makes every wider exposure an
    explicit switch rather than something that happens by accident. Any
    non-loopback bind also requires a shared token: serve.mjs generates one and
    prints it, or you pass your own with -Token.

    Exposure options, in order of precedence when more than one is passed:
      1. -BindAddress <ip>   bind exactly that address (NordVPN Meshnet, or
                              anything else with an IP this machine owns)
      2. -Tailscale          resolve this machine's Tailscale IPv4 address
                              (via the Tailscale CLI) and bind that
      3. -Lan                bind 0.0.0.0 (every interface)
      (none of the above)    bind 127.0.0.1 (loopback only - the default)

    Binding beyond loopback also needs a Windows Firewall inbound-allow rule for
    the port. This script only checks for one and prints the exact command to
    create it - creating one needs an elevated shell this script does not assume.

.PARAMETER Port
    TCP port to listen on. Default 8731 (same default as serve.mjs).

.PARAMETER Lan
    Bind 0.0.0.0 - every interface on this machine.

.PARAMETER Tailscale
    Resolve this machine's Tailscale IPv4 address and bind exactly that. Fails
    with a clear message if Tailscale is not installed or not connected - it
    never falls back to a wider bind.

.PARAMETER BindAddress
    Bind exactly this address. The escape hatch for NordVPN Meshnet (no reliable
    CLI to query on Windows) or any other interface.

.PARAMETER Token
    The shared secret every /api/* request must send as X-Hub-Token. Omit on a
    non-loopback bind and serve.mjs generates one and prints it.

.PARAMETER OpenBrowser
    Once the server answers, launch the default browser there.

.EXAMPLE
    .\run.ps1
    Loopback only - http://127.0.0.1:8731/, nothing else can reach it.

.EXAMPLE
    .\run.ps1 -Tailscale -OpenBrowser
    Reachable at this machine's Tailscale IP only, behind a generated token.

.NOTES
    Read the exposure section of README.md before using -Lan, -Tailscale, or
    -BindAddress on a network you do not fully trust.
#>
[CmdletBinding()]
param(
    [int]$Port = 8731,
    [switch]$Lan,
    [switch]$Tailscale,
    [string]$BindAddress,
    [string]$Token,
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'

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

$selectionCount = @($BindAddress, $Tailscale, $Lan) | Where-Object { $_ } | Measure-Object | Select-Object -ExpandProperty Count
if ($selectionCount -gt 1) {
    Write-Host 'More than one of -BindAddress/-Tailscale/-Lan was passed; using -BindAddress > -Tailscale > -Lan precedence.' -ForegroundColor Yellow
}

if ($BindAddress) {
    $bindHost = $BindAddress
} elseif ($Tailscale) {
    $bindHost = Resolve-TailscaleIPv4
    Write-Host "Resolved Tailscale address: $bindHost" -ForegroundColor Cyan
} elseif ($Lan) {
    $bindHost = '0.0.0.0'
} else {
    $bindHost = '127.0.0.1'
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
    Write-Host 'Anyone who reaches the address below and holds the token can read your .work/ folders, read every Claude Code' -ForegroundColor Red
    Write-Host 'transcript for the monitored projects, and start new Claude runs that edit files and spend your subscription.' -ForegroundColor Red
    if ($Lan) {
        Write-Host 'That includes anyone else on the same office or coffee-shop network.' -ForegroundColor Red
    }
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

# --- Run the server in the foreground -----------------------------------
$serveScript = Join-Path $PSScriptRoot 'serve.mjs'
$nodeArgs = @($serveScript, '--port', $Port, '--host', $bindHost)
if ($Token) { $nodeArgs += @('--token', $Token) }

Write-Host "Starting: node $($nodeArgs -join ' ')" -ForegroundColor DarkGray
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray
Write-Host ''

# Invoked directly (not Start-Process) so it shares this console's process group:
# Ctrl+C delivers CTRL_C_EVENT to both this shell and node, and node exits on
# SIGINT by default - no orphaned process left behind.
& node @nodeArgs
exit $LASTEXITCODE
