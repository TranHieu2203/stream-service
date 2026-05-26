const config = require('../config');
const { uuid } = require('uuidv4');
const clc = require('cli-color');
const fileFolder = './public/files/';
const path = require('path')
const fs = require('fs')
const fsPromises = require('fs/promises')
const os = require('os')
const { execSync } = require('child_process')
const mediasoup = require('mediasoup');
const RedisC = require("../service/Redis");
const StreamingController = require("./Streaming");
const mds = require("../service/core/mds");
const diskusage = require('diskusage');

const Redis = new RedisC()

// ============================================================
// Diagnostic helpers — dùng để so sánh UAT vs PROD
// HieuTV: Gỡ sau khi xong debug
// ============================================================
function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 2000 }).trim();
  } catch (e) {
    return `ERR: ${e.message}`;
  }
}

let workerVersionCache = null;
function getWorkerVersion() {
  if (workerVersionCache) return workerVersionCache;
  try {
    const workerBin = path.resolve(
      process.cwd(),
      "node_modules/mediasoup/worker/out/Release/mediasoup-worker"
    );
    workerVersionCache = safeExec(`"${workerBin}" --version`);
  } catch (e) {
    workerVersionCache = `ERR: ${e.message}`;
  }
  return workerVersionCache;
}

async function buildDiag() {
  let routerRtpCapabilities = null;
  let routerErr = null;
  try {
    const router = await mds.getRouter(0);
    if (router && router.rtpCapabilities) {
      routerRtpCapabilities = router.rtpCapabilities;
    } else {
      routerErr = "router not initialized";
    }
  } catch (e) {
    routerErr = e.message;
  }
  return {
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    mediasoup: {
      js_version: mediasoup.version,
      worker_version: getWorkerVersion(),
    },
    router_rtp_capabilities: routerRtpCapabilities,
    router_error: routerErr,
    config_media_codecs: config.router && config.router.mediaCodecs ? config.router.mediaCodecs : null,
    runtime: {
      node: process.version,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    },
    env: {
      NODE_ENV: process.env.NODE_ENV || null,
      EXTIP: process.env.EXTIP || null,
      PORT: process.env.PORT || null,
    },
    git: {
      branch: safeExec("git branch --show-current"),
      commit: safeExec("git rev-parse HEAD"),
      commit_short: safeExec("git rev-parse --short HEAD"),
      log_3: safeExec("git log --oneline -3"),
    },
    package_lock_mediasoup: safeExec(
      "grep -A 1 '\"node_modules/mediasoup\"' package-lock.json | head -3"
    ),
  };
}

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

        // Thông tin chẩn đoán — dùng để so sánh UAT vs PROD (tạm thời, gỡ sau khi xong)
        const diag = await buildDiag();

        res.send({
            ok: 1,
            total_session: list_session.length,
            total_peer: list_client.length,
            mor: StreamingController.getStats(),
            files: lines ? lines.reverse() : [],
            list_session: sessionDetails.filter(s => s !== null),
            system_health: health,
            diag
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