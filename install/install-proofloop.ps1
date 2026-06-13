param(
  [Parameter(Mandatory=$true)]
  [string]$TargetProjectPath,

  [switch]$EnableCodeGraph,

  [switch]$InstallDeprecatedAliases,

  [switch]$InstallCanonicalSkills,

  [switch]$OverwriteCanonicalSkills,

  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Split-Path -Parent $ScriptDir

Write-Host "=== ProofLoop Installer ===" -ForegroundColor Cyan
Write-Host "Source: $RepoRoot"
Write-Host "Target: $TargetProjectPath"
Write-Host ""

# --- Pre-flight Checks ---

# 1. Target path validity
if (-not (Test-Path $TargetProjectPath)) {
  Write-Error "Target path does not exist: $TargetProjectPath"
  exit 1
}

# 2. Git cleanliness check
$gitDir = Join-Path $TargetProjectPath ".git"
if (Test-Path $gitDir) {
  $dirty = git -C $TargetProjectPath status --porcelain 2>$null
  if ($dirty) {
    Write-Warning "Target project has uncommitted changes."
    if (-not $Force) {
      Write-Error "Target worktree is dirty. Use -Force to proceed anyway or commit changes first."
      exit 1
    }
    Write-Warning "Proceeding with dirty worktree (-Force specified)."
  }
}

# 3. Existing ProofLoop version detection
$existingBrain = Join-Path $TargetProjectPath ".opencode/agents/brain.md"
$existingAGENTS = Join-Path $TargetProjectPath "AGENTS.md"
if ((Test-Path $existingBrain) -or (Test-Path $existingAGENTS)) {
  Write-Warning "Target project already has ProofLoop overlay."
  if (-not $Force) {
    $confirm = Read-Host "Continue and overwrite core agents/contracts? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
      Write-Host "Installation cancelled." -ForegroundColor Yellow
      exit 0
    }
  }
}

# --- File Lists ---

$DefaultAgents = @(
  ".opencode/agents/brain.md",
  ".opencode/agents/propose.md",
  ".opencode/agents/executor.md",
  ".opencode/agents/worker.md",
  ".opencode/agents/code-verifier.md",
  ".opencode/agents/planning-contract-verifier.md",
  ".opencode/agents/implementation-reviewer.md",
  ".opencode/agents/committer.md",
  ".opencode/agents/web-scraper.md"
)

$Contracts = @(
  ".agents/contracts/brain/external-research.md",
  ".agents/contracts/brain/general-edit.md",
  ".agents/contracts/brain/propose.md",
  ".agents/contracts/brain/execute.md",
  ".agents/contracts/brain/stage-review.md",
  ".agents/contracts/executor/git-boundary.md",
  ".agents/contracts/executor/worker-implementation.md",
  ".agents/contracts/executor/worker-fix.md",
  ".agents/contracts/executor/code-verification.md",
  ".agents/contracts/executor/shared-worker-rules.md",
  ".agents/contracts/executor/shared-code-verification-rules.md",
  ".agents/contracts/executor/evidence-protocol.md",
  ".agents/contracts/proof-profiles.md",
  ".agents/contracts/codegraph-tool-protocol.md",
  ".agents/contracts/proofloop-skill-usage.md"
)

$RootFiles = @(
  "AGENTS.md",
  "README.md",
  "openspec/config.yaml.example"
)

$Scripts = @(
  "scripts/local-check.sh"
)

$SchemaDir = "openspec/schemas/proofloop-spec-driven"

$CanonicalSkills = @(
  ".agents/skills/openspec-propose/SKILL.md",
  ".agents/skills/openspec-apply-change/SKILL.md",
  ".agents/skills/openspec-archive-change/SKILL.md",
  ".agents/skills/test-driven-development/SKILL.md",
  ".agents/skills/code-review-and-quality/SKILL.md",
  ".agents/skills/diagnose/SKILL.md",
  ".agents/skills/grill-me-prd/SKILL.md",
  ".agents/skills/openspec-explore/SKILL.md",
  ".agents/skills/security-and-hardening/SKILL.md",
  ".agents/skills/workflow-intake/SKILL.md"
)

# --- Rollback tracking ---
$script:InstalledFiles = [System.Collections.Generic.List[string]]::new()
$script:BackupDir = Join-Path ([System.IO.Path]::GetTempPath()) "proofloop-backup-$(Get-Date -Format 'yyyyMMddHHmmss')"
$script:BackupMap = @{}

function Copy-Safe {
  param([string]$RelativePath, [string]$SourceRoot, [string]$TargetRoot)
  $src = Join-Path $SourceRoot $RelativePath
  $dst = Join-Path $TargetRoot $RelativePath
  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path $dstDir)) {
    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
  }
  if (Test-Path $src) {
    if (Test-Path $dst) {
      $backupPath = Join-Path $script:BackupDir $RelativePath
      $backupParent = Split-Path -Parent $backupPath
      if (-not (Test-Path $backupParent)) {
        New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
      }
      Copy-Item -Path $dst -Destination $backupPath -Force
      $script:BackupMap[$dst] = $backupPath
    }
    Copy-Item -Path $src -Destination $dst -Force
    $script:InstalledFiles.Add($dst)
    Write-Host "  OK: $RelativePath" -ForegroundColor Green
  } else {
    Write-Warning "  SKIP (source not found): $RelativePath"
  }
}

function Copy-SchemaDir {
  param([string]$SourceRoot, [string]$TargetRoot)
  $srcDir = Join-Path $SourceRoot $SchemaDir
  $dstDir = Join-Path $TargetRoot $SchemaDir
  if (Test-Path $dstDir) {
    $existingFiles = Get-ChildItem -Path $dstDir -Recurse -File
    foreach ($ef in $existingFiles) {
      $rel = $ef.FullName.Substring($dstDir.Length).TrimStart('\', '/')
      $backupPath = Join-Path $script:BackupDir "$SchemaDir/$rel"
      $backupParent = Split-Path -Parent $backupPath
      if (-not (Test-Path $backupParent)) {
        New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
      }
      Copy-Item -Path $ef.FullName -Destination $backupPath -Force
      $script:BackupMap[$ef.FullName] = $backupPath
    }
  } else {
    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
  }
  if (Test-Path $srcDir) {
    $newFiles = Get-ChildItem -Path $srcDir -Recurse -File
    foreach ($nf in $newFiles) {
      $rel = $nf.FullName.Substring($srcDir.Length).TrimStart('\', '/')
      $dst = Join-Path $dstDir $rel
      $dstParent = Split-Path -Parent $dst
      if (-not (Test-Path $dstParent)) {
        New-Item -ItemType Directory -Path $dstParent -Force | Out-Null
      }
      Copy-Item -Path $nf.FullName -Destination $dst -Force
      $script:InstalledFiles.Add($dst)
    }
    $count = $newFiles.Count
    Write-Host "  OK: $SchemaDir ($count files)" -ForegroundColor Green
  } else {
    Write-Warning "  SKIP (source not found): $SchemaDir"
  }
}

function Invoke-Rollback {
  Write-Host ""
  Write-Host "Rolling back installation..." -ForegroundColor Yellow

  foreach ($file in $script:InstalledFiles) {
    if ($script:BackupMap.ContainsKey($file)) {
      Copy-Item -Path $script:BackupMap[$file] -Destination $file -Force
      Write-Host "  RESTORED: $file" -ForegroundColor Yellow
    } else {
      if (Test-Path $file) {
        Remove-Item -Path $file -Force
        Write-Host "  REMOVED: $file" -ForegroundColor Yellow
      }
    }
  }

  $createdDirs = $script:InstalledFiles | ForEach-Object { Split-Path -Parent $_ } | Sort-Object -Unique
  foreach ($dir in $createdDirs) {
    if ((Test-Path $dir) -and -not (Get-ChildItem -Path $dir -Force | Where-Object { $_.Name -ne '' } | Select-Object -First 1)) {
      Remove-Item -Path $dir -Force -Recurse
      Write-Host "  REMOVED EMPTY DIR: $dir" -ForegroundColor Yellow
    }
  }

  if (Test-Path $script:BackupDir) {
    Remove-Item -Path $script:BackupDir -Force -Recurse
  }

  Write-Host "Installation failed. Rolled back to pre-installation state." -ForegroundColor Red
  Write-Host "Check error logs above and retry." -ForegroundColor Red
}

# --- Install ---

try {

  Write-Host "Installing core files..." -ForegroundColor Cyan

  # Root files
  foreach ($f in $RootFiles) {
    Copy-Safe -RelativePath $f -SourceRoot $RepoRoot -TargetRoot $TargetProjectPath
  }

  # Scripts
  Write-Host "Installing scripts..." -ForegroundColor Cyan
  foreach ($f in $Scripts) {
    Copy-Safe -RelativePath $f -SourceRoot $RepoRoot -TargetRoot $TargetProjectPath
  }

  # Core agents
  Write-Host "Installing agents..." -ForegroundColor Cyan
  foreach ($f in $DefaultAgents) {
    Copy-Safe -RelativePath $f -SourceRoot $RepoRoot -TargetRoot $TargetProjectPath
  }

  # Contracts
  Write-Host "Installing contracts..." -ForegroundColor Cyan
  foreach ($f in $Contracts) {
    Copy-Safe -RelativePath $f -SourceRoot $RepoRoot -TargetRoot $TargetProjectPath
  }

  # Schema
  Write-Host "Installing schema..." -ForegroundColor Cyan
  Copy-SchemaDir -SourceRoot $RepoRoot -TargetRoot $TargetProjectPath

# --- Optional: Deprecated Aliases ---
  if ($InstallDeprecatedAliases) {
    Write-Host "Installing deprecated compatibility aliases..." -ForegroundColor Cyan
    Copy-Safe -RelativePath ".opencode/agents/spec-verifier.md" -SourceRoot $RepoRoot -TargetRoot $TargetProjectPath
  }

# --- Canonical Skills (skip by default) ---
Write-Host "Checking canonical skills..." -ForegroundColor Cyan
foreach ($skill in $CanonicalSkills) {
  $dst = Join-Path $TargetProjectPath $skill
  if ($OverwriteCanonicalSkills) {
    Copy-Safe -RelativePath $skill -SourceRoot $RepoRoot -TargetRoot $TargetProjectPath
  } elseif ((-not (Test-Path $dst)) -and $InstallCanonicalSkills) {
    Copy-Safe -RelativePath $skill -SourceRoot $RepoRoot -TargetRoot $TargetProjectPath
  } elseif (Test-Path $dst) {
    Write-Warning "Skipped existing canonical skill: $skill"
  } else {
    Write-Warning "Skipped canonical skill (use -InstallCanonicalSkills to install missing, -OverwriteCanonicalSkills to overwrite): $skill"
  }
}

  # --- Self-Verification ---
  Write-Host ""
  Write-Host "Verifying installation..." -ForegroundColor Cyan

  $requiredFiles = @(
    "AGENTS.md",
    ".opencode/agents/brain.md",
    ".opencode/agents/executor.md",
    ".agents/contracts/brain/execute.md",
    ".agents/contracts/executor/worker-implementation.md",
    ".agents/contracts/executor/shared-worker-rules.md"
  )

  $allPresent = $true
  foreach ($f in $requiredFiles) {
    $path = Join-Path $TargetProjectPath $f
    if (-not (Test-Path $path)) {
      Write-Error "MISSING: $f"
      $allPresent = $false
    }
  }

  if (-not $allPresent) {
    throw "Installation verification failed: required files missing."
  }

  Write-Host ""
  Write-Host "=== Installation Complete ===" -ForegroundColor Green
  Write-Host "Core agents: $($DefaultAgents.Count)"
  Write-Host "Contracts: $($Contracts.Count)"
  Write-Host "Schema: $SchemaDir"
  if ($InstallDeprecatedAliases) { Write-Host "Optional: spec-verifier.md installed" }
  if ($EnableCodeGraph) {
    Write-Host ""
    Write-Host "CodeGraph enabled. Initialize in target project:" -ForegroundColor Yellow
    Write-Host "  codegraph status"
    Write-Host "  codegraph init -i"
  }

} catch {
  Invoke-Rollback
  exit 1
} finally {
  if (Test-Path $script:BackupDir) {
    Remove-Item -Path $script:BackupDir -Force -Recurse -ErrorAction SilentlyContinue
  }
}
