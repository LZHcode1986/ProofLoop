[CmdletBinding(DefaultParameterSetName = 'zip')]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetProjectPath,

    [Parameter(ParameterSetName = 'zip', Mandatory = $true)]
    [string]$RepositoryZipUrl,

    [Parameter(ParameterSetName = 'local', Mandatory = $true)]
    [string]$SourceRepoPath,

    [string]$AgentInstallRoot = (Join-Path $HOME '.opencode'),

    [string]$SkillInstallRoot = (Join-Path $HOME '.agents'),

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Info {
    param([string]$Message)
    Write-Host "[ProofLoop Bootstrap] $Message"
}

$repoRoot = $null
$tempRoot = $null

try {
    if ($PSCmdlet.ParameterSetName -eq 'local') {
        if (-not (Test-Path $SourceRepoPath)) {
            throw "Source repo path does not exist: $SourceRepoPath"
        }

        $repoRoot = (Resolve-Path $SourceRepoPath).Path
        Write-Info "Using local repository source: $repoRoot"
    }
    else {
        $tempRoot = Join-Path $env:TEMP ("proofloop-install-" + [guid]::NewGuid().ToString('N'))
        $zipPath = Join-Path $tempRoot 'proofloop.zip'
        $extractPath = Join-Path $tempRoot 'source'

        New-Item -ItemType Directory -Path $extractPath -Force | Out-Null

        Write-Info "Downloading ProofLoop archive from $RepositoryZipUrl"
        Invoke-WebRequest -Uri $RepositoryZipUrl -OutFile $zipPath

        Write-Info 'Expanding archive'
        Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

        $repoDirectory = Get-ChildItem -Path $extractPath -Directory | Select-Object -First 1
        if (-not $repoDirectory) {
            throw 'Unable to locate extracted repository root.'
        }

        $repoRoot = $repoDirectory.FullName
        Write-Info "Using extracted repository source: $repoRoot"
    }

    $installerPath = Join-Path $repoRoot 'install/install-proofloop.ps1'
    if (-not (Test-Path $installerPath)) {
        throw "Installer script not found: $installerPath"
    }

    $installerParams = @{
        TargetProjectPath = $TargetProjectPath
        AgentInstallRoot = $AgentInstallRoot
        SkillInstallRoot = $SkillInstallRoot
    }

    if ($DryRun) {
        $installerParams.DryRun = $true
    }

    Write-Info 'Running ProofLoop installer'
    & $installerPath @installerParams
}
finally {
    if ($tempRoot -and (Test-Path $tempRoot)) {
        Write-Info 'Cleaning up temporary bootstrap files'
        Remove-Item -Path $tempRoot -Recurse -Force
    }
}
