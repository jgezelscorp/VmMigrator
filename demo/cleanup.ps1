[CmdletBinding()]
param(
    [string]$Subscription = '306af555-a7da-440e-9b89-31b913b02384',
    [string]$ResourceGroup = 'rg-vmmigrator-demo'
)
$ErrorActionPreference = 'Stop'
az account set -s $Subscription
$purpose = az group show -n $ResourceGroup --query 'tags.purpose' -o tsv 2>$null
if ($purpose -ne 'vm-migrator-demo') { throw "Refusing to delete '$ResourceGroup': missing tag purpose=vm-migrator-demo" }
az group delete -n $ResourceGroup --yes --no-wait
Write-Host "Deletion of $ResourceGroup started."
