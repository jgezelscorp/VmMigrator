[CmdletBinding()]
param(
    [string]$Subscription = '306af555-a7da-440e-9b89-31b913b02384',
    [string]$ResourceGroup = 'rg-vmmigrator-demo',
    [string]$Location = 'swedencentral',
    [string[]]$Series,
    [string]$OperatorIp = '',
    [switch]$NoAutoShutdown,
    # Also remove local migration job state so the UI starts clean.
    [switch]$ClearJobs,
    [int]$TimeoutMinutes = 30
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

az account set -s $Subscription
$exists = az group exists -n $ResourceGroup
if ($exists -eq 'true') {
    & "$here\cleanup.ps1" -Subscription $Subscription -ResourceGroup $ResourceGroup
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    Write-Host "Waiting for $ResourceGroup to be deleted..."
    while ((az group exists -n $ResourceGroup) -eq 'true') {
        if ((Get-Date) -gt $deadline) { throw "Timed out waiting for $ResourceGroup deletion." }
        Start-Sleep -Seconds 15
    }
    Write-Host 'Resource group deleted.'
}
else { Write-Host "$ResourceGroup does not exist; skipping cleanup." }

if ($ClearJobs) {
    $jobs = Join-Path $here '..\data\jobs'
    if (Test-Path $jobs) { Get-ChildItem $jobs -Filter *.json | Remove-Item -Force; Write-Host 'Cleared data\jobs.' }
}

$deployParams = @{ Subscription = $Subscription; ResourceGroup = $ResourceGroup; Location = $Location; OperatorIp = $OperatorIp }
if ($Series) { $deployParams.Series = $Series }
if ($NoAutoShutdown) { $deployParams.NoAutoShutdown = $true }
& "$here\deploy.ps1" @deployParams
Write-Host 'Demo fleet redeployed to its original v1/v2/v3 state.'
