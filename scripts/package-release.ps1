# Package the freshly built MSI, the English install guide, the
# licences and the Corresponding Source into a single zip ready to
# share via Drive / WeTransfer / Slack / e-mail.
#
# Usage (from the pointcloudlabeler repo root):
#     npm run tauri:build
#     powershell -ExecutionPolicy Bypass -File scripts\package-release.ps1
#
# Output:
#     PointCloudLabeler-<version>.zip    next to package.json

# ASCII ONLY INSIDE STRING LITERALS. This file has no byte-order mark,
# and Windows PowerShell 5.1 (`powershell.exe`, what the usage line
# invokes) reads a BOM-less file as ANSI: an em dash's three UTF-8 bytes
# decode to three cp1252 characters, the last of which is a right double
# quotation mark, which PowerShell accepts as a closing quote. The string
# ended there, and the script failed to parse at all, a hundred lines
# further down. Comments may say what they like; strings stay plain.
# src/testing/notices.test.ts checks this.
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
$msiDir = Join-Path $root "src-tauri\target\release\bundle\msi"

if (-not (Test-Path $msiDir)) {
    Write-Error "MSI output dir not found: $msiDir`nRun 'npm run tauri:build' first."
    exit 1
}

# Pick the most recently modified MSI (in case multiple versions linger).
$msi = Get-ChildItem -Path $msiDir -Filter "PointCloudLabeler_*_x64_en-US.msi" |
       Sort-Object LastWriteTime -Descending |
       Select-Object -First 1
if (-not $msi) {
    Write-Error "No MSI found in $msiDir. Did the build succeed?"
    exit 1
}

# Pull the version out of the filename.
if ($msi.Name -match '_(\d+\.\d+\.\d+)_') {
    $version = $matches[1]
} else {
    $version = "unknown"
}

Write-Host "Packaging PointCloudLabeler $version"
Write-Host "  MSI: $($msi.FullName) ($([math]::Round($msi.Length / 1MB, 1)) MB)"

# Stage into a versioned subfolder so the zip extracts cleanly.
$stageRoot = Join-Path $root "release-package"
if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
$stage = Join-Path $stageRoot "PointCloudLabeler $version"
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Copy-Item $msi.FullName $stage

# The licences travel with the binary, not only with the repository.
# The MIT / BSD-3 notices of the several hundred bundled components
# require their copyright notices to accompany every copy — BSD-3
# says so in as many words — and GPL-3 section 4 requires this
# copy to carry the licence and the warranty disclaimer. They are also
# installed alongside the program itself (bundle.resources in
# tauri.conf.json); this puts them where somebody can read them BEFORE
# installing.
foreach ($doc in @("LICENSE", "LICENSE-DOCS", "THIRD-PARTY-NOTICES.md")) {
    $src = Join-Path $root $doc
    if (-not (Test-Path $src)) {
        Write-Error "Missing $doc - the release may not ship without it."
        exit 1
    }
    Copy-Item $src $stage
}

# --- Corresponding Source (GPL-3 section 6) --------------------------
#
# Under Apache-2.0 shipping the source was optional. Under the GPL a
# binary conveyed without its Corresponding Source is a licence
# violation, and the compliant options are: ship the source WITH it
# (6a/6b), or attach a written offer good for three years (6c), or —
# for a non-commercial peer-to-peer copy — point at where you got it
# (6d/6e).
#
# We take 6(a). It is the only one with no ongoing obligation attached
# and no dependency on GitHub, this repository, or the author still
# being reachable in three years' time. `git archive` of the exact
# revision is precisely "the whole repository as it was built", which
# is what Corresponding Source means for a project whose build scripts
# and lockfiles are in the tree.
#
# $ErrorActionPreference is "Stop" at the top of this script, and that
# means different things to a NATIVE command depending on which
# PowerShell is running. Windows ships 5.1 (`powershell.exe`, which is
# what the usage line above invokes), where a non-zero exit code from
# git only sets $LASTEXITCODE. PowerShell 7.4+ turns on
# $PSNativeCommandUseErrorActionPreference by default, where the same
# exit code THROWS — so `git rev-parse` failing outside a checkout,
# which is a question with an answer and not a crash, would abort with
# a stack trace instead of the sentence below.
#
# Pin it off for this block and put it back. Every git call here checks
# its own exit code, so nothing is being ignored — the checks are just
# allowed to run.
$prevNativeEAP = $null
if (Test-Path Variable:PSNativeCommandUseErrorActionPreference) {
    $prevNativeEAP = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
}
$srcName = "PointCloudLabeler-$version-source.zip"

# WHICH commit — the one the BINARY was compiled from, which build.rs
# wrote down beside it. Not HEAD.
#
# Archiving HEAD and refusing to run on a dirty tree looks equivalent
# and is not. Build, `git pull`, package: the tree is clean, the check
# passes, and the archive is a different commit from the executable
# next to it, with nothing in the package saying so. That is exactly
# the failure GPL-3 section 6 is about, dressed as compliance.
$commitFile = Join-Path $root "src-tauri\target\release\build-commit.txt"
if (-not (Test-Path $commitFile)) {
    Write-Error "No build-commit.txt beside the binary. Either this predates build.rs recording the revision, or the release build did not run. Rebuild with 'npm run tauri:build'."
    exit 1
}
# "$(...)": Get-Content -Raw returns $null for an EMPTY file, and a method
# call on $null is an error in PowerShell 5.1. Wrapped, an empty file is
# an empty string, which is what it means.
$revision = "$(Get-Content $commitFile -Raw)".Trim()

# A build that linked a proprietary library cannot be conveyed under the
# GPL at all, whatever the source archive says. `rdblib` is RIEGL's SDK:
# non-redistributable, so §6's Corresponding Source is impossible, and
# §1's System Libraries exception does not cover a vendor SDK.
#
# This is the one thing that separates "the build I use" from "the build
# I publish", and nothing else in the repository enforces it. Building
# with the feature stays perfectly legitimate — the GPL constrains
# conveying, not use — so the refusal is here, at the moment a package
# is made for someone else, and not at the compiler.
$proprietaryFile = Join-Path $root "src-tauri\target\release\build-proprietary.txt"
if (Test-Path $proprietaryFile) {
    # build.rs writes this file EMPTY when no proprietary feature is on,
    # which is the normal release case - see the note above.
    $proprietary = "$(Get-Content $proprietaryFile -Raw)".Trim()
    if ($proprietary) {
        Write-Error "This binary was built with the proprietary feature(s): $proprietary. It links a non-redistributable library, so it cannot be conveyed under the GPL: no source archive can satisfy section 6 for it. Rebuild without the feature to make a release, or keep this build for your own use and do not distribute it."
        exit 1
    }
}

if ($revision -eq "unknown") {
    Write-Error "The binary was built outside a git checkout, so no commit is its source. GPL-3 section 6 requires the Corresponding Source; rebuild inside the repository."
    exit 1
}
if ($revision -like "*-dirty") {
    Write-Error "The binary was built from a working tree with uncommitted changes ($revision). No commit is its source, so no archive can be. Commit (or stash), rebuild, then package."
    exit 1
}

Push-Location $root
try {
    # Say so when the binary is behind the checkout. Not an error — the
    # archive still matches the binary, which is the whole point — but
    # the operator should know the release is not what HEAD says.
    $head = (& git rev-parse HEAD 2>&1)
    if ($LASTEXITCODE -eq 0 -and "$head".Trim() -ne $revision) {
        Write-Host "  Note: HEAD is $("$head".Trim().Substring(0,12)) but this binary was built from $($revision.Substring(0,12)). Shipping the source that matches the binary."
    }

    $srcPath = Join-Path $stage $srcName
    & git archive --format=zip --prefix="PointCloudLabeler-$version-source/" -o "$srcPath" $revision
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $srcPath)) {
        Write-Error "git archive failed for $revision - cannot ship the Corresponding Source."
        exit 1
    }
} finally {
    Pop-Location
    if ($null -ne $prevNativeEAP) {
        $PSNativeCommandUseErrorActionPreference = $prevNativeEAP
    }
}

$srcSize = [math]::Round((Get-Item (Join-Path $stage $srcName)).Length / 1MB, 1)
Write-Host "  Source: $srcName ($srcSize MB) @ $($revision.Substring(0,12))"

# INSTALL.txt promises the reader a named file and a named revision.
# Fill both in from what was actually produced, so the promise is a
# fact about this package rather than a sentence about releases in
# general.
# The template carries em dashes and arrows; read it as the UTF-8 it
# is, or PowerShell 5.1 hands INSTALL.txt three characters for each.
$readme = Join-Path $scriptDir "README-template.txt"
$installText = (Get-Content $readme -Raw -Encoding UTF8).
    Replace("@SOURCE_ARCHIVE@", $srcName).
    Replace("@SOURCE_REVISION@", $revision)
if ($installText -match '@SOURCE_\w+@') {
    Write-Error "INSTALL.txt still contains an unfilled placeholder: $($matches[0])"
    exit 1
}
Set-Content -Path (Join-Path $stage "INSTALL.txt") -Value $installText -Encoding UTF8

$zip = Join-Path $root "PointCloudLabeler-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

Remove-Item -Recurse -Force $stageRoot

$zipSize = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "Done."
Write-Host "  $zip ($zipSize MB)"
Write-Host ""
Write-Host "Share that single zip. Recipients extract it and follow INSTALL.txt."
Write-Host "It carries the installer, the licences and the source the binary was built from."
