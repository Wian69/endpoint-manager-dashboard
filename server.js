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

// ==========================================
// AZURE / DEFENDER VULNERABILITY SYNC
// ==========================================

async function syncAzureVulnerabilities() {
    const tenantId = process.env.AZURE_TENANT_ID;
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
        console.log('[Azure Sync] Missing Azure credentials in .env file. Skipping real API sync and using mock data for testing.');
        // For testing, just populate dummy data for any connected device
        devicesDB.forEach((device) => {
            device.azure_cves = [
                { id: 'CVE-2023-49210', severity: 'Critical', app: 'Openssl 1.1.1.0' },
                { id: 'CVE-2026-44574', severity: 'High', app: 'Next 15.4.10.0' },
                { id: 'CVE-2026-42033', severity: 'High', app: 'Axios 1.13.5.0' },
                { id: 'CVE-2025-54135', severity: 'High', app: 'Anysphere Cursor 0.50.5.0' }
            ];
        });
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
            const hostname = machine.computerDnsName ? machine.computerDnsName.split('.')[0] : null;
            if (!hostname) continue;

            const device = devicesDB.get(hostname) || Array.from(devicesDB.values()).find(d => d.hostname.toLowerCase() === hostname.toLowerCase());
            if (device) {
                // 3. Get vulnerabilities for this machine
                const vulnRes = await axios.get(`https://api.securitycenter.microsoft.com/api/machines/${machine.id}/vulnerabilities`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });

                device.azure_cves = vulnRes.data.value.map(v => ({
                    id: v.cveId,
                    severity: v.severity,
                    app: v.productName
                }));
                console.log(`[Azure Sync] Updated ${hostname} with ${device.azure_cves.length} CVEs.`);
            }
        }
    } catch (err) {
        console.error('[Azure Sync] Error syncing vulnerabilities:', err.response ? err.response.data : err.message);
    }
}

// Run sync every 5 minutes
setInterval(syncAzureVulnerabilities, 5 * 60 * 1000);
// Run initial sync 5 seconds after startup
setTimeout(syncAzureVulnerabilities, 5000);

// ==========================================
// AGENT ROUTES (Called by the endpoints)
// ==========================================

// Agent Check-in
app.post('/api/agent/checkin', (req, res) => {
    const { hostname, osVersion, pendingWindowsUpdates, pendingAppUpdates, updateList, rebootRequired } = req.body;
    
    if (!hostname) return res.status(400).json({ error: 'Hostname is required' });

    const now = new Date().toISOString();
    
    // Preserve existing completed updates if any
    const existingDevice = devicesDB.get(hostname);
    const completedUpdates = existingDevice ? existingDevice.completed_updates : [];

    // Update or insert device
    devicesDB.set(hostname, {
        hostname,
        os_version: osVersion,
        last_seen: now,
        pending_windows_updates: pendingWindowsUpdates,
        pending_app_updates: pendingAppUpdates,
        update_list: updateList || [], // Already an array, no JSON.stringify needed
        completed_updates: completedUpdates,
        detailed_updates: existingDevice?.detailed_updates || [], // Persist detailed scan results
        reboot_required: !!rebootRequired
    });

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
    }
    res.json({ success: true });
});

// ==========================================
// DASHBOARD ROUTES (Called by the web UI)
// ==========================================

// List all devices
app.get('/api/devices', (req, res) => {
    // Convert Map to array and sort by last_seen descending
    const devicesArray = Array.from(devicesDB.values()).sort((a, b) => {
        return new Date(b.last_seen) - new Date(a.last_seen);
    });
    
    res.json(devicesArray);
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
