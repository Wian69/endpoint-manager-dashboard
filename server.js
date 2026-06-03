const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite database
const db = new sqlite3.Database(':memory:'); // Using memory for simplicity in this POC. In production, use a persistent file.

db.serialize(() => {
    // Devices table
    db.run(`CREATE TABLE devices (
        hostname TEXT PRIMARY KEY,
        os_version TEXT,
        last_seen DATETIME,
        pending_windows_updates INTEGER,
        pending_app_updates INTEGER,
        update_list TEXT
    )`);

    // Jobs table for queuing commands
    db.run(`CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname TEXT,
        command TEXT,
        status TEXT, -- 'pending', 'completed', 'failed'
        created_at DATETIME
    )`);
});

// ==========================================
// AGENT ROUTES (Called by the endpoints)
// ==========================================

// Agent Check-in
app.post('/api/agent/checkin', (req, res) => {
    const { hostname, osVersion, pendingWindowsUpdates, pendingAppUpdates, updateList } = req.body;
    
    if (!hostname) return res.status(400).json({ error: 'Hostname is required' });

    const now = new Date().toISOString();
    
    db.run(`INSERT INTO devices (hostname, os_version, last_seen, pending_windows_updates, pending_app_updates, update_list)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(hostname) DO UPDATE SET 
            os_version=excluded.os_version,
            last_seen=excluded.last_seen,
            pending_windows_updates=excluded.pending_windows_updates,
            pending_app_updates=excluded.pending_app_updates,
            update_list=excluded.update_list`, 
    [hostname, osVersion, now, pendingWindowsUpdates, pendingAppUpdates, JSON.stringify(updateList || [])], 
    function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Agent fetch pending jobs
app.get('/api/agent/jobs/:hostname', (req, res) => {
    const hostname = req.params.hostname;
    db.get(`SELECT * FROM jobs WHERE hostname = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`, [hostname], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ job: null });
        
        // Mark as in-progress if we want, but for simplicity, the agent will report back
        res.json({ job: row });
    });
});

// Agent report job completion
app.post('/api/agent/jobs/:jobId/status', (req, res) => {
    const { status } = req.body; // 'completed', 'failed'
    db.run(`UPDATE jobs SET status = ? WHERE id = ?`, [status, req.params.jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ==========================================
// DASHBOARD ROUTES (Called by the web UI)
// ==========================================

// List all devices
app.get('/api/devices', (req, res) => {
    db.all(`SELECT * FROM devices ORDER BY last_seen DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // parse JSON strings
        const devices = rows.map(r => ({
            ...r,
            update_list: JSON.parse(r.update_list || '[]')
        }));
        res.json(devices);
    });
});

// Queue an update command for a device
app.post('/api/devices/:hostname/trigger', (req, res) => {
    const hostname = req.params.hostname;
    const { command } = req.body; // e.g., 'Force-Updates'
    
    db.run(`INSERT INTO jobs (hostname, command, status, created_at) VALUES (?, ?, 'pending', ?)`,
    [hostname, command, new Date().toISOString()], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, jobId: this.lastID });
    });
});

app.listen(PORT, () => {
    console.log(`Endpoint Management Server running on port ${PORT}`);
});
