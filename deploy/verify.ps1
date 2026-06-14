# PrutCMS v10 — quick smoke test against a running dev server.
# Usage:
#   1. In one terminal: npm run dev
#   2. In another:      .\deploy\verify.ps1
#
# Hits public + auth-gated endpoints, checks status codes + key strings in
# response bodies. Doesn't try to upload — just verifies routing, rendering,
# CSP, and signed-URL surface.

param(
    [string]$BaseUrl = 'http://localhost:3000'
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $msg = if ($Detail) { "$Name -- $Detail" } else { $Name }
    if ($Ok) {
        Write-Host "[OK]   $msg" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "[FAIL] $msg" -ForegroundColor Red
        $script:fail++
    }
}

function Get-Url {
    param([string]$Path)
    try {
        return Invoke-WebRequest -Uri ($BaseUrl + $Path) -UseBasicParsing -SkipHttpErrorCheck -MaximumRedirection 0 -ErrorAction SilentlyContinue
    } catch {
        Write-Host "Request failed: $Path -- $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

Write-Host "`n=== PrutCMS verify @ $BaseUrl ===`n" -ForegroundColor Cyan

# ── Server up at all? ─────────────────────────────────────────────
$home = Get-Url '/'
$serverUp = ($home -ne $null) -and ($home.StatusCode -eq 200 -or $home.StatusCode -eq 302)
Check 'Server responds on /' $serverUp

if (-not $serverUp) {
    Write-Host "`nServer not reachable. Is 'npm run dev' running?" -ForegroundColor Red
    exit 1
}

# ── Manifest & feeds ──────────────────────────────────────────────
$mf = Get-Url '/manifest.webmanifest'
Check 'Manifest responds 200' ($mf -ne $null -and $mf.StatusCode -eq 200)
$mfJson = $null
if ($mf -and $mf.Content) {
    try { $mfJson = $mf.Content | ConvertFrom-Json } catch {}
}
Check 'Manifest has scope field'   ($mfJson -ne $null -and $mfJson.scope -ne $null)
Check 'Manifest id starts prutcms-' ($mfJson -ne $null -and $mfJson.id -like 'prutcms-*')
Check 'Manifest scope ends with /' ($mfJson -ne $null -and $mfJson.scope.EndsWith('/'))

$feed = Get-Url '/feed.xml'
Check 'RSS /feed.xml: 200 + xml'   ($feed -ne $null -and $feed.StatusCode -eq 200 -and $feed.Content -like '*<rss*')
$atom = Get-Url '/atom.xml'
Check 'Atom /atom.xml: 200 + xml'  ($atom -ne $null -and $atom.StatusCode -eq 200 -and $atom.Content -like '*<feed*')
$sm = Get-Url '/sitemap.xml'
Check 'Sitemap (200 or 404)' ($sm -ne $null -and ($sm.StatusCode -eq 200 -or $sm.StatusCode -eq 404))

# ── Search ─────────────────────────────────────────────────────────
$s = Get-Url '/search?q=test'
Check 'Search: 200'                ($s -ne $null -and $s.StatusCode -eq 200)
Check 'Search has form input'      ($s -ne $null -and $s.Content -like '*name="q"*')

# ── Audio streaming guards ────────────────────────────────────────
$noToken = Get-Url '/audio/stream/foo.mp3'
Check 'No token: 403' ($noToken -ne $null -and $noToken.StatusCode -eq 403)

$badToken = Get-Url '/audio/stream/foo.mp3?t=deadbeef&exp=9999999999'
Check 'Bad token: 403' ($badToken -ne $null -and $badToken.StatusCode -eq 403)

$traverse = Get-Url '/audio/stream/..%2Fevil'
Check 'Path traversal: 4xx' ($traverse -ne $null -and $traverse.StatusCode -ge 400 -and $traverse.StatusCode -lt 500)

# ── Auth-gated routes preserve ?next= ──────────────────────────────
$account = Get-Url '/account'
Check '/account redirects (302)' ($account -ne $null -and $account.StatusCode -eq 302)
$loc = if ($account) { $account.Headers.Location } else { $null }
Check 'Redirect contains ?next=' ($loc -ne $null -and $loc -like '*/auth/login?next=*')

$admin = Get-Url '/admin'
Check '/admin requires auth' ($admin -ne $null -and ($admin.StatusCode -eq 302 -or $admin.StatusCode -eq 403))

# ── Auth pages ─────────────────────────────────────────────────────
$login = Get-Url '/auth/login'
Check 'Login page: 200'              ($login -ne $null -and $login.StatusCode -eq 200)
Check "Login has 'Forgot password?'" ($login -ne $null -and $login.Content -like '*Forgot password*')

$reset = Get-Url '/auth/reset-request'
Check 'Reset-request page: 200'      ($reset -ne $null -and $reset.StatusCode -eq 200)

# ── Reserved slugs ─────────────────────────────────────────────────
$tag = Get-Url '/tag/anything'
Check '/tag/:tag responds' ($tag -ne $null -and ($tag.StatusCode -eq 200 -or $tag.StatusCode -eq 404))

$users = Get-Url '/users/nonexistent'
Check '/users/:username 404 when missing' ($users -ne $null -and $users.StatusCode -eq 404)

# ── Prutter (route exists; status depends on enable_prutter + login) ──
$prutter = Get-Url '/prutter'
Check '/prutter route present' ($prutter -ne $null -and ($prutter.StatusCode -eq 302 -or $prutter.StatusCode -eq 404))

# ── HTMX bundled locally ──────────────────────────────────────────
$htmx = Get-Url '/assets/js/htmx.min.js'
Check 'HTMX file served' ($htmx -ne $null -and $htmx.StatusCode -eq 200)
Check 'HTMX is the real lib (>20 KB, not the loader stub)' `
      ($htmx -ne $null -and $htmx.Content.Length -gt 20000)

# ── CSP / security headers ────────────────────────────────────────
$csp = if ($home) { $home.Headers.'Content-Security-Policy' } else { $null }
Check 'CSP present' ($csp -ne $null)
Check 'CSP no longer references unpkg.com' ($csp -ne $null -and $csp -notlike '*unpkg*')

$nosniff = if ($home) { $home.Headers.'X-Content-Type-Options' } else { $null }
Check 'Helmet active (X-Content-Type-Options: nosniff)' ($nosniff -eq 'nosniff')

# ── Summary ───────────────────────────────────────────────────────
Write-Host "`n────────────────────────────────────────"
$summary = "$($script:pass) passed, $($script:fail) failed."
if ($script:fail -eq 0) {
    Write-Host $summary -ForegroundColor Green
} else {
    Write-Host $summary -ForegroundColor Red
    exit 1
}
