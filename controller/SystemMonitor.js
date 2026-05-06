const os = require('os');
const fs = require('fs');
const path = require('path');
const RedisC = require("../service/Redis");
const log = require('node-file-logger');

const Redis = new RedisC();

// System monitoring functions
const getSystemStats = () => {
    try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        
        return {
            cpu: {
                loadAverage: os.loadavg(),
                cores: os.cpus().length,
                model: os.cpus()[0]?.model || 'Unknown'
            },
            memory: {
                total: totalMem,
                free: freeMem,
                used: usedMem,
                usagePercent: ((usedMem / totalMem) * 100).toFixed(2)
            },
            uptime: os.uptime(),
            platform: os.platform(),
            hostname: os.hostname(),
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        log.Error('Error getting system stats', error);
        return null;
    }
};

const getProcessStats = () => {
    try {
        const processInfo = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        
        return {
            pid: process.pid,
            memory: {
                rss: processInfo.rss,
                heapTotal: processInfo.heapTotal,
                heapUsed: processInfo.heapUsed,
                external: processInfo.external
            },
            cpu: {
                user: cpuUsage.user,
                system: cpuUsage.system
            },
            uptime: process.uptime(),
            version: process.version,
            platform: process.platform,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        log.Error('Error getting process stats', error);
        return null;
    }
};

const getSessionStats = async () => {
    try {
        const redis = Redis.getClient();
        const sessions = await redis.keys('SESS-*');
        const clients = await redis.keys('CLIENT-*');
        
        const sessionDetails = [];
        for (const sessionKey of sessions) {
            const sessionData = await redis.get(sessionKey);
            if (sessionData) {
                const session = JSON.parse(sessionData);
                sessionDetails.push({
                    id: session.id,
                    createAt: session.create_at,
                    isRecording: session.isRecording || false,
                    recordFileId: session.record_file_id,
                    streamer: session.streamer,
                    subscribers: session.subscribers?.length || 0,
                    routerIndex: session.router_index
                });
            }
        }
        
        return {
            totalSessions: sessions.length,
            totalClients: clients.length,
            activeSessions: sessionDetails.filter(s => s.isRecording).length,
            sessions: sessionDetails,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        log.Error('Error getting session stats', error);
        return null;
    }
};

const getFileSystemStats = () => {
    try {
        const filesDir = path.join(process.cwd(), 'public/files');
        let totalFiles = 0;
        let totalSize = 0;
        
        if (fs.existsSync(filesDir)) {
            const files = fs.readdirSync(filesDir);
            totalFiles = files.length;
            
            for (const file of files) {
                const filePath = path.join(filesDir, file);
                const stats = fs.statSync(filePath);
                totalSize += stats.size;
            }
        }
        
        return {
            totalFiles,
            totalSize: totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
            directory: filesDir,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        log.Error('Error getting filesystem stats', error);
        return null;
    }
};

const getRealTimeLogs = async (limit = 500) => {
    try {
        const logsDir = path.join(process.cwd(), 'logs');
        const logFiles = [];
        
        if (fs.existsSync(logsDir)) {
            const files = fs.readdirSync(logsDir);
            for (const file of files) {
                if (file.endsWith('.log')) {
                    const filePath = path.join(logsDir, file);
                    const stats = fs.statSync(filePath);
                    logFiles.push({
                        name: file,
                        size: stats.size,
                        modified: stats.mtime,
                        path: filePath
                    });
                }
            }
        }
        
        // Sort by modification time (newest first)
        logFiles.sort((a, b) => b.modified - a.modified);
        
        // Get content from latest log file with improved parsing
        let logContent = [];
        if (logFiles.length > 0) {
            const latestLog = logFiles[0];
            const content = fs.readFileSync(latestLog.path, 'utf8');
            const lines = content.split('\n').filter(line => line.trim());
            
            // Parse log lines with better structure
            logContent = lines.slice(-limit).map(line => {
                try {
                    // Try to parse structured log format
                    if (line.includes('|')) {
                        const parts = line.split('|');
                        if (parts.length >= 4) {
                            // Parse timestamp từ format "08:56:51 02:23:45 PM"
                            let parsedTimestamp = new Date().toISOString(); // fallback
                            try {
                                const timeStr = parts[0]?.trim();
                                if (timeStr) {
                                    // Thử parse timestamp từ format "08:56:51 02:23:45 PM"
                                    // Format này có thể là "HH:MM:SS DD:MM:YY AM/PM"
                                    const now = new Date();
                                    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2}):(\d{2})/);
                                    if (timeMatch) {
                                        const [_, hours, minutes, seconds] = timeMatch;
                                        // Tạo timestamp với ngày hôm nay và giờ từ log
                                        const logTime = new Date();
                                        logTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds), 0);
                                        parsedTimestamp = logTime.toISOString();
                                    }
                                }
                            } catch (parseError) {
                                // Nếu parse timestamp thất bại, sử dụng current time
                                parsedTimestamp = new Date().toISOString();
                            }
                            
                            return {
                                timestamp: parsedTimestamp,
                                level: parts[1]?.trim() || 'Info',
                                message: parts[2]?.trim() || line,
                                service: parts[3]?.trim() || 'Unknown',
                                method: parts[4]?.trim() || 'Unknown',
                                file: latestLog.name,
                                raw: line
                            };
                        }
                    }
                    
                    // Fallback for unstructured logs
                    return {
                        timestamp: new Date().toISOString(),
                        level: 'Info',
                        message: line,
                        service: 'Unknown',
                        method: 'Unknown',
                        file: latestLog.name,
                        raw: line
                    };
                } catch (parseError) {
                    return {
                timestamp: new Date().toISOString(),
                        level: 'Error',
                        message: 'Log parsing error',
                        service: 'SystemMonitor',
                        method: 'getRealTimeLogs',
                        file: latestLog.name,
                        raw: line
                    };
                }
            });
        }
        
        return {
            logFiles,
            latestLogs: logContent,
            totalLogs: logContent.length,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        log.Error('Error getting real-time logs', error);
        return null;
    }
};

// Get filtered logs by service/method/level
const getFilteredLogs = async (limit = 100, service = null, method = null, level = null) => {
    try {
        const allLogs = await getRealTimeLogs(limit * 2); // Get more logs to filter from
        
        if (!allLogs || !allLogs.latestLogs) {
            return null;
        }
        
        let filteredLogs = allLogs.latestLogs;
        
        // Filter by service
        if (service) {
            filteredLogs = filteredLogs.filter(log => 
                log.service && log.service.toLowerCase().includes(service.toLowerCase())
            );
        }
        
        // Filter by method
        if (method) {
            filteredLogs = filteredLogs.filter(log => 
                log.method && log.method.toLowerCase().includes(method.toLowerCase())
            );
        }
        
        // Filter by level
        if (level) {
            filteredLogs = filteredLogs.filter(log => 
                log.level && log.level.toLowerCase() === level.toLowerCase()
            );
        }
        
        // Limit results
        filteredLogs = filteredLogs.slice(-limit);
        
        return {
            filteredLogs,
            totalFiltered: filteredLogs.length,
            filters: { service, method, level },
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        log.Error('Error getting filtered logs', error);
        return null;
    }
};

// Get FFmpeg conversion logs specifically
const getFFmpegLogs = async (limit = 50) => {
    try {
        // Get logs filtered by StreamingService and convertToMp4 method
        const ffmpegLogs = await getFilteredLogs(limit, 'StreamingService', 'convertToMp4');
        
        if (!ffmpegLogs) {
            return null;
        }
        
        // Additional filtering for FFmpeg-related messages
        const relevantLogs = ffmpegLogs.filteredLogs.filter(log => {
            const message = log.message.toLowerCase();
            return message.includes('ffmpeg') || 
                   message.includes('conversion') || 
                   message.includes('webm') || 
                   message.includes('mp4') ||
                   message.includes('video') ||
                   message.includes('audio');
        });
        
        return {
            ffmpegLogs: relevantLogs,
            totalFFmpegLogs: relevantLogs.length,
            conversionStats: {
                totalConversions: relevantLogs.filter(log => log.message.includes('conversion')).length,
                successfulConversions: relevantLogs.filter(log => 
                    log.message.includes('completed successfully') || 
                    log.message.includes('conversion finished')
                ).length,
                failedConversions: relevantLogs.filter(log => 
                    log.message.includes('failed') || 
                    log.message.includes('error')
                ).length
            },
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        log.Error('Error getting FFmpeg logs', error);
        return null;
    }
};

const getComprehensiveStats = async () => {
    try {
        const [systemStats, processStats, sessionStats, fileSystemStats, logStats] = await Promise.all([
            getSystemStats(),
            getProcessStats(),
            getSessionStats(),
            getFileSystemStats(),
            getRealTimeLogs()
        ]);
        
        return {
            system: systemStats,
            process: processStats,
            sessions: sessionStats,
            filesystem: fileSystemStats,
            logs: logStats,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        log.Error('Error getting comprehensive stats', error);
        return null;
    }
};

module.exports = {
    getSystemStats,
    getProcessStats,
    getSessionStats,
    getFileSystemStats,
    getRealTimeLogs,
    getFilteredLogs,
    getFFmpegLogs,
    getComprehensiveStats
};
