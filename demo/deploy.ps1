[CmdletBinding()]
param(
    [string]$Subscription = '306af555-a7da-440e-9b89-31b913b02384',
    [string]$ResourceGroup = 'rg-vmmigrator-demo',
    [string]$Location = 'swedencentral',
    # Filter the fleet by size series, e.g. -Series Fs,DS2_v2,D2s_v3. Omit for the full fleet.
    [string[]]$Series,
    [string]$OperatorIp = '',
    [string]$AdminUser = 'demoadmin',
    # Falls back to $env:VMMIG_ADMIN_PASSWORD, then a generated password.
    [string]$AdminPassword,
    [switch]$NoAutoShutdown,
    [switch]$NoBastion,
    [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

az account set -s $Subscription
az group create -n $ResourceGroup -l $Location --tags purpose=vm-migrator-demo -o none

$password = if ($AdminPassword) { $AdminPassword } else { $env:VMMIG_ADMIN_PASSWORD }
$generated = $false
if (-not $password) {
    $chars = (48..57) + (65..90) + (97..122) | ForEach-Object { [char]$_ }
    $password = 'Aa1!' + (-join (1..20 | ForEach-Object { $chars | Get-Random }))
    $generated = $true
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
    '--parameters', "adminUsername=$AdminUser", "adminPassword=$password", "operatorIp=$OperatorIp",
    "enableAutoShutdown=$((-not $NoAutoShutdown).ToString().ToLower())", "vms=@$vmFile")

try {
    if ($WhatIf) { az deployment group what-if @deployArgs }
    else { az deployment group create -n vmmigrator-demo @deployArgs --query properties.outputs -o json }
}
finally { Remove-Item $vmFile -ErrorAction SilentlyContinue }

if (-not $WhatIf -and -not $NoBastion) {
    & "$here\bastion.ps1" -Subscription $Subscription -ResourceGroup $ResourceGroup
}

if (-not $WhatIf) {
    $vms = az vm list --subscription $Subscription -g $ResourceGroup --query '[].{name:name,size:hardwareProfile.vmSize,os:storageProfile.osDisk.osType}' -o json | ConvertFrom-Json
    Write-Host ''
    Write-Host '=== Logon information ===' -ForegroundColor Cyan
    Write-Host "Username : $AdminUser"
    Write-Host "Password : $password$(if ($generated) { '   (generated, shown only now)' })"
    $bastion = az network bastion list --subscription $Subscription -g $ResourceGroup --query '[0].name' -o tsv 2>$null
    if ($bastion) {
        Write-Host "Access   : Azure portal > VM > Connect > Bastion (RDP for Windows, SSH for Linux); Bastion '$bastion'"
    } else {
        Write-Host 'Access   : VMs have no public IP; run .\demo\bastion.ps1 to create a Bastion'
    }
    Write-Host "Resource group: $ResourceGroup"
    $vms | Sort-Object name | ForEach-Object { Write-Host ("  {0,-24} {1,-18} {2}" -f $_.name, $_.size, $_.os) }
}
