<#
.SYNOPSIS
    Installs the custom Endpoint Management Agent for Intune deployment.
.DESCRIPTION
    This script writes the agent logic to C:\ProgramData\EndpointAgent and creates
    a Windows Scheduled Task to run it every 5 minutes as the SYSTEM account.
#>

$AgentDir = "C:\ProgramData\EndpointAgent"
$AgentScriptPath = "$AgentDir\AgentTask.ps1"
$ServerUrl = "https://endpoint-manager-dashboard.onrender.com" # CHANGE THIS BEFORE DEPLOYMENT

# 1. Create Directory
if (-not (Test-Path $AgentDir)) {
    New-Item -ItemType Directory -Path $AgentDir | Out-Null
}

# 2. Write the Agent Script Payload
$AgentPayload = @"
`$ServerUrl = "$ServerUrl"
`$Hostname = `$env:COMPUTERNAME
`$OSVersion = (Get-CimInstance Win32_OperatingSystem).Caption
`$AgentVersion = "1.6"

# Function to get pending updates
function Get-PendingUpdates {
    `$appUpdates = 0
    `$updateList = @()

    # Fast offline check for standard OS updates (skips drivers to prevent high CPU usage every minute)
    try {
        `$UpdateSession = New-Object -ComObject Microsoft.Update.Session
        `$UpdateSearcher = `$UpdateSession.CreateUpdateSearcher()
        `$UpdateSearcher.Online = `$false
        `$SearchResult = `$UpdateSearcher.Search("IsInstalled=0 and IsHidden=0")
        `$windowsUpdates = `$SearchResult.Updates.Count
    } catch {
        `$windowsUpdates = 0
    }
    # For WinGet:
    try {
        `$WingetPath = Get-ChildItem -Path "C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName -Last 1
        if (`$WingetPath) {
            `$env:WT_SESSION = `$null
            `$Upgrades = & `$WingetPath upgrade --accept-source-agreements | Out-String
            `$lines = `$Upgrades -split "``n"
            `$skipLines = `$true
            
            # Apps to ignore due to broken WinGet installers or their own auto-updaters
            `$IgnoreApps = @("Microsoft.Edge", "Google.Chrome", "Sonos", "Microsoft.DotNet", "ShiningLight.OpenSSL", "RARLab.WinRAR", "AnyDesk.AnyDesk", "Oracle.Java", "DominikReichl.KeePass", "Microsoft.WindowsAppRuntime", "Microsoft.VCLibs", "Mozilla.Firefox", "Adobe.Acrobat", "EPSON")

            foreach (`$line in `$lines) {
                if (`$line -match "^----") { `$skipLines = `$false; continue }
                if (`$skipLines) { continue }
                
                `$cols = `$line -split '\s{2,}'
                if (`$cols.Count -ge 3) {
                    `$id = `$cols[1]
                    if (`$id) {
                        `$shouldSkip = `$false
                        foreach (`$ignore in `$IgnoreApps) {
                            if (`$id -match `$ignore) { `$shouldSkip = `$true; break }
                        }
                        # Also skip broken version-only outputs
                        if (`$id -match '^\d+\.\d+') { `$shouldSkip = `$true }

                        if (-not `$shouldSkip) {
                            `$appUpdates++
                            `$updateList += `$id
                        }
                    }
                }
            }
        }
    } catch {}

    `$rebootPending = `$false
    if (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") { `$rebootPending = `$true }
    if (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") { `$rebootPending = `$true }

    return @{
        windows = `$windowsUpdates
        apps = `$appUpdates
        list = `$updateList
        rebootRequired = `$rebootPending
    }
}

# 1. Check-in with server
    # Check for pending updates to report to server
    `$updates = Get-PendingUpdates
    `$updateList = `$updates.list

    `$NetworkName = (Get-NetConnectionProfile -ErrorAction SilentlyContinue).Name -join ", "
    if (-not `$NetworkName) { `$NetworkName = "Unknown" }

    `$checkinBody = @{
    hostname = `$Hostname
    agentVersion = `$AgentVersion
    osVersion = `$OSVersion
    networkName = `$NetworkName
    pendingWindowsUpdates = `$updates.windows
    pendingAppUpdates = `$updates.apps
    updateList = `$updateList
    rebootRequired = `$updates.rebootRequired
} | ConvertTo-Json

try {
    Invoke-RestMethod -Uri "`$ServerUrl/api/agent/checkin" -Method Post -Body `$checkinBody -ContentType "application/json" -TimeoutSec 60
} catch {
    Write-Warning "Failed to check in with server"
}

# Function to send logs to the server
function Send-Log (`$jobId, `$message) {
    `$logBody = @{ log = `$message } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/log" -Method Post -Body `$logBody -ContentType "application/json" -TimeoutSec 60
    } catch {}
}

# Function to send progress to the server
function Send-Progress (`$jobId, `$progress) {
    `$progBody = @{ progress = `$progress } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/progress" -Method Post -Body `$progBody -ContentType "application/json" -TimeoutSec 60
    } catch {}
}

# 2. Check for jobs
try {
    `$jobResponse = Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$Hostname" -Method Get -TimeoutSec 60
    if (`$jobResponse.job) {
        `$jobId = `$jobResponse.job.id
        `$command = `$jobResponse.job.command

        if (`$command -eq 'Force-Updates') {
            # EXECUTING THE UPDATE LOGIC
            Send-Log `$jobId "Job started on `$Hostname."
            
            # Start Windows Updates via COM Object
            Send-Log `$jobId "Initiating Windows Update via COM Object (Microsoft.Update.Session)..."
            
            try {
                `$UpdateSession = New-Object -ComObject Microsoft.Update.Session
                `$UpdateSearcher = `$UpdateSession.CreateUpdateSearcher()
                
                # Perform standard driver/OS searches using the system's default update server (e.g. Intune/WSUS)
                `$SearchResult1 = `$UpdateSearcher.Search("IsInstalled=0 and IsHidden=0")
                `$SearchResult2 = `$UpdateSearcher.Search("IsInstalled=0 and IsHidden=0 and Type='Driver'")
                
                `$winUpdatesCount = `$SearchResult1.Updates.Count + `$SearchResult2.Updates.Count
                Send-Log `$jobId "Found `$winUpdatesCount pending Windows Update(s)."
                
                if (`$winUpdatesCount -gt 0) {
                    `$UpdatesToDownload = New-Object -ComObject Microsoft.Update.UpdateColl
                    foreach (`$Update in `$SearchResult1.Updates) {
                        `$UpdatesToDownload.Add(`$Update) | Out-Null
                        Send-Log `$jobId "Queued for download/install: [OS] `$(`$Update.Title)"
                    }
                    foreach (`$Update in `$SearchResult2.Updates) {
                        `$UpdatesToDownload.Add(`$Update) | Out-Null
                        Send-Log `$jobId "Queued for download/install: [Driver] `$(`$Update.Title)"
                    }
                    
                    Send-Log `$jobId "Downloading Windows Updates (this may take a while)..."
                    `$Downloader = `$UpdateSession.CreateUpdateDownloader()
                    `$Downloader.Updates = `$UpdatesToDownload
                    `$Downloader.Download()
                    
                    Send-Log `$jobId "Installing Windows Updates..."
                    `$Installer = `$UpdateSession.CreateUpdateInstaller()
                    `$Installer.Updates = `$UpdatesToDownload
                    `$InstallResult = `$Installer.Install()
                    
                    if (`$InstallResult.RebootRequired) {
                        Send-Log `$jobId "Windows Updates installed. A reboot is required to complete some updates."
                    } else {
                        Send-Log `$jobId "Windows Updates installed successfully."
                    }
                }
            } catch {
                Send-Log `$jobId "Error occurred during Windows Updates: `$(`$_.Exception.Message)"
            }

            # Start WinGet Updates
            Send-Log `$jobId "Locating WinGet executable..."
            `$WingetPath = Get-ChildItem -Path "C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName -Last 1
            
            if (`$WingetPath) {
                Send-Log `$jobId "WinGet found. Running automated upgrade for all applicable packages..."
                `$env:WT_SESSION = `$null
                
                `$wingetOutput = & `$WingetPath upgrade --all --silent --accept-source-agreements --accept-package-agreements --force --include-unknown | Out-String
                Send-Log `$jobId "WinGet Output:`n`$wingetOutput"
                
                Send-Progress `$jobId 80
                `$completedUpdates += "All Winget Apps"
            } else {
                Send-Log `$jobId "WinGet executable not found on this device."
                Send-Progress `$jobId 80
            }

            # Start NodeJS Vulnerability Hunt
            Send-Log `$jobId "Hunting for NodeJS Developer Vulnerabilities (CVEs)..."
            `$SearchPaths = @("C:\Users\*\Documents", "C:\Users\*\Desktop", "C:\Users\*\Downloads", "C:\Users\*\source")
            foreach (`$path in `$SearchPaths) {
                if (Test-Path `$path) {
                    `$projects = Get-ChildItem -Path `$path -Directory -Recurse -ErrorAction SilentlyContinue | Where-Object { `$_.FullName -notmatch "node_modules" -and (Test-Path "`$(`$_.FullName)\package.json") }
                    foreach (`$project in `$projects) {
                        `$projectDir = `$project.FullName
                        try {
                            Send-Log `$jobId "Patching NPM vulnerabilities in `$projectDir"
                            Set-Location -Path `$projectDir
                            `$null = npm audit fix --force 2>&1
                        } catch {}
                    }
                }
            }
            Send-Log `$jobId "NodeJS Vulnerability Hunt Complete."
            
            # Start Microsoft Office Updates (Click-To-Run)
            Send-Log `$jobId "Checking for Microsoft Office updates..."
            `$OfficeUpdater = "C:\Program Files\Common Files\microsoft shared\ClickToRun\OfficeC2RClient.exe"
            if (Test-Path `$OfficeUpdater) {
                Send-Log `$jobId "Forcing MS Office Click-To-Run update sequence..."
                try {
                    Start-Process -FilePath `$OfficeUpdater -ArgumentList "/update user updatepromptuser=False forceappshutdown=True displaylevel=False" -Wait -WindowStyle Hidden
                    Send-Log `$jobId "MS Office update sequence completed."
                } catch {
                    Send-Log `$jobId "Failed to trigger MS Office updates."
                }
            }

            # Start Browser Silent Updates (Chrome & Edge)
            Send-Log `$jobId "Triggering background updaters for Google Chrome and Microsoft Edge..."
            `$ChromeUpdater = "C:\Program Files (x86)\Google\Update\GoogleUpdate.exe"
            `$EdgeUpdater = "C:\Program Files (x86)\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe"
            
            if (Test-Path `$ChromeUpdater) {
                try { Start-Process -FilePath `$ChromeUpdater -ArgumentList "/ua /installsource scheduler" -Wait -WindowStyle Hidden } catch {}
            }
            if (Test-Path `$EdgeUpdater) {
                try { Start-Process -FilePath `$EdgeUpdater -ArgumentList "/ua /installsource scheduler" -Wait -WindowStyle Hidden } catch {}
            }
            Send-Log `$jobId "Browser update sequences triggered."

            # Ghost/Abandoned AppData Installation Hunter
            Send-Log `$jobId "Hunting for Ghost/Abandoned browser installations in User folders..."
            `$UserPaths = Get-ChildItem -Path "C:\Users" -Directory -ErrorAction SilentlyContinue
            foreach (`$user in `$UserPaths) {
                `$chromePath = "`$(`$user.FullName)\AppData\Local\Google\Chrome\Application\chrome.exe"
                `$chromeUpdater = "`$(`$user.FullName)\AppData\Local\Google\Update\GoogleUpdate.exe"
                if (Test-Path `$chromePath) {
                    if (Test-Path `$chromeUpdater) {
                        try { Start-Process -FilePath `$chromeUpdater -ArgumentList "/ua /installsource scheduler" -Wait -WindowStyle Hidden } catch {}
                    } else {
                        Rename-Item -Path `$chromePath -NewName "chrome_abandoned.exe.bak" -Force -ErrorAction SilentlyContinue
                    }
                }

                `$edgePath = "`$(`$user.FullName)\AppData\Local\Microsoft\Edge\Application\msedge.exe"
                `$edgeUpdater = "`$(`$user.FullName)\AppData\Local\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe"
                if (Test-Path `$edgePath) {
                    if (Test-Path `$edgeUpdater) {
                        try { Start-Process -FilePath `$edgeUpdater -ArgumentList "/ua /installsource scheduler" -Wait -WindowStyle Hidden } catch {}
                    } else {
                        Rename-Item -Path `$edgePath -NewName "msedge_abandoned.exe.bak" -Force -ErrorAction SilentlyContinue
                    }
                }
            }
            Send-Log `$jobId "Ghost hunter complete."

            Send-Progress `$jobId 100

            # Report completion
            Send-Log `$jobId "Job finished."
            `$statusBody = @{
                status = 'completed'
                completedUpdates = `$completedUpdates
            } | ConvertTo-Json
            Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/status" -Method Post -Body `$statusBody -ContentType "application/json"
        }
        
        if (`$command -eq 'Restart-Device') {
            `$customMessage = `$jobResponse.job.message
            if (-not `$customMessage) { `$customMessage = "Your device will restart in 5 minutes to save your work." }
            
            Send-Log `$jobId "Job started on `$Hostname."
            Send-Log `$jobId "Initiating graceful device restart in 5 minutes with message: '$customMessage'"
            Send-Progress `$jobId 100
            
            # Report completion immediately before it runs shutdown
            Send-Log `$jobId "Job finished."
            `$statusBody = @{ status = 'completed' } | ConvertTo-Json
            Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/status" -Method Post -Body `$statusBody -ContentType "application/json"
            
            & shutdown.exe /r /t 300 /c `$customMessage
        }

        if (`$command -eq 'Run-Script') {
            Send-Log `$jobId "Job started on `$Hostname."
            `$scriptBody = `$jobResponse.job.message
            if ([string]::IsNullOrWhiteSpace(`$scriptBody)) {
                Send-Log `$jobId "Run-Script received empty body, skipping."
                Send-Progress `$jobId 100
            } else {
                Send-Log `$jobId "Executing Custom Script..."
                Send-Progress `$jobId 50
                try {
                    `$scriptBlock = [ScriptBlock]::Create(`$scriptBody)
                    `$output = & `$scriptBlock *>&1 | Out-String
                    Send-Log `$jobId "Script Output:`n`$output"
                    Send-Progress `$jobId 100
                } catch {
                    Send-Log `$jobId "Script Execution Failed: `$(`$_.Exception.Message)"
                }
            }
            
            Send-Log `$jobId "Job finished."
            `$statusBody = @{ status = 'completed' } | ConvertTo-Json
            Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/status" -Method Post -Body `$statusBody -ContentType "application/json"
        }

        if (`$command -eq 'Update-Agent') {
            Send-Log `$jobId "Job started on `$Hostname. Commencing OTA Agent Update..."
            Send-Progress `$jobId 10
            `$UpdateUrl = "`$ServerUrl/api/agent/installer"
            `$TempScript = "`$env:TEMP\Update-EndpointAgent.ps1"
            
            try {
                Send-Log `$jobId "Downloading latest agent from `$UpdateUrl"
                Invoke-WebRequest -Uri `$UpdateUrl -OutFile `$TempScript -UseBasicParsing
                Send-Progress `$jobId 50
                
                Send-Log `$jobId "Applying new agent logic..."
                `$output = & powershell.exe -ExecutionPolicy Bypass -File `$TempScript *>&1 | Out-String
                Send-Log `$jobId "Update applied successfully.`n`$output"
                Send-Progress `$jobId 100
                
                `$statusBody = @{ status = 'completed' } | ConvertTo-Json
                Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/status" -Method Post -Body `$statusBody -ContentType "application/json"
                
                # Exit gracefully to let the new Scheduled Task run next minute
                exit
            } catch {
                Send-Log `$jobId "Failed to update agent: `$(`$_.Exception.Message)"
                `$statusBody = @{ status = 'failed' } | ConvertTo-Json
                Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/status" -Method Post -Body `$statusBody -ContentType "application/json"
            }
        }

        if (`$command -eq 'Scan-Updates') {
            Send-Log `$jobId "Job started on `$Hostname. Commencing deep scan..."
            `$detailedUpdates = @()

            # 1. COM Object Scan
            Send-Log `$jobId "Initiating deep Windows Update scan via COM Object (Microsoft.Update.Session). This will take several minutes..."
            Send-Progress `$jobId 10
            
            try {
                `$UpdateSession = New-Object -ComObject Microsoft.Update.Session
                `$UpdateSearcher = `$UpdateSession.CreateUpdateSearcher()
                # Perform standard driver/OS searches using the system's default update server
                `$SearchResult1 = `$UpdateSearcher.Search("IsInstalled=0 and IsHidden=0")
                `$SearchResult2 = `$UpdateSearcher.Search("IsInstalled=0 and IsHidden=0 and Type='Driver'")
                
                if ((`$SearchResult1.Updates.Count + `$SearchResult2.Updates.Count) -gt 0) {
                    foreach (`$Update in `$SearchResult1.Updates) {
                        `$detailedUpdates += "[OS] `$(`$Update.Title)"
                    }
                    foreach (`$Update in `$SearchResult2.Updates) {
                        `$detailedUpdates += "[Driver] `$(`$Update.Title)"
                    }
                    Send-Log `$jobId "Found `$(`$SearchResult1.Updates.Count + `$SearchResult2.Updates.Count) missing vulnerabilities/drivers."
                } else {
                    Send-Log `$jobId "No missing vulnerabilities or drivers found."
                }
            } catch {
                Send-Log `$jobId "Error occurred during COM Object scan: `$(`$_.Exception.Message)"
            }
            Send-Progress `$jobId 60
            
            # 2. WinGet Scan
            Send-Log `$jobId "Scanning for 3rd-party application updates via WinGet..."
            `$WingetPath = Get-ChildItem -Path "C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName -Last 1
            if (`$WingetPath) {
                `$env:WT_SESSION = `$null
                `$Upgrades = & `$WingetPath upgrade --accept-source-agreements | Out-String
                `$lines = `$Upgrades -split "``n"
                
                `$skipLines = `$true
                `$appCount = 0
                foreach (`$line in `$lines) {
                    if (`$line -match "^----") { `$skipLines = `$false; continue }
                    if (`$skipLines) { continue }
                    
                    `$cols = `$line -split '\s{2,}'
                    if (`$cols.Count -ge 3) {
                        `$id = `$cols[1]
                        if (`$id) {
                            `$detailedUpdates += "[App] `$id"
                            `$appCount++
                        }
                    }
                }
                Send-Log `$jobId "Found `$appCount application updates."
            }
            
            Send-Progress `$jobId 100
            Send-Log `$jobId "Deep scan finished."
            
            `$statusBody = @{
                status = 'completed'
                detailedUpdates = `$detailedUpdates
            } | ConvertTo-Json
            Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/status" -Method Post -Body `$statusBody -ContentType "application/json"
        }
    }
} catch {
    Write-Warning "Failed to fetch or execute jobs"
}
"@

Set-Content -Path $AgentScriptPath -Value $AgentPayload -Encoding UTF8

# 3. Create Scheduled Task
$TaskName = "EndpointManagementAgent"
$TaskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$AgentScriptPath`""
$TaskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$TaskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Unregister if it already exists
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Register the new task
Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $TaskTrigger -Principal $TaskPrincipal -Description "Endpoint Management Agent Check-in"

Write-Output "Endpoint Agent successfully installed and scheduled to run every 1 minute."
