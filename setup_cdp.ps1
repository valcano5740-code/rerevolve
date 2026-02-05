$WshShell = New-Object -ComObject WScript.Shell
$shortcuts = @(
    "$env:USERPROFILE\Desktop\Antigravity.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Antigravity\Antigravity.lnk"
)

$cdpArg = "--remote-debugging-port=9000"

foreach ($shortcut in $shortcuts) {
    if (Test-Path $shortcut) {
        $link = $WshShell.CreateShortcut($shortcut)
        Write-Host "Found: $shortcut"
        Write-Host "Current Args: '$($link.Arguments)'"
        
        if ($link.Arguments -notlike "*--remote-debugging-port*") {
            $link.Arguments = ($link.Arguments + " " + $cdpArg).Trim()
            $link.Save()
            Write-Host "Modified! New Args: '$($link.Arguments)'"
        } else {
            Write-Host "Already has CDP option"
        }
    } else {
        Write-Host "Not found: $shortcut"
    }
}
