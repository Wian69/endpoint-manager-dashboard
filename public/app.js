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
        
        // Build tags HTML
        let tagsHtml = '';
        if (totalPending > 0) {
            if (device.pending_windows_updates > 0) tagsHtml += `<span class="tag">${device.pending_windows_updates} OS Updates</span>`;
            if (device.pending_app_updates > 0) tagsHtml += `<span class="tag">${device.pending_app_updates} App Updates</span>`;
        } else {
            tagsHtml = `<span class="tag safe">Up to Date</span>`;
        }
        
        if (device.reboot_required) {
            tagsHtml += `<span class="tag" style="background-color: var(--warning-color); color: #000;">Reboot Pending</span>`;
        }

        // App list details
        let appsListHtml = '';
        if (device.update_list && device.update_list.length > 0) {
            const apps = device.update_list.slice(0, 3).join(', ');
            const more = device.update_list.length > 3 ? ` +${device.update_list.length - 3} more` : '';
            appsListHtml = `<p><strong>Pending Apps:</strong> ${apps}${more}</p>`;
        }

        // Completed updates list
        let completedHtml = '';
        if (device.completed_updates && device.completed_updates.length > 0) {
            const completed = device.completed_updates.join(', ');
            const timeStr = new Date(device.last_update_run).toLocaleTimeString();
            completedHtml = `<div class="completed-updates" style="margin-top:0.5rem; padding: 0.5rem; background:rgba(16,185,129,0.1); border-left:3px solid var(--success-color); border-radius:4px;">
                <p style="margin:0; font-size:0.85rem;"><strong>✓ Completed at ${timeStr}:</strong></p>
                <p style="margin:0; font-size:0.85rem; color:var(--text-secondary);">${completed}</p>
            </div>`;
        }

        // Detailed Scan Results
        let detailedScanHtml = '';
        if (device.detailed_updates && device.detailed_updates.length > 0) {
            const listItems = device.detailed_updates.map(u => `<li style="font-size:0.85rem; color:var(--text-secondary); margin-bottom: 0.25rem;">${escapeHtml(u)}</li>`).join('');
            detailedScanHtml = `<div class="detailed-scan" style="margin-top:0.75rem; padding: 0.5rem; background:rgba(255,255,255,0.03); border:1px solid var(--glass-border); border-radius:4px;">
                <p style="margin:0 0 0.5rem 0; font-size:0.85rem; font-weight:600;">Missing Vulnerabilities & Drivers:</p>
                <ul style="margin:0; padding-left:1rem;">${listItems}</ul>
            </div>`;
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
                    <p><strong>Last Check-in:</strong> ${lastSeen.toLocaleTimeString()}</p>
                    ${appsListHtml}
                    ${detailedScanHtml}
                    ${completedHtml}
                </div>
                <div class="update-tags">
                    ${tagsHtml}
                </div>
            </div>
            <div class="device-actions" style="gap: 1rem;">
                <button class="btn-primary" onclick="openLogs('${escapeHtml(device.hostname)}')">
                    View Logs
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
            </div>
        `;
        
        grid.appendChild(card);
    });
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
}

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
