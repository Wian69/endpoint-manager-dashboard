document.addEventListener('DOMContentLoaded', () => {
    // Initial load
    loadSettings();
    refreshDevices();
    // Auto-refresh every 10 seconds
    setInterval(refreshDevices, 10000);
});

async function refreshDevices() {
    try {
        const response = await fetch('/api/devices');
        const devices = await response.json();
        window.globalDevices = devices; // Store globally for modal access
        renderDevices(devices);
        updateStats(devices);
    } catch (error) {
        console.error('Failed to fetch devices:', error);
        document.getElementById('devices-grid').innerHTML = '<div class="loading-spinner">Error loading devices. Ensure server is running.</div>';
    }
}

function updateStats(devices) {
    document.getElementById('total-devices').textContent = devices.length;
    
    const totalUpdates = devices.reduce((sum, d) => sum + (d.pending_windows_updates || 0) + (d.pending_app_updates || 0), 0);
    document.getElementById('total-updates').textContent = totalUpdates;
}

function renderDevices(devices) {
    const grid = document.getElementById('devices-grid');
    
    if (devices.length === 0) {
        grid.innerHTML = '<div class="loading-spinner">No devices connected yet. Deploy the Intune Agent to get started.</div>';
        return;
    }

    grid.innerHTML = '';

    devices.forEach(device => {
        const totalPending = (device.pending_windows_updates || 0) + (device.pending_app_updates || 0);
        
        // Check if device was seen in the last 3 minutes (180000 ms)
        const lastSeen = new Date(device.last_seen);
        const isOnline = (new Date() - lastSeen) < 180000;
        
        const card = document.createElement('div');
        card.className = 'device-card glass-card';
        card.onclick = () => openDeviceModal(device.hostname);
        
        // Build tags HTML
        let tagsHtml = '';
        if (totalPending > 0) {
            if (device.pending_windows_updates > 0) tagsHtml += `<span class="tag">${device.pending_windows_updates} OS Updates</span>`;
            if (device.pending_app_updates > 0) tagsHtml += `<span class="tag">${device.pending_app_updates} App Updates</span>`;
        } else if (!device.azure_cves || device.azure_cves.length === 0) {
            tagsHtml = `<span class="tag safe">Up to Date</span>`;
        }
        
        if (device.azure_cves && device.azure_cves.length > 0) {
            const criticalCount = device.azure_cves.filter(c => c.severity === 'Critical').length;
            tagsHtml += `<span class="tag" style="background-color: rgba(239, 68, 68, 0.2); color: #ef4444; border-color: #ef4444;">${device.azure_cves.length} Vuln(s) (${criticalCount} Critical)</span>`;
        }

        if (device.reboot_required) {
            tagsHtml += `<span class="tag" style="background-color: var(--warning-color); color: #000;">Reboot Pending</span>`;
        }

        card.innerHTML = `
            <div>
                <div class="device-header">
                    <h3>
                        <div class="status-dot ${isOnline ? '' : 'offline'}" title="${isOnline ? 'Online' : 'Offline'}"></div>
                        ${escapeHtml(device.hostname)}
                    </h3>
                </div>
                <div class="device-info">
                    <p><strong>OS:</strong> ${escapeHtml(device.os_version)}</p>
                    <p><strong>Agent:</strong> v${escapeHtml(device.agent_version || '1.0')}</p>
                    <p><strong>Last Check-in:</strong> ${lastSeen.toLocaleTimeString()}</p>
                </div>
                <div class="update-tags">
                    ${tagsHtml}
                </div>
            </div>
            <div style="margin-top: 10px; font-size: 0.85rem; color: var(--primary-color); text-align: center;">
                Click to view details & actions
            </div>
        `;
        
        grid.appendChild(card);
    });
}

function openDeviceModal(hostname) {
    const device = window.globalDevices.find(d => d.hostname === hostname);
    if (!device) return;

    document.getElementById('modalDeviceName').textContent = device.hostname;
    const body = document.getElementById('modalDeviceBody');
    const actions = document.getElementById('modalDeviceActions');
    
    const totalPending = (device.pending_windows_updates || 0) + (device.pending_app_updates || 0);

    // Build Detailed Body HTML
    let bodyHtml = '';

    // App list details
    if (device.update_list && device.update_list.length > 0) {
        bodyHtml += `<div style="margin-bottom: 1rem;">
            <h4 style="margin-bottom: 0.5rem; color: var(--primary-color);">Pending App Updates</h4>
            <ul style="padding-left: 1rem; color: var(--text-secondary); font-size: 0.9rem;">
                ${device.update_list.map(u => `<li>${escapeHtml(u)}</li>`).join('')}
            </ul>
        </div>`;
    }

    // Detailed Scan Results
    if (device.detailed_updates && device.detailed_updates.length > 0) {
        bodyHtml += `<div style="margin-bottom: 1rem; padding: 1rem; background:rgba(255,255,255,0.03); border:1px solid var(--glass-border); border-radius:4px;">
            <h4 style="margin-bottom: 0.5rem;">Missing Agent Updates</h4>
            <ul style="padding-left: 1rem; color: var(--text-secondary); font-size: 0.9rem;">
                ${device.detailed_updates.map(u => `<li style="margin-bottom: 0.25rem;">${escapeHtml(u)}</li>`).join('')}
            </ul>
        </div>`;
    }

    // Azure CVE Results
    if (device.azure_cves && device.azure_cves.length > 0) {
        const cveItems = device.azure_cves.map(cve => {
            const color = cve.severity === 'Critical' ? '#ef4444' : (cve.severity === 'High' ? '#f97316' : 'var(--text-secondary)');
            return `
            <div class="cve-accordion" onclick="this.classList.toggle('open')">
                <div class="cve-accordion-header">
                    <span style="color: ${color}; font-weight: 600;">${escapeHtml(cve.id)}</span>
                    <span style="color: var(--text-secondary); font-size: 0.8rem;">Click for details ▼</span>
                </div>
                <div class="cve-accordion-body">
                    ${escapeHtml(cve.description || 'No description provided.')}
                </div>
            </div>`;
        }).join('');
        
        bodyHtml += `<div style="margin-bottom: 1rem; padding: 1rem; background:rgba(239, 68, 68, 0.05); border:1px solid rgba(239, 68, 68, 0.2); border-radius:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.75rem;">
                <h4 style="margin:0; color: #ef4444;"><span style="margin-right: 5px;">🛡️</span>Defender Vulnerabilities (${device.azure_cves.length})</h4>
            </div>
            ${cveItems}
        </div>`;
    }

    // Completed Updates
    if (device.completed_updates && device.completed_updates.length > 0) {
        const timeStr = new Date(device.last_update_run).toLocaleTimeString();
        bodyHtml += `<div style="margin-top: 1rem; padding: 1rem; background:rgba(16,185,129,0.1); border-left:3px solid var(--success-color); border-radius:4px;">
            <h4 style="margin:0 0 0.5rem 0; font-size:0.9rem; color: var(--success-color);">✓ Completed at ${timeStr}</h4>
            <p style="margin:0; font-size:0.9rem; color:var(--text-secondary);">${escapeHtml(device.completed_updates.join(', '))}</p>
        </div>`;
    }

    if (bodyHtml === '') {
        bodyHtml = '<p style="text-align:center; color: var(--text-secondary); padding: 2rem;">Device is fully up to date and secure.</p>';
    }

    body.innerHTML = bodyHtml;

    // Action Buttons
    actions.innerHTML = `
        <button class="btn-primary" onclick="openLogs('${escapeHtml(device.hostname)}')" style="margin-right: auto;">
            View Logs
        </button>
        <button class="btn-primary" onclick="openScriptModal('${escapeHtml(device.hostname)}')" style="background-color: #8b5cf6;">
            Deploy Script
        </button>
        <button class="btn-primary" onclick="triggerScan('${escapeHtml(device.hostname)}', this)" style="background-color: #3b82f6;">
            Scan Device
        </button>
        <button class="btn-danger" onclick="triggerUpdate('${escapeHtml(device.hostname)}', this)" ${totalPending === 0 ? 'disabled style="opacity:0.5"' : ''}>
            Force Updates
        </button>
        <button class="btn-danger" style="background-color: var(--warning-color); color: #000;" onclick="triggerRestart('${escapeHtml(device.hostname)}', this)">
            Restart
        </button>
    `;

    document.getElementById('deviceModal').style.display = 'flex';
}

function closeDeviceModal() {
    document.getElementById('deviceModal').style.display = 'none';
}

/* Script Modal Logic */
let currentScriptHostname = null;

function openScriptModal(hostname) {
    currentScriptHostname = hostname;
    document.getElementById('scriptModal').style.display = 'flex';
    document.getElementById('scriptBodyInput').value = '';
    
    document.getElementById('executeScriptBtn').onclick = async function() {
        const scriptBody = document.getElementById('scriptBodyInput').value.trim();
        if (!scriptBody) {
            alert('Please enter a script to execute.');
            return;
        }
        
        if (!confirm(`Are you sure you want to deploy this script to ${hostname}? It will run as SYSTEM.`)) return;
        
        const btnElement = this;
        btnElement.textContent = 'Deploying...';
        btnElement.disabled = true;
        
        try {
            const response = await fetch(`/api/devices/${hostname}/trigger`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: 'Run-Script', message: scriptBody })
            });
            
            const result = await response.json();
            if (result.success) {
                btnElement.textContent = 'Script Deployed';
                btnElement.style.background = 'var(--success-color)';
                setTimeout(() => {
                    closeScriptModal();
                    openLogs(hostname);
                }, 1500);
            } else {
                throw new Error('Server returned false');
            }
        } catch (error) {
            console.error('Failed to trigger script:', error);
            btnElement.textContent = 'Error';
            btnElement.disabled = false;
        }
    };
}

function closeScriptModal() {
    document.getElementById('scriptModal').style.display = 'none';
    currentScriptHostname = null;
    const btn = document.getElementById('executeScriptBtn');
    btn.textContent = 'Deploy Script';
    btn.disabled = false;
    btn.style.background = '';
}

function loadScriptTemplate(type) {
    const input = document.getElementById('scriptBodyInput');
    if (type === 'winget') {
        input.value = `$taskName = "UserWingetUpdateAll"
$action = New-ScheduledTaskAction -Execute "winget" -Argument "upgrade --all --silent --force --include-unknown --accept-package-agreements --accept-source-agreements"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)
$principal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\\Users" -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force

Write-Output "Successfully scheduled 'Update All' task for the user session."`;
    } else if (type === 'node') {
        input.value = `Write-Output "Starting NodeJS Vulnerability Hunt..."

# Define the paths to search (Targeting user profiles to avoid scanning the entire C: drive)
$SearchPaths = @("C:\\Users\\*\\Documents", "C:\\Users\\*\\Desktop", "C:\\Users\\*\\Downloads", "C:\\Users\\*\\source")

foreach ($path in $SearchPaths) {
    if (Test-Path $path) {
        Write-Output "Scanning $path for Node.js projects..."
        
        # Find package.json files but skip traversing into node_modules entirely to save time
        $projects = Get-ChildItem -Path $path -Directory -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "node_modules" -and (Test-Path "$($_.FullName)\\package.json") }
        
        foreach ($project in $projects) {
            $projectDir = $project.FullName
            Write-Output "Found Node project at: $projectDir"
            Write-Output "Attempting to force-remediate vulnerabilities..."
            
            # Navigate to the project and force fix vulnerabilities
            Set-Location -Path $projectDir
            try {
                $auditOutput = npm audit fix --force 2>&1 | Out-String
                Write-Output "NPM Output for $projectDir :\`n$auditOutput"
            } catch {
                Write-Output "Failed to run npm audit in $projectDir : $_"
            }
        }
    }
}

Write-Output "NodeJS Vulnerability Hunt Complete."`;
    } else if (type === 'defender') {
        input.value = `Write-Output "Forcing deep Microsoft Defender Vulnerability Sync..."

# Force Defender to update all telemetry and signatures
$MpCmdPath = Get-ChildItem -Path "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\*" -Filter "MpCmdRun.exe" | Select-Object -ExpandProperty FullName -Last 1
if ($MpCmdPath) {
    & $MpCmdPath -SignatureUpdate
    Write-Output "Triggering aggressive system scan to force telemetry upload..."
    Start-Process -FilePath $MpCmdPath -ArgumentList "-Scan -ScanType 1" -WindowStyle Hidden
}

# Force the Windows Update client to re-evaluate the local cache against Microsoft servers
Write-Output "Flushing Windows Update cache and forcing re-evaluation..."
net stop wuauserv
Remove-Item -Path "C:\\Windows\\SoftwareDistribution\\Download\\*" -Recurse -Force -ErrorAction SilentlyContinue
net start wuauserv
wuauclt.exe /updatenow

Write-Output "Sync triggered! Please reboot the device and check the dashboard tomorrow."`;
    } else if (type === 'ghost') {
        input.value = `Write-Output "Hunting for Ghost/Abandoned Google Chrome & Edge installations in User folders..."

$UserPaths = Get-ChildItem -Path "C:\\Users" -Directory -ErrorAction SilentlyContinue

foreach ($user in $UserPaths) {
    # Path to AppData Chrome
    $chromePath = "$($user.FullName)\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"
    $chromeUpdater = "$($user.FullName)\\AppData\\Local\\Google\\Update\\GoogleUpdate.exe"
    
    if (Test-Path $chromePath) {
        Write-Output "WARNING: Found user-level Chrome ghost install for user $($user.Name)!"
        if (Test-Path $chromeUpdater) {
            Write-Output "Attempting to forcefully update user-level Chrome..."
            Start-Process -FilePath $chromeUpdater -ArgumentList "/ua /installsource scheduler" -Wait -WindowStyle Hidden
        } else {
            Write-Output "No updater found. Renaming abandoned chrome.exe to stop Defender vulnerability flags..."
            Rename-Item -Path $chromePath -NewName "chrome_abandoned.exe.bak" -Force -ErrorAction SilentlyContinue
        }
    }

    # Path to AppData Edge
    $edgePath = "$($user.FullName)\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe"
    $edgeUpdater = "$($user.FullName)\\AppData\\Local\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe"
    
    if (Test-Path $edgePath) {
        Write-Output "WARNING: Found user-level Edge ghost install for user $($user.Name)!"
        if (Test-Path $edgeUpdater) {
            Write-Output "Attempting to forcefully update user-level Edge..."
            Start-Process -FilePath $edgeUpdater -ArgumentList "/ua /installsource scheduler" -Wait -WindowStyle Hidden
        } else {
            Write-Output "No updater found. Renaming abandoned msedge.exe to stop Defender vulnerability flags..."
            Rename-Item -Path $edgePath -NewName "msedge_abandoned.exe.bak" -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Output "Ghost hunt complete! If files were updated or renamed, Defender will clear the CVEs within 24 hours."`;
    }
}

async function triggerUpdate(hostname, btnElement) {
    if (!confirm(`Are you sure you want to force updates on ${hostname}?`)) return;
    
    btnElement.classList.add('triggering');
    btnElement.textContent = 'Queuing...';
    
    try {
        const response = await fetch(`/api/devices/${hostname}/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'Force-Updates' })
        });
        
        const result = await response.json();
        if (result.success) {
            btnElement.textContent = 'Job Queued';
            btnElement.style.background = 'var(--success-color)';
        } else {
            throw new Error('Server returned false');
        }
    } catch (error) {
        console.error('Failed to trigger update:', error);
        btnElement.textContent = 'Error';
        btnElement.classList.remove('triggering');
    }
}

async function triggerScan(hostname, btnElement) {
    btnElement.classList.add('triggering');
    btnElement.textContent = 'Queuing Scan...';
    
    try {
        const response = await fetch(`/api/devices/${hostname}/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'Scan-Updates' })
        });
        
        const result = await response.json();
        if (result.success) {
            btnElement.textContent = 'Scan Queued';
            btnElement.style.background = 'var(--success-color)';
            // Give them a heads up
            setTimeout(() => {
                alert(`A deep scan has been queued for ${hostname}. This may take up to 15 minutes to complete. You can view progress in the device logs.`);
            }, 100);
        } else {
            throw new Error('Server returned false');
        }
    } catch (error) {
        console.error('Failed to trigger scan:', error);
        btnElement.textContent = 'Error';
        btnElement.classList.remove('triggering');
    }
}

async function triggerRestart(hostname, btnElement) {
    if (!confirm(`WARNING: This will instantly force a reboot on ${hostname}. Proceed?`)) return;
    
    const customMessage = document.getElementById('restart-msg').value.trim() || "Your device will restart in 5 minutes.";
    
    btnElement.classList.add('triggering');
    btnElement.textContent = 'Queuing...';
    
    try {
        const response = await fetch(`/api/devices/${hostname}/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'Restart-Device', message: customMessage })
        });
        
        const result = await response.json();
        if (result.success) {
            btnElement.textContent = 'Restart Queued';
            btnElement.style.background = 'var(--success-color)';
        } else {
            throw new Error('Server returned false');
        }
    } catch (error) {
        console.error('Failed to trigger restart:', error);
        btnElement.textContent = 'Error';
        btnElement.classList.remove('triggering');
    }
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

/* Logging Modal Logic */
let currentLogHostname = null;
let logRefreshInterval = null;

async function openLogs(hostname) {
    currentLogHostname = hostname;
    document.getElementById('logs-modal').style.display = 'block';
    document.getElementById('modal-title').textContent = `Logs: ${hostname}`;
    document.getElementById('terminal-output').innerHTML = 'Fetching logs...';
    
    await refreshCurrentLogs();
    
    // Auto refresh logs while modal is open
    logRefreshInterval = setInterval(refreshCurrentLogs, 5000);
}

function closeLogs() {
    document.getElementById('logs-modal').style.display = 'none';
    currentLogHostname = null;
    if (logRefreshInterval) clearInterval(logRefreshInterval);
}

function closeModalOnOutsideClick(event) {
    if (event.target === document.getElementById('logs-modal')) {
        closeLogs();
    }
    if (event.target === document.getElementById('deviceModal')) {
        closeDeviceModal();
    }
    if (event.target === document.getElementById('scriptModal')) {
        closeScriptModal();
    }
}

// Ensure click outside works for both modals
window.onclick = closeModalOnOutsideClick;

function saveSettings() {
    const msg = document.getElementById('restart-msg').value;
    localStorage.setItem('restartMsg', msg);
}

function loadSettings() {
    const savedMsg = localStorage.getItem('restartMsg');
    if (savedMsg) {
        document.getElementById('restart-msg').value = savedMsg;
    }
}

async function refreshCurrentLogs() {
    if (!currentLogHostname) return;
    
    try {
        const response = await fetch(`/api/devices/${currentLogHostname}/logs`);
        const data = await response.json();
        
        const terminal = document.getElementById('terminal-output');
        const statusSpan = document.getElementById('modal-status');
        
        statusSpan.textContent = `Job Status: ${data.status}`;
        
        const progressBar = document.getElementById('modal-progress');
        progressBar.style.width = `${data.progress || 0}%`;
        
        if (data.logs.length === 0) {
            terminal.innerHTML = 'No logs available for the most recent job.';
        } else {
            terminal.innerHTML = data.logs.map(log => `<div class="log-line">${escapeHtml(log)}</div>`).join('');
            // Scroll to bottom
            terminal.scrollTop = terminal.scrollHeight;
        }
    } catch (error) {
        console.error('Failed to fetch logs:', error);
    }
}
