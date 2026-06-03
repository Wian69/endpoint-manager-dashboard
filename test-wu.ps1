$UpdateSession = New-Object -ComObject Microsoft.Update.Session
$UpdateSearcher = $UpdateSession.CreateUpdateSearcher()
$UpdateSearcher.Online = $false
$SearchResult = $UpdateSearcher.Search("IsInstalled=0 and IsHidden=0")
Write-Output "Pending: $($SearchResult.Updates.Count)"
