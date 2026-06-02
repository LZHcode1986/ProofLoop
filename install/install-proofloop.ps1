param(
  [Parameter(Mandatory=$true)]
  [string]$TargetProjectPath,

  [switch]$EnableCodeGraph,

  [switch]$OverwriteCanonicalSkills
)

Write-Host "Installing ProofLoop v3.3 workflow overlay..."

if (-not $OverwriteCanonicalSkills) {
  Write-Host "Canonical skills will NOT be overwritten."
  Write-Host "Protected:"
  Write-Host "  .agents/skills/openspec-propose/SKILL.md"
  Write-Host "  .agents/skills/openspec-apply-change/SKILL.md"
  Write-Host "  .agents/skills/openspec-archive-change/SKILL.md"
  Write-Host "  .agents/skills/test-driven-development/SKILL.md"
}

# This script is a reference installer skeleton.
# Copy root docs, agents, contracts, OpenSpec schema, and install docs into the target project.
# Active agents:
# - brain
# - propose
# - executor
# - worker
# - code-verifier
# - planning-contract-verifier
# - implementation-reviewer
# - committer
# - web-scraper
#
# Deprecated compatibility:
# - spec-verifier alias only
#
# Do not install as active default:
# - reality-verifier
# - reality-verifier-codegraph

if ($EnableCodeGraph) {
  Write-Host "CodeGraph enabled. After install, initialize CodeGraph in the target project if needed:"
  Write-Host "  codegraph status"
  Write-Host "  codegraph init -i"
}

Write-Host "ProofLoop v3.3 install guidance complete."
