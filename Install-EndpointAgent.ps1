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

# Function to get pending updates
function Get-PendingUpdates {
    `$windowsUpdates = 0
    `$appUpdates = 0
    `$updateList = @()

    # Very basic check for demonstration. In production, use COM object for exact count.
    # For WinGet:
    try {
        `$WingetPath = Get-ChildItem -Path "C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName -Last 1
        if (`$WingetPath) {
            `$env:WT_SESSION = `$null
            `$Upgrades = & `$WingetPath upgrade | Out-String
            `$lines = `$Upgrades -split "``n"
            `$skipLines = `$true
            foreach (`$line in `$lines) {
                if (`$line -match "^----") { `$skipLines = `$false; continue }
                if (`$skipLines) { continue }
                
                `$cols = `$line -split '\s{2,}'
                if (`$cols.Count -ge 3) {
                    `$id = `$cols[1]
                    if (`$id) {
                        `$appUpdates++
                        `$updateList += `$id
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
    `$checkinBody = @{
    hostname = `$Hostname
    osVersion = `$OSVersion
    pendingWindowsUpdates = `$updates.windows
    pendingAppUpdates = `$updates.apps
    updateList = `$updates.list
    rebootRequired = `$updates.rebootRequired
} | ConvertTo-Json

try {
    Invoke-RestMethod -Uri "`$ServerUrl/api/agent/checkin" -Method Post -Body `$checkinBody -ContentType "application/json" -TimeoutSec 10
} catch {
    Write-Warning "Failed to check in with server"
}

# Function to send logs to the server
function Send-Log (`$jobId, `$message) {
    `$logBody = @{ log = `$message } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/log" -Method Post -Body `$logBody -ContentType "application/json" -TimeoutSec 5
    } catch {}
}

# Function to send progress to the server
function Send-Progress (`$jobId, `$progress) {
    `$progBody = @{ progress = `$progress } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/progress" -Method Post -Body `$progBody -ContentType "application/json" -TimeoutSec 5
    } catch {}
}

# 2. Check for jobs
try {
    `$jobResponse = Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$Hostname" -Method Get -TimeoutSec 10
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
                
                # Register Microsoft Update Service to ensure drivers and optional extensions are included
                try {
                    `$UpdateSvc = New-Object -ComObject Microsoft.Update.ServiceManager
                    `$UpdateSvc.AddService2("7971f918-a847-4430-9279-4a52d1efe18d", 7, "") | Out-Null
                    `$UpdateSearcher.ServerSelection = 3
                    `$UpdateSearcher.ServiceID = "7971f918-a847-4430-9279-4a52d1efe18d"
                } catch {}
                
                Send-Log `$jobId "Searching for all available Windows Updates (including drivers and optional extensions)..."
                `$SearchResult = `$UpdateSearcher.Search("IsInstalled=0 and IsHidden=0 and (Type='Software' or Type='Driver')")
                
                `$winUpdatesCount = `$SearchResult.Updates.Count
                Send-Log `$jobId "Found `$winUpdatesCount pending Windows Update(s)."
                
                if (`$winUpdatesCount -gt 0) {
                    `$UpdatesToDownload = New-Object -ComObject Microsoft.Update.UpdateColl
                    foreach (`$Update in `$SearchResult.Updates) {
                        `$UpdatesToDownload.Add(`$Update) | Out-Null
                        Send-Log `$jobId "Queued for download/install: `$(`$Update.Title)"
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
                Send-Log `$jobId "WinGet found. Scanning for available upgrades..."
                `$env:WT_SESSION = `$null
                `$Upgrades = & `$WingetPath upgrade | Out-String
                `$lines = `$Upgrades -split "``n"
                
                `$appIdsToUpdate = @()
                `$skipLines = `$true
                foreach (`$line in `$lines) {
                    if (`$line -match "^----") { `$skipLines = `$false; continue }
                    if (`$skipLines) { continue }
                    
                    `$cols = `$line -split '\s{2,}'
                    if (`$cols.Count -ge 3) {
                        `$id = `$cols[1]
                        if (`$id) {
                            `$appIdsToUpdate += `$id
                        }
                    }
                }
                
                `$completedUpdates = @()
                `$totalApps = `$appIdsToUpdate.Count
                if (`$totalApps -gt 0) {
                    Send-Log `$jobId "Found `$totalApps applications to upgrade."
                    `$currentApp = 0
                    
                    foreach (`$appId in `$appIdsToUpdate) {
                        `$currentApp++
                        `$percentage = [math]::Round((`$currentApp / `$totalApps) * 100)
                        
                        Send-Log `$jobId "Upgrading `$appId (App `$currentApp of `$totalApps) - `$percentage% Complete"
                        Send-Progress `$jobId `$percentage
                        
                        `$wingetOutput = & `$WingetPath upgrade --id `"`$appId`" --exact --silent --accept-source-agreements --accept-package-agreements --force --include-unknown | Out-String
                        Send-Log `$jobId "Output for `$appId :`n`$wingetOutput"
                        
                        `$completedUpdates += `$appId
                    }
                } else {
                    Send-Log `$jobId "No third-party applications require upgrading."
                    Send-Progress `$jobId 100
                }
            } else {
                Send-Log `$jobId "WinGet executable not found on this device."
                Send-Progress `$jobId 100
            }

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
