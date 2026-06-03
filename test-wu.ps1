$u = New-Object -ComObject Microsoft.Update.Session
$s = $u.CreateUpdateSearcher()

try {
    $r = $s.Search("IsInstalled=0 and Type='Driver'")
    Write-Output "Driver OK: $($r.Updates.Count)"
} catch {
    Write-Output "Driver Failed: $($_.Exception.Message)"
}

try {
    $r2 = $s.Search("IsInstalled=0 and (Type='Software' or Type='Driver')")
    Write-Output "OR OK: $($r2.Updates.Count)"
} catch {
    Write-Output "OR Failed: $($_.Exception.Message)"
}
