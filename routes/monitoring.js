const express = require('express');
const router = express.Router();
const path = require('path');
const SystemMonitor = require('../controller/SystemMonitor');
const requireLogin = require('../middleware/requireLogin');

// Bảo vệ tất cả monitoring routes bằng authentication
router.use(requireLogin);

// Get comprehensive system stats
router.get('/api/monitoring/stats', async (req, res) => {
    try {
        const stats = await SystemMonitor.getComprehensiveStats();
        if (stats) {
            res.json({
                success: true,
                data: stats
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to get system stats'
            });
        }
    } catch (error) {
        console.error('Error getting monitoring stats:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Get system stats only
router.get('/api/monitoring/system-stats', async (req, res) => {
    try {
        const stats = SystemMonitor.getSystemStats();
        if (stats) {
            res.json({
                success: true,
                data: stats
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to get system stats'
            });
        }
    } catch (error) {
        console.error('Error getting system stats:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Get process stats only
router.get('/api/monitoring/process-stats', async (req, res) => {
    try {
        const stats = SystemMonitor.getProcessStats();
        if (stats) {
            res.json({
                success: true,
                data: stats
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to get process stats'
            });
        }
    } catch (error) {
        console.error('Error getting process stats:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Get session stats only
router.get('/api/monitoring/session-stats', async (req, res) => {
    try {
        const stats = await SystemMonitor.getSessionStats();
        if (stats) {
            res.json({
                success: true,
                data: stats
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to get session stats'
            });
        }
    } catch (error) {
        console.error('Error getting session stats:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Get filesystem stats only
router.get('/api/monitoring/filesystem-stats', async (req, res) => {
    try {
        const stats = SystemMonitor.getFileSystemStats();
        if (stats) {
            res.json({
                success: true,
                data: stats
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to get filesystem stats'
            });
        }
    } catch (error) {
        console.error('Error getting filesystem stats:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Get real-time logs
router.get('/api/monitoring/logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const stats = await SystemMonitor.getRealTimeLogs(limit);
        if (stats) {
            res.json({
                success: true,
                data: stats
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to get logs'
            });
        }
    } catch (error) {
        console.error('Error getting logs:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Get filtered logs by service/method
router.get('/api/monitoring/logs/filter', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const service = req.query.service || null;
        const method = req.query.method || null;
        const level = req.query.level || null;
        
        const stats = await SystemMonitor.getFilteredLogs(limit, service, method, level);
        if (stats) {
            res.json({
                success: true,
                data: stats
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to get filtered logs'
            });
        }
    } catch (error) {
        console.error('Error getting filtered logs:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Get FFmpeg conversion logs specifically
router.get('/api/monitoring/logs/ffmpeg', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const stats = await SystemMonitor.getFFmpegLogs(limit);
        if (stats) {
            res.json({
                success: true,
                data: stats
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to get FFmpeg logs'
            });
        }
    } catch (error) {
        console.error('Error getting FFmpeg logs:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Route logs-dashboard đã được chuyển vào server.js với bảo vệ authentication

module.exports = router;
