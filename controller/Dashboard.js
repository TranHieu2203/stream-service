const config = require('../config');
const { uuid } = require('uuidv4');
const clc = require('cli-color');
const fileFolder = './public/files/';
const path = require('path')
const fs = require('fs')
const fsPromises = require('fs/promises')
const RedisC = require("../service/Redis");
const StreamingController = require("./Streaming");
const diskusage = require('diskusage');

const Redis = new RedisC()

const getStats = async (req, res, next) => {
    try {
        let redis = Redis.getClient()
        var data = fs.readFileSync('./public/list.txt', 'utf8');
        const lines = data.split('\n').map((l, index) => {
            return l.split('|')[1] ? {
                session: l.split('|')[0],
                time: l.split('|')[1],
                file: l.split('|')[2]
            } : null
        })

        const list_session = await redis.keys('SESS-*')
        const list_client = await redis.keys('CLIENT-*')

        // Get session details
        const sessionDetails = await Promise.all(
            list_session.map(async (sessionKey) => {
                const sessionData = await redis.get(sessionKey);
                return sessionData ? JSON.parse(sessionData) : null;
            })
        );

        // Get system health information
        const health = await getSystemHealth();

        res.send({
            ok: 1,
            total_session: list_session.length,
            total_peer: list_client.length,
            mor: StreamingController.getStats(),
            files: lines ? lines.reverse() : [],
            list_session: sessionDetails.filter(s => s !== null),
            system_health: health
        })
    } catch (e) {
        console.error('Error getting stats:', e);
        res.send({ 
            ok: 0, 
            error: 'Failed to get system stats',
            system_health: null
        });
    }
}

const getSystemHealth = async () => {
    const health = {
        diskSpace: {
            total: 0,
            free: 0,
            used: 0,
            usedPercentage: 0
        },
        activeSessions: 0,
        activeProcesses: 0,
        fileCount: 0,
        timestamp: new Date().toISOString()
    };
    
    try {
        // Kiểm tra dung lượng ổ đĩa
        const disk = await diskusage.check(path.resolve('./'));
        health.diskSpace = {
            total: disk.total,
            free: disk.free,
            used: disk.total - disk.free,
            usedPercentage: Math.round(((disk.total - disk.free) / disk.total) * 100)
        };
        
        // Đếm số session đang active
        const redis = Redis.getClient();
        const sessions = await redis.keys('SESS-*');
        health.activeSessions = sessions.length;
        
        // Đếm số process đang chạy
        const mor = StreamingController.getStats();
        health.activeProcesses = mor.process;
        
        // Đếm số file trong thư mục public/files
        if (fs.existsSync(fileFolder)) {
            health.fileCount = fs.readdirSync(fileFolder).length;
        }
        
        return health;
    } catch (e) {
        console.error('Health check failed:', e);
        return null;
    }
}

const removeFile = async (req, res, next) => {
    try {
        fs.truncate('./public/list.txt', 0, async function () {
            const files = await fsPromises.readdir(fileFolder);
            for (const file of files) {
                await fsPromises.unlink(path.resolve(fileFolder, file));
                console.log(`${fileFolder}/${file} has been removed successfully`);
            }
            res.send({ success: true })
        })
    } catch (e) {
        res.send({ success: false })
    }
}

module.exports = {
    getStats,
    removeFile,
    getSystemHealth
}