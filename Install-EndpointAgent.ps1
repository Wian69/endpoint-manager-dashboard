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
            foreach (`$line in `$lines) {
                if (`$line -match ".*? (?<id>[\w\.\-]+) \s+ [\d\.\w]+ \s+ [\d\.\w]+") {
                    `$appUpdates++
                    `$updateList += `$matches['id']
                }
            }
        }
    } catch {}

    return @{
        windows = `$windowsUpdates
        apps = `$appUpdates
        list = `$updateList
    }
}

# 1. Check-in with server
`$updates = Get-PendingUpdates
`$checkinBody = @{
    hostname = `$Hostname
    osVersion = `$OSVersion
    pendingWindowsUpdates = `$updates.windows
    pendingAppUpdates = `$updates.apps
    updateList = `$updates.list
} | ConvertTo-Json

try {
    Invoke-RestMethod -Uri "`$ServerUrl/api/agent/checkin" -Method Post -Body `$checkinBody -ContentType "application/json" -TimeoutSec 10
} catch {
    Write-Warning "Failed to check in with server"
}

# 2. Check for jobs
try {
    `$jobResponse = Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$Hostname" -Method Get -TimeoutSec 10
    if (`$jobResponse.job) {
        `$jobId = `$jobResponse.job.id
        `$command = `$jobResponse.job.command

        if (`$command -eq 'Force-Updates') {
            # EXECUTING THE UPDATE LOGIC
            # Start Windows Updates
            Start-Process -FilePath "UsoClient.exe" -ArgumentList "StartScan" -Wait -NoNewWindow
            Start-Sleep -Seconds 5
            Start-Process -FilePath "UsoClient.exe" -ArgumentList "StartInstall" -Wait -NoNewWindow

            # Start WinGet Updates
            `$WingetPath = Get-ChildItem -Path "C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName -Last 1
            if (`$WingetPath) {
                `$env:WT_SESSION = `$null
                & `$WingetPath upgrade --all --silent --accept-source-agreements --accept-package-agreements --force
            }

            # Report completion
            Invoke-RestMethod -Uri "`$ServerUrl/api/agent/jobs/`$jobId/status" -Method Post -Body (@{status='completed'} | ConvertTo-Json) -ContentType "application/json"
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
$TaskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$TaskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Unregister if it already exists
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Register the new task
Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $TaskTrigger -Principal $TaskPrincipal -Description "Endpoint Management Agent Check-in"

Write-Output "Endpoint Agent successfully installed and scheduled to run every 5 minutes."
