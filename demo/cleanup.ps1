[CmdletBinding()]
param(
    [string]$Subscription = '0832b3b6-22b3-4c47-8d8b-572054b97257',
    [string]$ResourceGroup = 'rg-vmmigrator-demo'
)
$ErrorActionPreference = 'Stop'
az account set -s $Subscription
$purpose = az group show -n $ResourceGroup --query 'tags.purpose' -o tsv 2>$null
if ($purpose -ne 'vm-migrator-demo') { throw "Refusing to delete '$ResourceGroup': missing tag purpose=vm-migrator-demo" }
az group delete -n $ResourceGroup --yes --no-wait
Write-Host "Deletion of $ResourceGroup started."
