require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// IN-MEMORY DATABASE (Replaces SQLite)
// ==========================================
// Since this is a lightweight dashboard, we don't need a heavy native database like SQLite.
// Memory objects are perfect and avoid GLIBC deployment errors on services like Render.

const devicesDB = new Map(); // Key: hostname, Value: device object
const jobsDB = []; // Array of job objects
let nextJobId = 1;

const TARGET_AGENT_VERSION = "2.1";

const azureCache = new Map(); // Key: hostname, Value: array of CVEs

// ==========================================
// AZURE / DEFENDER VULNERABILITY SYNC
// ==========================================

async function syncAzureVulnerabilities() {
    const tenantId = process.env.AZURE_TENANT_ID;
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
        console.log('[Azure Sync] Missing Azure credentials in .env file. Skipping real API sync and using mock data for testing.');
        // Populate mock cache
        azureCache.set('EQNCSLT016', [
            { id: 'CVE-2023-49210', severity: 'Critical', app: 'Openssl 1.1.1.0', description: 'Vulnerability in OpenSSL' },
            { id: 'CVE-2026-44574', severity: 'High', app: 'Next 15.4.10.0', description: 'Next.js rendering vulnerability' },
            { id: 'CVE-2026-42033', severity: 'High', app: 'Axios 1.13.5.0', description: 'Axios request manipulation vulnerability' },
            { id: 'CVE-2025-54135', severity: 'High', app: 'Anysphere Cursor 0.50.5.0', description: 'Cursor local execution vulnerability' }
        ]);
        return;
    }

    try {
        console.log('[Azure Sync] Authenticating with Azure AD...');
        // 1. Get Access Token
        const tokenResponse = await axios.post(
            `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
            new URLSearchParams({
                client_id: clientId,
                scope: 'https://api.securitycenter.microsoft.com/.default',
                client_secret: clientSecret,
                grant_type: 'client_credentials'
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const accessToken = tokenResponse.data.access_token;
        if (!accessToken) throw new Error('Failed to retrieve access token');

        console.log('[Azure Sync] Fetching machines from Microsoft Defender...');
        // 2. Get Machines
        const machinesRes = await axios.get('https://api.securitycenter.microsoft.com/api/machines', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        for (const machine of machinesRes.data.value) {
            const hostname = machine.computerDnsName ? machine.computerDnsName.split('.')[0].toUpperCase() : null;
            if (!hostname) continue;

            // 3. Get vulnerabilities for this machine
            try {
                const vulnRes = await axios.get(`https://api.securitycenter.microsoft.com/api/machines/${machine.id}/vulnerabilities`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });

                const cves = vulnRes.data.value.map(v => ({
                    id: v.id,
                    severity: v.severity,
                    description: v.description || 'No description provided.',
                    app: 'Vulnerability'
                }));
                
                azureCache.set(hostname, cves);
                console.log(`[Azure Sync] Cached ${cves.length} CVEs for ${hostname}`);
            } catch (err) {
                console.error(`[Azure Sync] Failed to fetch CVEs for ${hostname}`);
            }
        }
    } catch (err) {
        console.error('[Azure Sync] Error syncing vulnerabilities:', err.response ? err.response.data : err.message);
    }
}

// Run sync every 2 minutes
setInterval(syncAzureVulnerabilities, 2 * 60 * 1000);
// Run initial sync 5 seconds after startup
setTimeout(syncAzureVulnerabilities, 5000);

// ==========================================
// AGENT ROUTES (Called by the endpoints)
// ==========================================

// Serve the installer file for OTA updates
app.get('/api/agent/installer', (req, res) => {
    res.sendFile(path.join(__dirname, 'Install-EndpointAgent.ps1'));
});

// Agent Check-in
app.post('/api/agent/checkin', (req, res) => {
    const { hostname, agentVersion, osVersion, networkName, network_name, location, policies, pendingWindowsUpdates, pendingAppUpdates, updateList, rebootRequired } = req.body;
    
    if (!hostname) return res.status(400).json({ error: 'Hostname is required' });

    const now = new Date().toISOString();
    
    // Preserve existing data if any
    const existingDevice = devicesDB.get(hostname);
    const completedUpdates = existingDevice ? existingDevice.completed_updates : [];
    let locationHistory = existingDevice && existingDevice.location_history ? existingDevice.location_history : [];

    // Location history tracking
    let currentLocation = location || 'Unknown';
    
    // If the agent times out trying to lock GPS and sends "Unknown", fallback to the last known good location!
    if (currentLocation === 'Unknown' && locationHistory.length > 0) {
        currentLocation = locationHistory[locationHistory.length - 1].location;
    }

    if (currentLocation !== 'Unknown') {
        const lastEntry = locationHistory.length > 0 ? locationHistory[locationHistory.length - 1] : null;
        const timeSinceLast = lastEntry ? (new Date(now) - new Date(lastEntry.timestamp)) : Infinity;
        const oneHourMs = 60 * 60 * 1000;

        // Only append to history if at least 1 hour has passed since the last log
        if (!lastEntry || timeSinceLast >= oneHourMs) {
            locationHistory.push({
                location: currentLocation,
                timestamp: now
            });
            // Keep only the last 50 locations
            if (locationHistory.length > 50) {
                locationHistory = locationHistory.slice(locationHistory.length - 50);
            }
        }
    }

    // Update or insert device
    devicesDB.set(hostname, {
        hostname,
        agent_version: agentVersion || "1.0",
        os_version: osVersion,
        network_name: network_name || networkName || 'Unknown',
        location: currentLocation,
        location_history: locationHistory,
        policies: policies || [],
        last_seen: now,
        pending_windows_updates: pendingWindowsUpdates,
        pending_app_updates: pendingAppUpdates,
        update_list: updateList || [],
        reboot_required: rebootRequired || false,
        detailed_updates: existingDevice ? existingDevice.detailed_updates : [],
        completed_updates: completedUpdates,
        last_update_run: existingDevice ? existingDevice.last_update_run : null,
        azure_cves: azureCache.get(hostname) || []
    });

    const activeJob = jobsDB.find(j => j.hostname === hostname && (j.status === 'pending' || j.status === 'in_progress'));

    // OTA Update logic: Automatically queue update if agent version is mismatched
    if (!agentVersion || agentVersion !== TARGET_AGENT_VERSION) {
        if (!activeJob) {
            console.log(`[OTA Update] Automatically queueing Update-Agent for ${hostname} (Current: ${agentVersion || '1.0'}, Target: ${TARGET_AGENT_VERSION})`);
            jobsDB.push({
                id: nextJobId++,
                hostname,
                command: 'Update-Agent',
                message: 'Automated OTA update triggered by server policy.',
                status: 'pending',
                logs: [],
                progress: 0,
                created_at: new Date().toISOString()
            });
        }
        return res.json({ success: true }); // Prevent queueing Force-Updates at the same time
    }

    // Auto-patching logic: Automatically queue updates if pending updates are detected
    const totalPending = (pendingWindowsUpdates || 0) + (pendingAppUpdates || 0);
    if (totalPending > 0 && !rebootRequired) {
        // Only queue if there isn't already a pending or running job for this device
        if (!activeJob) {
            console.log(`[Auto-Patch] Automatically queueing Force-Updates for ${hostname} (${totalPending} updates pending)`);
            jobsDB.push({
                id: nextJobId++,
                hostname,
                command: 'Force-Updates',
                message: 'Automated remediation triggered by system policy.',
                status: 'pending',
                logs: [],
                progress: 0,
                created_at: new Date().toISOString()
            });
        }
    }

    res.json({ success: true });
});

// Agent fetch pending jobs
app.get('/api/agent/jobs/:hostname', (req, res) => {
    const hostname = req.params.hostname;
    
    // Find the oldest pending job for this hostname
    const job = jobsDB.find(j => j.hostname === hostname && j.status === 'pending');
    
    if (!job) {
        return res.json({ job: null });
    }
    
    // Mark as in-progress immediately so concurrent polls don't pick up the same job
    job.status = 'in_progress';
    
    res.json({ job });
});

// Agent Report Job Status
app.post('/api/agent/jobs/:jobId/status', (req, res) => {
    const jobId = parseInt(req.params.jobId, 10);
    const { status, completedUpdates, detailedUpdates } = req.body;
    
    const job = jobsDB.find(j => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    job.status = status;
    
    // Update the device profile if there's new data
    const device = devicesDB.get(job.hostname);
    if (device) {
        if (completedUpdates && Array.isArray(completedUpdates)) {
            device.completed_updates = [...new Set([...(device.completed_updates || []), ...completedUpdates])];
        }
        if (detailedUpdates && Array.isArray(detailedUpdates)) {
            device.detailed_updates = detailedUpdates;
            // Also sync the dashboard counts to reflect the deep scan
            let osCount = 0;
            let appCount = 0;
            detailedUpdates.forEach(update => {
                if (update.startsWith('[App]')) appCount++;
                if (update.startsWith('[OS]') || update.startsWith('[Driver]')) osCount++;
            });
            device.pending_windows_updates = osCount;
            device.pending_app_updates = appCount;
        }
        device.last_update_run = new Date().toISOString();
        devicesDB.set(job.hostname, device);
    }
    
    res.json({ success: true });
});

// Agent post log
app.post('/api/agent/jobs/:jobId/log', (req, res) => {
    const jobId = parseInt(req.params.jobId);
    const { log } = req.body;
    
    const job = jobsDB.find(j => j.id === jobId);
    if (job) {
        job.logs.push(`[${new Date().toLocaleTimeString()}] ${log}`);
        const device = devicesDB.get(job.hostname);
        if (device) device.last_seen = new Date().toISOString();
    }
    res.json({ success: true });
});

// Agent post progress
app.post('/api/agent/jobs/:jobId/progress', (req, res) => {
    const jobId = parseInt(req.params.jobId);
    const { progress } = req.body;
    
    const job = jobsDB.find(j => j.id === jobId);
    if (job) {
        job.progress = parseInt(progress) || 0;
        const device = devicesDB.get(job.hostname);
        if (device) device.last_seen = new Date().toISOString();
    }
    res.json({ success: true });
});

// ==========================================
// DASHBOARD ROUTES (Called by the web UI)
// ==========================================

// List all devices
app.get('/api/devices', (req, res) => {
    // Convert Map to array and sort alphabetically by hostname so they stay in one place
    const devicesArray = Array.from(devicesDB.values()).map(device => {
        // Merge the Azure Cache into the device payload
        const upperHost = device.hostname.toUpperCase();
        device.azure_cves = azureCache.get(upperHost) || [];
        return device;
    }).sort((a, b) => {
        return a.hostname.localeCompare(b.hostname);
    });
    
    res.json(devicesArray);
});

// Delete a device from the dashboard
app.delete('/api/devices/:hostname', (req, res) => {
    const hostname = req.params.hostname;
    if (devicesDB.has(hostname)) {
        devicesDB.delete(hostname);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Device not found' });
    }
});

// Queue an update command for a device
app.post('/api/devices/:hostname/trigger', (req, res) => {
    const hostname = req.params.hostname;
    const { command, message } = req.body; // e.g., 'Force-Updates'
    
    const newJob = {
        id: nextJobId++,
        hostname,
        command,
        message,
        status: 'pending',
        logs: [],
        progress: 0,
        created_at: new Date().toISOString()
    };
    
    jobsDB.push(newJob);
    
    res.json({ success: true, jobId: newJob.id });
});

// Fetch logs for a specific device's latest job
app.get('/api/devices/:hostname/logs', (req, res) => {
    const hostname = req.params.hostname;
    // Get the most recently created job for this hostname
    const job = jobsDB.slice().reverse().find(j => j.hostname === hostname);
    
    if (!job) {
        return res.json({ logs: [], status: 'No jobs found', progress: 0 });
    }
    
    res.json({ logs: job.logs, status: job.status, progress: job.progress });
});

app.listen(PORT, () => {
    console.log(`Endpoint Management Server running on port ${PORT}`);
});
