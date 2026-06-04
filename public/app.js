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
            return `<div style="display: flex; justify-content: space-between; font-size: 0.9rem; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px;">
                <span style="color: ${color}; font-weight: 600;">${escapeHtml(cve.id)}</span>
                <span style="color: var(--text-secondary); text-align:right;">${escapeHtml(cve.app)}</span>
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
