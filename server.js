const express = require('express');
const cors = require('cors');
const path = require('path');

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
// AGENT ROUTES (Called by the endpoints)
// ==========================================

// Agent Check-in
app.post('/api/agent/checkin', (req, res) => {
    const { hostname, osVersion, pendingWindowsUpdates, pendingAppUpdates, updateList } = req.body;
    
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
        completed_updates: completedUpdates
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
    
    res.json({ job });
});

// Agent report job completion
app.post('/api/agent/jobs/:jobId/status', (req, res) => {
    const jobId = parseInt(req.params.jobId);
    const { status, completedUpdates } = req.body; // 'completed', 'failed'
    
    const job = jobsDB.find(j => j.id === jobId);
    if (job) {
        job.status = status;
        
        // If the job has completedUpdates, attach them to the device profile permanently
        if (completedUpdates && Array.isArray(completedUpdates)) {
            const device = devicesDB.get(job.hostname);
            if (device) {
                // Keep only the most recent completed updates, or append them
                device.completed_updates = completedUpdates;
                device.last_update_run = new Date().toISOString();
                devicesDB.set(job.hostname, device);
            }
        }
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
    const { command } = req.body; // e.g., 'Force-Updates'
    
    const newJob = {
        id: nextJobId++,
        hostname,
        command,
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
