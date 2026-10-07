[CmdletBinding()]
param(
    [string]$Subscription = '306af555-a7da-440e-9b89-31b913b02384',
    [string]$ResourceGroup = 'rg-vmmigrator-demo',
    [string]$Name = 'vmmig-bastion',
    [string]$VnetName = 'vmmig-vnet',
    [ValidateSet('Basic', 'Standard')][string]$Sku = 'Basic',
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$sub = @('--subscription', $Subscription)
$tags = 'purpose=vm-migrator-demo'

if ($Remove) {
    az network bastion delete -g $ResourceGroup -n $Name @sub 2>$null
    az network public-ip delete -g $ResourceGroup -n "$Name-pip" @sub 2>$null
    Write-Host "Bastion $Name removed."
    return
}

$vnet = az network vnet show -g $ResourceGroup -n $VnetName @sub -o json 2>$null | ConvertFrom-Json
if (-not $vnet) { throw "VNet $VnetName not found in $ResourceGroup. Run demo\deploy.ps1 first." }

$existing = az network bastion show -g $ResourceGroup -n $Name @sub -o json 2>$null | ConvertFrom-Json
if ($existing) {
    Write-Host "Bastion $Name already exists ($($existing.provisioningState)). Nothing to do."
    return
}

$hasSubnet = az network vnet subnet show -g $ResourceGroup --vnet-name $VnetName -n AzureBastionSubnet @sub -o tsv --query name 2>$null
if (-not $hasSubnet) {
    az network vnet subnet create -g $ResourceGroup --vnet-name $VnetName -n AzureBastionSubnet `
        --address-prefixes 10.50.2.0/26 @sub -o none
}

az network public-ip create -g $ResourceGroup -n "$Name-pip" -l $vnet.location --sku Standard `
    --allocation-method Static --tags $tags @sub -o none

Write-Host "Creating Azure Bastion ($Sku). This takes about 5-10 minutes..."
az network bastion create -g $ResourceGroup -n $Name -l $vnet.location --vnet-name $VnetName `
    --public-ip-address "$Name-pip" --sku $Sku --tags $tags @sub -o none

Write-Host "Bastion ready. Azure portal > VM > Connect > Bastion (user: demoadmin)."
