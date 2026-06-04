$UpdateSession = New-Object -ComObject Microsoft.Update.Session
$UpdateSearcher = $UpdateSession.CreateUpdateSearcher()

Write-Output "--- IsInstalled=0 and BrowseOnly=1 ---"
try {
    $res1 = $UpdateSearcher.Search("IsInstalled=0 and BrowseOnly=1")
    Write-Output "Optional: $($res1.Updates.Count)"
} catch { Write-Output "Failed: $($_.Exception.Message)" }

Write-Output "--- IsInstalled=0 and AutoSelectOnWebSites=0 ---"
try {
    $res2 = $UpdateSearcher.Search("IsInstalled=0 and AutoSelectOnWebSites=0")
    Write-Output "Optional: $($res2.Updates.Count)"
} catch { Write-Output "Failed: $($_.Exception.Message)" }
