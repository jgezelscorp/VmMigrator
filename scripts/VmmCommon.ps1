# Shared helpers for the VmMigrator wrapper scripts (dot-sourced; not meant to be run directly).
Set-StrictMode -Version Latest

function Get-VmmBaseUrl {
    param([string]$BaseUrl)
    if ($BaseUrl) { return $BaseUrl.TrimEnd('/') }
    if ($env:VMM_URL) { return $env:VMM_URL.TrimEnd('/') }
    return 'http://127.0.0.1:3000'
}

function Invoke-VmmApi {
    param(
        [string]$BaseUrl,
        [Parameter(Mandatory)][ValidateSet('GET', 'POST')][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        $Body
    )
    $uri = (Get-VmmBaseUrl $BaseUrl) + $Path
    try {
        if ($null -ne $Body) {
            return Invoke-RestMethod -Method $Method -Uri $uri -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 10)
        }
        return Invoke-RestMethod -Method $Method -Uri $uri
    }
    catch {
        $detail = $_.ErrorDetails.Message
        if ($detail) {
            try { $detail = ($detail | ConvertFrom-Json).message } catch { }
        }
        if (-not $detail) { $detail = $_.Exception.Message }
        throw "VmMigrator API $Method $Path failed: $detail (is the server running? start it with 'npm start')"
    }
}

function Resolve-VmmVmIds {
    # Accepts full ARM ids, or names together with -SubscriptionId (resolved through discovery).
    param([string]$BaseUrl, [string[]]$VmId, [string[]]$VmName, [string]$SubscriptionId)
    $ids = @()
    if ($VmId) { $ids += $VmId }
    if ($VmName) {
        $q = if ($SubscriptionId) { "?subscriptionId=$SubscriptionId" } else { '' }
        $all = (Invoke-VmmApi -BaseUrl $BaseUrl -Method GET -Path "/api/vms$q").vms
        foreach ($n in $VmName) {
            $hit = @($all | Where-Object { $_.name -ieq $n })
            if ($hit.Count -eq 0) { throw "VM '$n' not found." }
            if ($hit.Count -gt 1) { throw "VM name '$n' is ambiguous; pass -VmId or -SubscriptionId." }
            $ids += $hit[0].id
        }
    }
    if ($ids.Count -eq 0) { throw 'Specify -VmId or -VmName.' }
    return $ids
}
