// Format bytes to human readable format
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Format date to local string
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false
    });
}

// Update system health information
function updateSystemHealth(health) {
    if (!health) return;

    // Update disk usage
    const diskBar = document.getElementById('disk-usage-bar');
    const diskUsed = document.getElementById('disk-used');
    const diskFree = document.getElementById('disk-free');
    const diskTotal = document.getElementById('disk-total');

    if (diskBar && health.diskSpace) {
        const usedPercentage = health.diskSpace.usedPercentage;
        diskBar.style.width = `${usedPercentage}%`;
        diskBar.className = `progress-bar ${usedPercentage > 90 ? 'bg-danger' : usedPercentage > 70 ? 'bg-warning' : 'bg-success'}`;
        
        diskUsed.textContent = formatBytes(health.diskSpace.used);
        diskFree.textContent = formatBytes(health.diskSpace.free);
        diskTotal.textContent = formatBytes(health.diskSpace.total);
    }

    // Update system stats
    const activeSessions = document.getElementById('active-sessions');
    const activeProcesses = document.getElementById('active-processes');
    const fileCount = document.getElementById('file-count');
    const lastUpdate = document.getElementById('last-update');

    if (activeSessions) activeSessions.textContent = health.activeSessions;
    if (activeProcesses) activeProcesses.textContent = health.activeProcesses;
    if (fileCount) fileCount.textContent = health.fileCount;
    if (lastUpdate) lastUpdate.textContent = formatDate(health.timestamp);
}

// Update dashboard stats
function updateStats(data) {
    if (data.ok === 1) {
        // Update system health
        if (data.system_health) {
            updateSystemHealth(data.system_health);
        }

        // Update other stats
        document.getElementById('tt_session').textContent = data.total_session;
        document.getElementById('tt_streamer').textContent = data.total_peer;
        
        if (data.mor) {
            document.getElementById('tt_producer').textContent = data.mor.producer;
            document.getElementById('tt_consumer').textContent = data.mor.consumer;
            document.getElementById('tt_socketclient').textContent = data.mor.socket_client;
            document.getElementById('tt_process').textContent = data.mor.process;
        }

        // Update session list
        const sessionList = document.getElementById('list-session');
        if (sessionList && data.list_session) {
            sessionList.innerHTML = data.list_session.map(session => {
                if (!session) return '';
                return `
                    <tr>
                        <td data-label="Session">${session.id}</td>
                        <td data-label="Create At">${formatDate(session.create_at * 60000)}</td>
                        <td data-label="Recording">${session.isRecording ? 'Đang ghi' : 'Không'}</td>
                        <td data-label="Record file">${session.record_file_id || '--'}</td>
                        <td data-label="Viewer">${session.subscribers ? session.subscribers.length : 0}</td>
                    </tr>
                `;
            }).join('');
        }

        // Update file list
        const fileList = document.getElementById('list-file');
        if (fileList && data.files) {
            fileList.innerHTML = data.files.map(file => {
                if (!file) return '';
                return `
                    <tr>
                        <td data-label="Session">${file.session}</td>
                        <td data-label="Time">${file.time}</td>
                        <td data-label="Record"><a href="/files/${file.file}" target="_blank">${file.file}</a></td>
                    </tr>
                `;
            }).join('');
        }
    }
}

// Fetch and update dashboard data
function fetchDashboardData() {
    $.get("/api/stats/get-stats", function(data) {
        updateStats(data);
    }).fail(function(error) {
        console.error('Error fetching dashboard data:', error);
    });
}

// Update dashboard every 5 seconds
setInterval(fetchDashboardData, 5000);

// Initial fetch
fetchDashboardData();

function getStats() {
    $.get("/api/stats/get-stats", function (data) {
        console.log(data)
        $('#tt_session').html(data.total_session)
        $('#tt_streamer').html(data.total_peer)
        $('#tt_producer').html(data.mor.producer)
        $('#tt_consumer').html(data.mor.consumer)
        $('#tt_process').html(data.mor.process)
        $('#tt_socketclient').html(data.mor.socket_client)
        
        // Update system health if available
        if (data.system_health) {
            const health = data.system_health;
            
            // Update disk usage
            const diskBar = document.getElementById('disk-usage-bar');
            if (diskBar && health.diskSpace) {
                const usedPercentage = health.diskSpace.usedPercentage;
                diskBar.style.width = `${usedPercentage}%`;
                diskBar.className = `progress-bar ${usedPercentage > 90 ? 'bg-danger' : usedPercentage > 70 ? 'bg-warning' : 'bg-success'}`;
                
                $('#disk-used').text(formatBytes(health.diskSpace.used));
                $('#disk-free').text(formatBytes(health.diskSpace.free));
                $('#disk-total').text(formatBytes(health.diskSpace.total));
            }
            
            // Update system stats
            $('#active-sessions').text(health.activeSessions);
            $('#active-processes').text(health.activeProcesses);
            $('#file-count').text(health.fileCount);
            $('#last-update').text(new Date(health.timestamp).toLocaleString('vi-VN', {
                timeZone: 'Asia/Ho_Chi_Minh',
                hour12: false
            }));
        }

        $('#list-session').html('')
        data.list_session.forEach(element => {
            $('#list-session').append('<li>' + element + '</li>')
        });
        $('#list-file').html('')
        data.files.forEach(element => {
            if (element) {
                let line_file = '<tr class="tstats">'
                line_file += ' <td class="f_session">' + element.session + '</td>'
                line_file += ' <td class="f_time">' + element.time + '</td>'
                line_file += ' <td class="f_name"><a href="/files/' + element.file + '" target="_blank">' + element.file + '</td>'
                line_file += '</tr>'
                $('#list-file').append(line_file)
            }
        });
    });
}

function rmFile() {
    $.get("/api/stats/remove-all", function (data) {
        getStats()
    });
}

$('#refresh').on('click', () => {
    getStats()
})

$('#rm-cache').on('click', () => {
    rmFile()
})
