$UpdateSession = New-Object -ComObject Microsoft.Update.Session
$UpdateSearcher = $UpdateSession.CreateUpdateSearcher()
$SearchResult = $UpdateSearcher.Search("IsInstalled=0")
foreach ($Update in $SearchResult.Updates) {
    Write-Output "$($Update.Title) - Type: $($Update.Type) - IsHidden: $($Update.IsHidden)"
}
