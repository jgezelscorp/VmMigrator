[CmdletBinding()]
param(
    [string]$Subscription = '0832b3b6-22b3-4c47-8d8b-572054b97257',
    [string]$ResourceGroup = 'rg-vmmigrator-demo',
    [string]$Location = 'swedencentral',
    # Filter the fleet by size series, e.g. -Series Dsv3,DS2_v2,E2s_v3,A2_v2. Omit for the full fleet.
    [string[]]$Series,
    [string]$OperatorIp = '',
    [switch]$NoAutoShutdown,
    [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

az account set -s $Subscription
az group create -n $ResourceGroup -l $Location --tags purpose=vm-migrator-demo -o none

$password = $env:VMMIG_ADMIN_PASSWORD
if (-not $password) {
    $chars = (48..57) + (65..90) + (97..122) | ForEach-Object { [char]$_ }
    $password = 'Aa1!' + (-join (1..20 | ForEach-Object { $chars | Get-Random }))
    Write-Host "Generated admin password (shown once): $password"
}

$all = @(Get-Content "$here\vms.default.json" -Raw | ConvertFrom-Json)
$sel = $all
if ($Series) {
    # Normalise 'Standard_D2s_v3' and 'Dsv3' alike: drop prefix, digits and underscores
    $norm = { param($s) ($s -replace 'Standard_', '' -replace '\d', '' -replace '_', '').ToLower() }
    $want = $Series | ForEach-Object { & $norm $_ }
    $sel = @($all | Where-Object { $want -contains (& $norm $_.size) })
    if (-not $sel) { throw "No VM in vms.default.json matches -Series $($Series -join ',')" }
}
$vmFile = Join-Path $here 'vms.selected.json'
ConvertTo-Json -InputObject @($sel) -Depth 5 | Set-Content $vmFile

$deployArgs = @('--resource-group', $ResourceGroup, '--template-file', "$here\main.bicep",
    '--parameters', "adminPassword=$password", "operatorIp=$OperatorIp",
    "enableAutoShutdown=$((-not $NoAutoShutdown).ToString().ToLower())", "vms=@$vmFile")

try {
    if ($WhatIf) { az deployment group what-if @deployArgs }
    else { az deployment group create -n vmmigrator-demo @deployArgs --query properties.outputs -o json }
}
finally { Remove-Item $vmFile -ErrorAction SilentlyContinue }
