// Diagnostic endpoint — READ ONLY, dùng để so sánh UAT vs PROD.
// Không ảnh hưởng luồng stream/record/upload.
// Trả về JSON gồm:
//   - mediasoup JS + worker version
//   - Node + OS info
//   - router.rtpCapabilities (KEY — để so sánh extension/codec mapping)
//   - config.js snapshot (mediaCodecs)
//   - git commit/branch
//   - một số env var an toàn (EXTIP, NODE_ENV)
//
// Gỡ bỏ sau khi xong debug: xóa file này + dòng route trong routes/index.js.

const os = require("os");
const { execSync } = require("child_process");
const mediasoup = require("mediasoup");
const config = require("../config");
const mds = require("../service/core/mds");

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
    const path = require("path");
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

const getInfo = async (req, res) => {
  try {
    // Lấy router instance đầu tiên (đã được initialize ở mds.js)
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

    const info = {
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

    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};

module.exports = {
  getInfo,
};
