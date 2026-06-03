document.addEventListener('DOMContentLoaded', () => {
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
        
        // Check if device was seen in the last 15 minutes (900000 ms)
        const lastSeen = new Date(device.last_seen);
        const isOnline = (new Date() - lastSeen) < 900000;
        
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

        // App list details
        let appsListHtml = '';
        if (device.update_list && device.update_list.length > 0) {
            const apps = device.update_list.slice(0, 3).join(', ');
            const more = device.update_list.length > 3 ? ` +${device.update_list.length - 3} more` : '';
            appsListHtml = `<p><strong>Pending Apps:</strong> ${apps}${more}</p>`;
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
                </div>
                <div class="update-tags">
                    ${tagsHtml}
                </div>
            </div>
            <div class="device-actions">
                <button class="btn-danger" onclick="triggerUpdate('${escapeHtml(device.hostname)}', this)" ${totalPending === 0 ? 'disabled style="opacity:0.5"' : ''}>
                    Force Updates
                </button>
            </div>
        `;
        
        grid.appendChild(card);
    });
}

async function triggerUpdate(hostname, btnElement) {
    if (!confirm(\`Are you sure you want to force updates on \${hostname}?\`)) return;
    
    btnElement.classList.add('triggering');
    btnElement.textContent = 'Queuing...';
    
    try {
        const response = await fetch(\`/api/devices/\${hostname}/trigger\`, {
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

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}
