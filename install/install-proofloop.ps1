[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetProjectPath,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot '..')).Path

if (-not (Test-Path $TargetProjectPath)) {
    throw "Target project path does not exist: $TargetProjectPath"
}

$targetRoot = (Resolve-Path $TargetProjectPath).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$actions = New-Object System.Collections.Generic.List[string]

$projectFileAssets = @(
    'AGENTS.md',
    'tech-spec.md',
    'openspec/QUALITY-GATE.md',
    'openspec/config.yaml.example',
    'openspec/schemas/README.md'
)

$projectDirectoryAssets = @(
    'openspec/schemas/spec-driven'
)

function Write-Info {
    param([string]$Message)
    Write-Host "[ProofLoop] $Message"
}

function Ensure-ParentDirectory {
    param([string]$Path)

    $parent = Split-Path -Parent $Path
    if ([string]::IsNullOrWhiteSpace($parent)) {
        return
    }

    if (-not (Test-Path $parent)) {
        if ($DryRun) {
            Write-Info "Would create directory: $parent"
        }
        else {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
    }
}

function Backup-ExistingPath {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return
    }

    $backupPath = "$Path.spec-driven.bak-$timestamp"
    if ($DryRun) {
        Write-Info "Would back up $Path -> $backupPath"
    }
    else {
        Copy-Item -Path $Path -Destination $backupPath -Recurse -Force
    }

    $actions.Add("backup: $Path -> $backupPath") | Out-Null
}

function Install-File {
    param(
        [string]$SourcePath,
        [string]$DestinationPath,
        [string]$Label
    )

    if (-not (Test-Path $SourcePath)) {
        throw "Missing installer source file: $SourcePath"
    }

    Ensure-ParentDirectory -Path $DestinationPath

    if (Test-Path $DestinationPath) {
        Backup-ExistingPath -Path $DestinationPath
    }

    if ($DryRun) {
        Write-Info "Would copy file: $Label"
    }
    else {
        Copy-Item -Path $SourcePath -Destination $DestinationPath -Force
    }

    $actions.Add("file: $Label") | Out-Null
}

function Install-Directory {
    param(
        [string]$SourcePath,
        [string]$DestinationPath,
        [string]$Label
    )

    if (-not (Test-Path $SourcePath)) {
        throw "Missing installer source directory: $SourcePath"
    }

    Ensure-ParentDirectory -Path $DestinationPath

    if (Test-Path $DestinationPath) {
        Backup-ExistingPath -Path $DestinationPath
        if ($DryRun) {
            Write-Info "Would replace directory: $DestinationPath"
        }
        else {
            Remove-Item -Path $DestinationPath -Recurse -Force
        }
    }

    if ($DryRun) {
        Write-Info "Would copy directory: $Label"
    }
    else {
        New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
        Copy-Item -Path (Join-Path $SourcePath '*') -Destination $DestinationPath -Recurse -Force
    }

    $actions.Add("directory: $Label") | Out-Null
}

function Install-RelativeFileToTarget {
    param([string]$RelativePath)

    Install-File  -SourcePath (Join-Path $repoRoot $RelativePath)  -DestinationPath (Join-Path $targetRoot $RelativePath)  -Label $RelativePath
}

function Install-RelativeDirectoryToTarget {
    param([string]$RelativePath)

    Install-Directory  -SourcePath (Join-Path $repoRoot $RelativePath)  -DestinationPath (Join-Path $targetRoot $RelativePath)  -Label $RelativePath
}

function Set-ProofLoopSchema {
    $configPath = Join-Path $targetRoot 'openspec/config.yaml'
    $examplePath = Join-Path $targetRoot 'openspec/config.yaml.example'

    Ensure-ParentDirectory -Path $configPath

    if (-not (Test-Path $configPath)) {
        if (-not (Test-Path $examplePath)) {
            throw "Expected example config was not installed: $examplePath"
        }

        if ($DryRun) {
            Write-Info 'Would create openspec/config.yaml from config.yaml.example'
        }
        else {
            Copy-Item -Path $examplePath -Destination $configPath -Force
        }

        $actions.Add('config: created openspec/config.yaml from example') | Out-Null
        return
    }

    $raw = Get-Content -Path $configPath -Raw
    if ($raw -match '(?m)^\s*schema\s*:\s*spec-driven\s*$') {
        Write-Info 'openspec/config.yaml already points to schema: spec-driven'
        $actions.Add('config: schema already spec-driven') | Out-Null
        return
    }

    $updated = $raw
    if ($raw -match '(?m)^\s*schema\s*:') {
        $updated = [regex]::Replace($raw, '(?m)^\s*schema\s*:.*$', 'schema: spec-driven', 1)
    }
    else {
        $updated = "schema: spec-driven`r`n`r`n$raw"
    }

    Backup-ExistingPath -Path $configPath

    if ($DryRun) {
        Write-Info 'Would update openspec/config.yaml to use schema: spec-driven'
    }
    else {
        Set-Content -Path $configPath -Value $updated
    }

    $actions.Add('config: updated schema to spec-driven') | Out-Null
}

Write-Info "Installing ProofLoop project assets into $targetRoot"

foreach ($relativePath in $projectFileAssets) {
    Install-RelativeFileToTarget -RelativePath $relativePath
}

foreach ($relativePath in $projectDirectoryAssets) {
    Install-RelativeDirectoryToTarget -RelativePath $relativePath
}

$agentDestination = Join-Path $targetRoot '.opencode/agents'
$skillDestination = Join-Path $targetRoot '.agents/skills'

Write-Info "Installing ProofLoop agent definitions into $agentDestination"
Install-Directory  -SourcePath (Join-Path $repoRoot '.opencode/agents')  -DestinationPath $agentDestination  -Label '.opencode/agents'

$contractsSource = (Join-Path $repoRoot '.agents/contracts')
$contractsDestination = (Join-Path $targetRoot '.agents/contracts')
Write-Info "Installing ProofLoop dispatch contracts into $contractsDestination"
Install-Directory  -SourcePath $contractsSource  -DestinationPath $contractsDestination  -Label '.agents/contracts'

Write-Info "Installing ProofLoop skills into $skillDestination"
Install-Directory  -SourcePath (Join-Path $repoRoot '.agents/skills')  -DestinationPath $skillDestination  -Label '.agents/skills'

Set-ProofLoopSchema

Write-Host ''
Write-Host 'ProofLoop installation summary:'
$actions | ForEach-Object {
    Write-Host " - $_"
}
Write-Host ''
Write-Host 'Next steps:'
Write-Host ' - Fill any remaining placeholders in openspec/config.yaml if it was created from the example.'
Write-Host ' - Replace `Project: <project name>` in openspec/config.yaml with your actual project name.'
Write-Host ' - Run your normal OpenSpec validation command inside the target project.'

