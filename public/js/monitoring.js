// Monitoring functionality
let monitoringInterval;

// Format bytes to human readable
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Format uptime to human readable
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
        return `${days} ngày ${hours} giờ ${minutes} phút`;
    } else if (hours > 0) {
        return `${hours} giờ ${minutes} phút`;
    } else {
        return `${minutes} phút`;
    }
}

// Update CPU progress bar
function updateCPUProgress(loadAverage) {
    const cpuPercent = Math.min(loadAverage * 100, 100);
    $('#cpu-progress').css('width', cpuPercent + '%');
    $('#cpu-details').text(`Tải trung bình: ${loadAverage.toFixed(2)} (${cpuPercent.toFixed(1)}%)`);
}

// Update Memory progress bar
function updateMemoryProgress(memory) {
    const memoryPercent = parseFloat(memory.usagePercent);
    $('#memory-progress').css('width', memoryPercent + '%');
    $('#memory-details').text(
        `Đã sử dụng: ${formatBytes(memory.used)} / ${formatBytes(memory.total)} (${memoryPercent}%)`
    );
}

// Update System Info
function updateSystemInfo(system) {
    $('#hostname').text(system.hostname);
    $('#uptime').text(formatUptime(system.uptime));
    $('#platform').text(system.platform);
}

// Update Process Info
function updateProcessInfo(process) {
    $('#process-pid').text(process.pid);
    $('#process-memory').text(formatBytes(process.memory.rss));
    $('#process-version').text(process.version);
}

// Update Logs
function updateLogs(logs) {
    const logContent = $('#log-content');
    logContent.empty();
    
    if (logs && logs.length > 0) {
        logs.forEach(log => {
            // Sử dụng log.message thay vì log.content để khớp với API response
            const logMessage = log.message || log.raw || 'No message';
            const logClass = logMessage.includes('ERROR') ? 'log-error' : 
                           logMessage.includes('WARNING') ? 'log-warning' : 'log-info';
            
            // Xử lý timestamp an toàn
            let displayTimestamp = 'Unknown';
            try {
                if (log.timestamp) {
                    // Thử parse timestamp từ API
                    const timestamp = new Date(log.timestamp);
                    if (!isNaN(timestamp.getTime())) {
                        // Nếu timestamp hợp lệ, format theo locale
                        displayTimestamp = timestamp.toLocaleTimeString('vi-VN');
                    } else {
                        // Nếu timestamp không hợp lệ, sử dụng raw timestamp hoặc current time
                        displayTimestamp = log.timestamp || new Date().toLocaleTimeString('vi-VN');
                    }
                } else {
                    // Nếu không có timestamp, sử dụng current time
                    displayTimestamp = new Date().toLocaleTimeString('vi-VN');
                }
            } catch (error) {
                // Fallback nếu có lỗi parse
                displayTimestamp = log.timestamp || new Date().toLocaleTimeString('vi-VN');
            }
            
            const logEntry = `
                <div class="log-entry">
                    <span class="log-timestamp">${displayTimestamp}</span>
                    <span class="log-message ${logClass}">${logMessage}</span>
                </div>
            `;
            logContent.append(logEntry);
        });
        
        // Auto-scroll to bottom
        logContent.scrollTop(logContent[0].scrollHeight);
    } else {
        logContent.html('<div class="text-muted text-center">Không có nhật ký</div>');
    }
}

// Get monitoring data
function getMonitoringData() {
    $.get("/api/monitoring/stats", function (data) {
        if (data.success && data.data) {
            const stats = data.data;
            
            // Update system stats
            if (stats.system) {
                updateCPUProgress(stats.system.cpu.loadAverage[0]);
                updateMemoryProgress(stats.system.memory);
                updateSystemInfo(stats.system);
            }
            
            // Update process stats
            if (stats.process) {
                updateProcessInfo(stats.process);
            }
            
            // Update logs
            if (stats.logs && stats.logs.latestLogs) {
                updateLogs(stats.logs.latestLogs);
            }
        }
    }).fail(function(xhr, status, error) {
        console.error('Lỗi khi tải dữ liệu giám sát:', error);
        $('#cpu-details').text('Lỗi tải dữ liệu');
        $('#memory-details').text('Lỗi tải dữ liệu');
    });
}

// Start monitoring
function startMonitoring() {
    // Get initial data
    getMonitoringData();
    
    // Set up interval for real-time updates (every 5 seconds)
    monitoringInterval = setInterval(getMonitoringData, 5000);
}

// Stop monitoring
function stopMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
}

// Initialize monitoring when page loads
$(document).ready(function() {
    startMonitoring();
    
    // Stop monitoring when page unloads
    $(window).on('beforeunload', function() {
        stopMonitoring();
    });
});

// Export functions for global access
window.monitoring = {
    startMonitoring,
    stopMonitoring,
    getMonitoringData
};
