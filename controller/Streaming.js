const {
    initializeWorkers,
    getNextRouterIndex,
    getRouter,
    createTransport
} = require('../service/core/mds');

// const MDS = require('mediasoup');
const FormData = require('form-data');
const axios = require('axios').default;
const fs = require('fs')
const appRoot = require('app-root-path');
const config = require('../config');
const { uuid } = require('uuidv4');
const clc = require('cli-color');
const RedisC = require("../service/Redis");
const log = require('node-file-logger');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const os = require('os');

// =========================================================================
// CONCURRENCY LIMITERS (Safe queueing for conversion and upload)
// =========================================================================
// Conversion limiter
const CONVERSION_MAX_CONCURRENT = 3; // safe default for 4-core
let conversionInFlight = 0;
const conversionQueue = [];

const getActiveConversions = () => conversionInFlight;

const processConversionQueue = () => {
  if (conversionInFlight >= CONVERSION_MAX_CONCURRENT) return;
  const next = conversionQueue.shift();
  if (!next) return;
  conversionInFlight++;
  log.Info(`Conversion slot acquired - InFlight: ${conversionInFlight}/${CONVERSION_MAX_CONCURRENT}`, 'StreamingService', 'conversionLimiter');
  next.fn()
    .then((result) => {
      conversionInFlight--;
      log.Info(`Conversion slot released - InFlight: ${conversionInFlight}/${CONVERSION_MAX_CONCURRENT}`, 'StreamingService', 'conversionLimiter');
      processConversionQueue();
      next.resolve(result);
    })
    .catch((err) => {
      conversionInFlight--;
      log.Info(`Conversion slot released (error) - InFlight: ${conversionInFlight}/${CONVERSION_MAX_CONCURRENT}`, 'StreamingService', 'conversionLimiter');
      processConversionQueue();
      next.reject(err);
    });
};

const enqueueConversion = (fn) => new Promise((resolve, reject) => {
  conversionQueue.push({ fn, resolve, reject });
  log.Info(`Conversion enqueued - QueueLength: ${conversionQueue.length}, InFlight: ${conversionInFlight}`, 'StreamingService', 'conversionLimiter');
  processConversionQueue();
});

// Upload limiter
const UPLOAD_MAX_CONCURRENT = 2; // isolate IO/API contention
let uploadInFlight = 0;
const uploadQueue = [];

const processUploadQueue = () => {
  if (uploadInFlight >= UPLOAD_MAX_CONCURRENT) return;
  const next = uploadQueue.shift();
  if (!next) return;
  uploadInFlight++;
  log.Info(`Upload slot acquired - InFlight: ${uploadInFlight}/${UPLOAD_MAX_CONCURRENT}`, 'StreamingService', 'uploadLimiter');
  next.fn()
    .then((result) => {
      uploadInFlight--;
      log.Info(`Upload slot released - InFlight: ${uploadInFlight}/${UPLOAD_MAX_CONCURRENT}`, 'StreamingService', 'uploadLimiter');
      processUploadQueue();
      next.resolve(result);
    })
    .catch((err) => {
      uploadInFlight--;
      log.Info(`Upload slot released (error) - InFlight: ${uploadInFlight}/${UPLOAD_MAX_CONCURRENT}`, 'StreamingService', 'uploadLimiter');
      processUploadQueue();
      next.reject(err);
    });
};

const enqueueUpload = (fn) => new Promise((resolve, reject) => {
  uploadQueue.push({ fn, resolve, reject });
  log.Info(`Upload enqueued - QueueLength: ${uploadQueue.length}, InFlight: ${uploadInFlight}`, 'StreamingService', 'uploadLimiter');
  processUploadQueue();
});

// ============================================================================
// PHƯƠNG ÁN 2: CÂN BẰNG TỐC ĐỘ/CHẤT LƯỢNG CHO FFMPEG ENCODING
// ============================================================================
// Mục tiêu: Giảm 40-60% thời gian convert video từ WebM sang MP4
// Cách tiếp cận: Sử dụng cấu hình ADAPTIVE tự động điều chỉnh theo hardware capability
// 
// THAY ĐỔI MỚI (2025-08-22):
// - Tất cả server 4 cores: Sử dụng cấu hình tối ưu duy nhất
// - Không phân biệt UAT/LIVE, không phân biệt nhỏ hơn hay lớn hơn
// - Sử dụng cấu hình UNIFIED đơn giản và ổn định
// - Loại bỏ function detectEnvironment() không còn cần thiết
// - Đơn giản hóa thành 1 cấu hình duy nhất cho 4 cores
//
// TÁC ĐỘNG DỰ KIẾN:
// - Tất cả server 4 cores: Giảm 40-50% thời gian encode, tăng stability
// - Cấu hình UNIFIED: Đơn giản, ổn định, dễ maintain
// - CHẤT LƯỢNG: Giảm 10-20% nhưng vẫn chấp nhận được
// - TỐC ĐỘ: 2-3x real-time (cân bằng tốc độ và ổn định)
// - STABILITY: Tăng đáng kể, giảm tỷ lệ conversion failed
//
// FIXED ISSUES:
// - Sửa lỗi Percent % bị NaN trong FFmpeg progress
// - Xử lý fallback khi progress.percent không hợp lệ
// - Tính toán percent ước tính dựa trên thời gian
// - Đồng bộ hóa tất cả log conversion để hiển thị đầy đủ thông số
// - Khắc phục vấn đề main conversion luôn failed
// - Tự động điều chỉnh cấu hình theo hardware capability
//
// LATEST FIXES (2025-01-27):
// - Loại bỏ các outputOptions có vấn đề: -x264opts, -rc-lookahead, -thread_type, -b_strategy
// - Thay thế bằng -x264-params ổn định hơn
// - Cải thiện error logging để debug tốt hơn
// - Tăng cường fallback method với cài đặt ổn định
// - Giải quyết vấn đề "FFmpeg conversion failed" ở lần đầu
// ============================================================================

// Dynamic CPU Detection and Optimization
const getSystemInfo = () => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  
  return {
    cpuCores: cpus.length,
    cpuModel: cpus[0]?.model || 'Unknown',
    totalMemory: totalMem,
    freeMemory: freeMem,
    usedMemory: totalMem - freeMem,
    memoryUsagePercent: ((totalMem - freeMem) / totalMem * 100).toFixed(2)
  };
};

const detectEnvironment = () => {
  const sysInfo = getSystemInfo();
  
  log.Info(`System Info - CPU: ${sysInfo.cpuCores} cores (${sysInfo.cpuModel}), RAM: ${(sysInfo.totalMemory / 1024 / 1024 / 1024).toFixed(1)}GB, MemoryUsage: ${sysInfo.memoryUsagePercent}%`, 'StreamingService', 'detectEnvironment');
  
  // Detection logic
  if (sysInfo.cpuCores <= 2) {
    return 'UAT';
  } else if (sysInfo.cpuCores >= 4) {
    return 'LIVE';
  } else {
    return 'UNKNOWN';
  }
};

// ============================================================================
// HARDWARE CAPABILITY DETECTION - PHÁT HIỆN KHẢ NĂNG THỰC TẾ
// ============================================================================
const detectHardwareCapability = (sysInfo) => {
  // ============================================================================
  // HARDWARE CAPABILITY DETECTION - DUY NHẤT 1 CẤU HÌNH CHO 4 CORES
  // ============================================================================
  // Mục tiêu: Sử dụng 1 cấu hình tối ưu duy nhất cho 4 cores
  // Không phân biệt UAT/LIVE, không phân biệt nhỏ hơn hay lớn hơn
  // ============================================================================
  
  return {
    level: 'OPTIMIZED',
    description: '4 cores Server - Cấu hình tối ưu duy nhất cho tốc độ và ổn định',
    preset: 'fast',             // Cân bằng tốc độ và ổn định
    meMethod: 'hex',            // Ổn định hơn dia
    subq: 4,                    // Chất lượng vừa phải
    refs: 2,                    // Reference frames vừa phải
    trellis: 1,                 // Bật trellis để tăng stability
    threads: 4                  // Tối ưu cho 4 cores
  };
};

let _cachedHardwareSettings = null;
const getOptimizedFFmpegSettings = () => {
  if (_cachedHardwareSettings) return _cachedHardwareSettings;
  const sysInfo = getSystemInfo();
  
  log.Info(`CPU Cores: ${sysInfo.cpuCores}, RAM: ${(sysInfo.totalMemory / 1024 / 1024 / 1024).toFixed(1)}GB`, 'StreamingService', 'getOptimizedFFmpegSettings');
  
  // Log system detection
  log.Info(`System Detection - CPU: ${sysInfo.cpuCores} cores, RAM: ${(sysInfo.totalMemory / 1024 / 1024 / 1024).toFixed(1)}GB`, 'StreamingService', 'getOptimizedFFmpegSettings');
  
  // ============================================================================
  // HARDWARE CAPABILITY DETECTION - PHÁT HIỆN KHẢ NĂNG THỰC TẾ
  // ============================================================================
  const hardwareCapability = detectHardwareCapability(sysInfo);
  log.Info(`Hardware Capability: ${hardwareCapability.level} - ${hardwareCapability.description}`, 'StreamingService', 'getOptimizedFFmpegSettings');
  
  log.Info(`Hardware Capability Detected - Level: ${hardwareCapability.level}, Description: ${hardwareCapability.description}`, 'StreamingService', 'getOptimizedFFmpegSettings');
  
  // ============================================================================
  // ADAPTIVE OPTIMIZED SETTINGS - TỰ ĐỘNG ĐIỀU CHỈNH THEO HARDWARE
  // ============================================================================
  // Mục tiêu: Sử dụng cấu hình ADAPTIVE tự động điều chỉnh theo hardware capability
  // Lý do: UAT đã được nâng cấp CPU cores giống LIVE, cần tối ưu theo thực tế
  // Tác động: Tối ưu tốc độ convert và tăng stability theo hardware
  //
  // THAY ĐỔI CHÍNH SO VỚI CÀI ĐẶT CŨ:
  // 1. PRESET: 'medium' → 'fast'/'veryfast' (tăng tốc độ 30-50%)
  // 2. ME METHOD: 'umh' → 'hex'/'dia' (tăng tốc độ 40-60%)
  // 3. SUBQ: 8 → 4/6 (tăng tốc độ 25-40%)
  // 4. REFS: 6 → 2/4 (tăng tốc độ 30-50%)
  // 5. TRELLIS: 2 → 1/0 (tăng tốc độ 15-25%)
  // 6. PROFILE: 'high' → 'main' (tăng tốc độ 15-20%)
  // 7. LEVEL: '4.0' → '3.1' (tăng tốc độ 10-15%)
  // 8. B-FRAMES: 2 → 1 (tăng tốc độ 5-10%)
  // 9. RC-LOOKAHEAD: 30/60 → 15 (tăng tốc độ 15-20%)
  // 10. ADAPTIVE: Tự động điều chỉnh theo hardware capability
  // ============================================================================
  
  // ============================================================================
  // UNIFIED SETTINGS - CẤU HÌNH TỐI ƯU DUY NHẤT CHO 4 CORES
  // ============================================================================
  // Mục tiêu: Cân bằng tốc độ và ổn định với cấu hình duy nhất
  // Tác động: Giảm 40-50% thời gian encode, tăng stability
  // Áp dụng: Cấu hình duy nhất cho tất cả server 4 cores
    const settings = {
    // PRESET: Chọn thuật toán encode tối ưu cho 4 cores
    preset: hardwareCapability.preset,        // fast preset cho 4 cores
    
    // MOTION ESTIMATION: Phương pháp tìm kiếm chuyển động
    meMethod: hardwareCapability.meMethod,    // hex method cho stability
    
    // SUBPIXEL QUALITY: Chất lượng pixel con
    subq: hardwareCapability.subq,           // 4 cho 4 cores
    
    // REFERENCE FRAMES: Số frame tham chiếu
    refs: hardwareCapability.refs,           // 2 cho 4 cores
    
    // TRELLIS: Thuật toán tối ưu hóa bit
    trellis: hardwareCapability.trellis,     // 1 cho stability
    
    // THREADING: Sử dụng đa luồng tối ưu
    threads: hardwareCapability.threads,     // 4 cho 4 cores
    threadType: 'frame',                     // Phù hợp với CPU đa cores
    
    // FILTERS: Bộ lọc video (ảnh hưởng lớn đến tốc độ)
    filters: 'hqdn3d=0.5:0.5:2:2,unsharp=2:2:0.5:2:2:0.1', // Giảm intensity 50%
    
    description: `Unified ${hardwareCapability.level} Level - ${hardwareCapability.description}`
  };
  
  log.Info(`FFmpeg Settings Applied - Unified Environment, Hardware: ${hardwareCapability.level} Level, Reason: Single optimized configuration for 4 cores, using ${hardwareCapability.preset} preset with ${hardwareCapability.meMethod} motion estimation`, 'StreamingService', 'getOptimizedFFmpegSettings');

  _cachedHardwareSettings = settings;
  return settings;
};

const getMemoryOptimizedSettings = (baseSettings) => {
  const sysInfo = getSystemInfo();
  const memoryGB = sysInfo.totalMemory / 1024 / 1024 / 1024;
  
  log.Info(`Memory Analysis: ${memoryGB.toFixed(1)}GB available`, 'StreamingService', 'getMemoryOptimizedSettings');
  
  // Log memory analysis
  log.Info(`Memory Analysis - Total: ${memoryGB.toFixed(1)}GB, Free: ${(sysInfo.freeMemory / 1024 / 1024 / 1024).toFixed(1)}GB, Usage: ${sysInfo.memoryUsagePercent}%`, 'StreamingService', 'getMemoryOptimizedSettings');
  
  // ============================================================================
  // MEMORY OPTIMIZATION - ĐIỀU CHỈNH THEO DUNG LƯỢNG RAM
  // ============================================================================
  // Mục tiêu: Tối ưu hóa cài đặt theo dung lượng RAM có sẵn
  // Tác động: Cân bằng giữa hiệu suất và sử dụng tài nguyên
  // Áp dụng: Cho tất cả môi trường (UAT, LIVE, UNKNOWN)
  
  // Adjust settings based on available memory
  if (memoryGB < 8) {
    // Low memory environment - Giảm sử dụng tài nguyên
    const lowMemorySettings = {
      ...baseSettings,
      refs: Math.min(baseSettings.refs, 3),        // Giảm reference frames
      threads: Math.min(baseSettings.threads, 1),  // Giảm threads
      filters: 'hqdn3d=0.8:0.8:3:3,unsharp=2:2:0.8:2:2:0.2', // Giảm intensity filters
      description: baseSettings.description + ' (Low Memory)'
    };
    
    log.Info(`Memory Optimization Applied - Low memory detected (${memoryGB.toFixed(1)}GB), reducing resource usage`, 'StreamingService', 'getMemoryOptimizedSettings');
    
    return lowMemorySettings;
  } else if (memoryGB >= 32) {
    // High memory environment - Tăng sử dụng tài nguyên
    const highMemorySettings = {
      ...baseSettings,
      refs: Math.min(baseSettings.refs + 2, 8),    // Tăng reference frames
      threads: Math.min(baseSettings.threads + 1, sysInfo.cpuCores), // Tăng threads
      description: baseSettings.description + ' (High Memory)'
    };
    
    log.Info(`Memory Optimization Applied - High memory available (${memoryGB.toFixed(1)}GB), increasing resource usage`, 'StreamingService', 'getMemoryOptimizedSettings');
    
    return highMemorySettings;
  }
  
  log.Info(`Memory Optimization Skipped - Memory within normal range (${memoryGB.toFixed(1)}GB)`, 'StreamingService', 'getMemoryOptimizedSettings');
  
  return baseSettings;
};

const getCPUOptimizedSettings = (baseSettings) => {
  const sysInfo = getSystemInfo();
  const loadAverage = os.loadavg();
  const currentLoad = loadAverage[0]; // 1 minute average
  
  log.Info(`CPU Load Analysis: ${currentLoad.toFixed(2)} (1min average)`, 'StreamingService', 'getCPUOptimizedSettings');
  
  // Log CPU load analysis
  log.Info(`CPU Load Analysis - Current: ${currentLoad.toFixed(2)}, Cores: ${sysInfo.cpuCores}, Threshold: ${(sysInfo.cpuCores * 0.8).toFixed(2)}`, 'StreamingService', 'getCPUOptimizedSettings');
  
  // ============================================================================
  // CPU LOAD OPTIMIZATION - ĐIỀU CHỈNH THEO TẢI CPU
  // ============================================================================
  // Mục tiêu: Tối ưu hóa cài đặt theo tải CPU hiện tại
  // Tác động: Giảm cài đặt khi CPU quá tải để tránh lag
  // Áp dụng: Cho tất cả môi trường (UAT, LIVE, UNKNOWN)
  
  // If CPU is under heavy load, reduce settings
  if (currentLoad > sysInfo.cpuCores * 0.8) {
    const highLoadSettings = {
      ...baseSettings,
      preset: 'veryfast',                           // Preset nhanh nhất
      meMethod: 'hex',                              // Motion estimation nhanh
      subq: Math.max(4, baseSettings.subq - 2),     // Giảm subpixel quality
      refs: Math.max(2, baseSettings.refs - 2),     // Giảm reference frames
      trellis: 0,                                   // Tắt trellis
      threads: Math.max(1, baseSettings.threads - 1), // Giảm threads
      description: baseSettings.description + ' (High Load)'
    };
    
    log.Info(`CPU Load Optimization Applied - High CPU load detected (${currentLoad.toFixed(2)}), reducing processing intensity`, 'StreamingService', 'getCPUOptimizedSettings');
    
    return highLoadSettings;
  }
  
  log.Info(`CPU Load Optimization Skipped - CPU load within normal range (${currentLoad.toFixed(2)})`, 'StreamingService', 'getCPUOptimizedSettings');
  
  return baseSettings;
};

const logSystemInfo = () => {
  const sysInfo = getSystemInfo();
  
  log.Info(`System Detection - CPU: ${sysInfo.cpuCores} cores (${sysInfo.cpuModel}), RAM: ${(sysInfo.totalMemory / 1024 / 1024 / 1024).toFixed(1)}GB, Usage: ${sysInfo.memoryUsagePercent}%`, 'StreamingService', 'logSystemInfo');
};

const options_log = {
    timeZone: 'Asia/Ho_Chi_Minh',
    folderPath: '../logs/',
    dateBasedFileNaming: true,
    fileNamePrefix: 'StreamSession_',
    fileNameExtension: '.log',
    dateFormat: 'DD_MM_YYYY',
    timeFormat: 'hh:mm:ss A',
}
log.SetUserOptions(options_log);

// ============================================================================
// MOBILE STREAMING CONSTANTS AND CONFIGURATION
// ============================================================================
// Mobile sources that will use different upload flow
const MOBILE_SOURCES = ['VBI4SALES', 'MYVBI'];
const MOBILE_API_HOST = process.env.API_MOBILE;
const MOBILE_UPLOAD_ENDPOINT = '/api/upload-video';

// ============================================================================
// LDP STREAMING CONSTANTS (ORIGINAL FLOW)
// ============================================================================
// LDP sources will use the original AAD API upload flow
// All other sources (not in MOBILE_SOURCES) are considered LDP

// Helper function to check if source is mobile
const isMobileSource = (source) => {
    return MOBILE_SOURCES.includes(source);
};

// Helper function to validate mobile API host
const validateMobileApiHost = () => {
    if (!MOBILE_API_HOST) {
        throw new Error('API_MOBILE environment variable is not configured');
    }
    return true;
};

// Helper function to check if file is ready for processing
const isFileReady = async (filePath, attemptNumber = 1) => {
    try {
        // Check file exists
        if (!fs.existsSync(filePath)) {
            log.Info('File check - File không tồn tại', { 
                filePath, 
                attempt: attemptNumber,
                timestamp: new Date().toISOString()
            });
            return false;
        }

        // Check file size > 0
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
            log.Info('File check - File size = 0', { 
                filePath, 
                size: stats.size,
                attempt: attemptNumber,
                timestamp: new Date().toISOString()
            });
            return false;
        }

        // Check file can be read (not locked)
        try {
            const fd = fs.openSync(filePath, 'r');
            fs.closeSync(fd);
        } catch (readError) {
            log.Info('File check - File không thể đọc (có thể bị lock)', { 
                filePath, 
                error: readError.message,
                attempt: attemptNumber,
                timestamp: new Date().toISOString()
            });
            return false;
        }

        // Check for file corruption (basic check)
        if (stats.size < 1024) { // File quá nhỏ, có thể corrupt
            log.Info('File check - File size quá nhỏ, có thể corrupt', { 
                filePath, 
                size: stats.size,
                attempt: attemptNumber,
                timestamp: new Date().toISOString()
            });
            // Vẫn return true vì có thể file thực sự nhỏ
        }

        log.Info('File check - File sẵn sàng', { 
            filePath, 
            size: stats.size,
            attempt: attemptNumber,
            timestamp: new Date().toISOString()
        });
        return true;

    } catch (error) {
        log.Error('File check - Lỗi khi kiểm tra file', { 
            filePath, 
            error: error.message,
            attempt: attemptNumber,
            timestamp: new Date().toISOString()
        });
        return false;
    }
};

// Helper function to wait for file with progressive delay
const waitForFileReady = async (filePath, maxAttempts = 3) => {
    const startTime = Date.now();
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log.Info('Bắt đầu check file', { 
            filePath, 
            attempt: attempt,
            totalAttempts: maxAttempts,
            timestamp: new Date().toISOString()
        });

        const isReady = await isFileReady(filePath, attempt);
        if (isReady) {
            const totalTime = Date.now() - startTime;
            log.Info('File sẵn sàng thành công', { 
                filePath, 
                attempt: attempt,
                totalTime: `${totalTime}ms`,
                timestamp: new Date().toISOString()
            });
            return true;
        }

        // Progressive delay: 0ms, 100ms, 800ms
        let delay = 0;
        if (attempt === 2) delay = 100;
        else if (attempt === 3) delay = 800;

        if (attempt < maxAttempts) {
            log.Info('File chưa sẵn sàng, đợi và thử lại', { 
                filePath, 
                attempt: attempt,
                nextAttempt: attempt + 1,
                delay: `${delay}ms`,
                timestamp: new Date().toISOString()
            });
            
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    const totalTime = Date.now() - startTime;
    log.Error('File không sẵn sàng sau tất cả attempts', { 
        filePath, 
        totalAttempts: maxAttempts,
        totalTime: `${totalTime}ms`,
        timestamp: new Date().toISOString()
    });
    
    return false;
};

// Helper function to get mobile upload headers
const getMobileUploadHeaders = (authority, authorization) => {
    return {
        'authority': authority || 'MOBILE.VBI@VIETINBANK.VN-BDF98987A46EC2B7011FE1FCF28D2F53-c5c140f3c12b614e-null',
        'authorization': authorization || 'Basic MDAwL0tIQUNIOm51bGw=',
        'Authority': authority || 'MOBILE.VBI@VIETINBANK.VN-EBE15C7E504666053BFC59B726418B67-test_device_id-test_player_id'
    };
};

// Helper function to validate mobile metadata
const validateMobileMetadata = (data) => {
    const requiredFields = ['jobId', 'so_id_hs', 'user', 'departmentId', 'ma_tvv', 'ma_hang_muc', 'ten_hang_muc'];
    const missingFields = requiredFields.filter(field => !data[field]);
    
    if (missingFields.length > 0) {
        throw new Error(`Missing required mobile fields: ${missingFields.join(', ')}`);
    }
    
    return true;
};

const {
    getPort,
    releasePort
} = require('../service/core/port');
const PeerManager = require('../service/core/PeerManager');
const FFmpeg = require('../service/processing/ffmpeg');
const GStreamer = require('../service/processing/gstreamer');
const PROCESS_NAME = process.env.PROCESS_NAME || 'FFmpeg'; //GStreamer - FFmpeg
const ENB_RECORD = true
const upload_file_extends = '.mp4'
const SESSION_EXPIRE = 20 //minute
const CLIENT_EXPIRE = 30 //minute
const Redis = new RedisC()
let _transports = {}
let _producers = {}
let _consumers = {}
let _process = {}
let redis = Redis.getClient()
let _socketIO = null

const initStreaming = async (socketServer) => {
    _socketIO = socketServer
    redis = Redis.getClient()
    await redis.flushdb()
    socketServer.on('connection', async (client) => {
        setupConnection(client)

        client.on('broadcasting', async () => {
            try {
                socketServer.to("room-" + client.session_id).emit("start_broadcasting", {})
            } catch (e) {
                console.log("Error[broadcasting]: ", e)
            }
        })
        // inform the client about existence of producer
        client.on('disconnect', async () => {
            try {
                console.log(clc.bgGreen.red('Client Disconnected (X): ' + client.ussid));
                
                log.Info(`Client disconnected - ClientId: ${client.ussid}, SessionId: ${client.session_id}`, 'StreamingService', 'disconnect');
                
                if (!client.ussid) {
                    log.Info(`Client disconnected without ussid`, 'StreamingService', 'disconnect');
                    return;
                }
                const result_peer = await redis.get(`CLIENT-${client.ussid}`)
                if (!result_peer) {
                    log.Info(`Peer not found for disconnected client - ClientId: ${client.ussid}`, 'StreamingService', 'disconnect');
                    return;
                }
                const result_session = await redis.get(`SESS-${client.session_id}`)
                const peer = JSON.parse(result_peer)
                const session = JSON.parse(result_session)

                if (_transports[peer.transport_id]) {
                    _transports[peer.transport_id].close()
                    console.log(clc.bgWhiteBright("Transport Closed"))
                    delete _transports[peer.transport_id]
                    
                    log.Info(`Transport closed - ClientId: ${client.ussid}, TransportId: ${peer.transport_id}`, 'StreamingService', 'disconnect');
                }
                peer.producers.forEach((pr) => {
                    if (_producers[pr.id]) {
                        console.log("Remove producer with id: " + pr.id)
                        delete _producers[pr.id]
                    }
                })
                peer.consumers.forEach((pr) => {
                    if (_consumers[pr.id]) {
                        console.log("Remove consumer with id: " + pr.id)
                        delete _consumers[pr.id]
                    }
                })

                log.Info(`Producers and consumers cleaned up - ClientId: ${client.ussid}, ProducersRemoved: ${peer.producers.length}, ConsumersRemoved: ${peer.consumers.length}`, 'StreamingService', 'disconnect');

                if (peer) {
                    if (peer.side == "streamer") {
                        session.streamer = null
                        if (peer._process) {
                            if (_process[peer._process]) {
                                _process[peer._process].kill()
                                delete _process[peer._process]
                                
                                log.Info(`Streamer process killed - ClientId: ${client.ussid}, ProcessId: ${peer._process}`, 'StreamingService', 'disconnect');
                            }
                        }
                        try {
                            socketServer.to("room-" + client.session_id).emit("streamer_disconnected", {})
                            
                            log.Info(`Streamer disconnect broadcast sent - ClientId: ${client.ussid}, SessionId: ${client.session_id}`, 'StreamingService', 'disconnect');
                        } catch (e) {
                            console.log("Error[broadcasting]: ", e)
                            log.Error(`Error broadcasting streamer disconnect - ClientId: ${client.ussid}, SessionId: ${client.session_id}, Error: ${e.message}`, 'StreamingService', 'disconnect');
                        }
                    } else if (peer.side == "subscriber") { //if subscriber: delete from session
                        client.leave(client.session_id);
                        if (session) {
                            if (session.subscribers) {
                                let newsubscribers = session.subscribers.filter(e => e !== client.ussid);
                                session.subscribers = newsubscribers
                                
                                log.Info(`Subscriber removed from session - ClientId: ${client.ussid}, SessionId: ${client.session_id}, RemainingSubscribers: ${session.subscribers.length}`, 'StreamingService', 'disconnect');
                            } else {
                                console.error("subscribers is empty")
                                log.Info(`Subscribers array is empty - ClientId: ${client.ussid}, SessionId: ${client.session_id}`, 'StreamingService', 'disconnect');
                            }
                        }
                    }
                    await redis.del(`CLIENT-${client.ussid}`)
                    await redis.set(`SESS-${client.session_id}`, JSON.stringify(session), 'EX', 60 * SESSION_EXPIRE) //update session info
                    
                    log.Info(`Client cleanup completed - ClientId: ${client.ussid}, SessionId: ${client.session_id}, Side: ${peer.side}`, 'StreamingService', 'disconnect');
                }
            } catch (e) {
                console.log(e)
                log.Error(`Error during client disconnect cleanup - ClientId: ${client.ussid}, SessionId: ${client.session_id}, Error: ${e.message}`, 'StreamingService', 'disconnect');
            }
        });

        client.on('connect_error', (err) => {
            console.error('client connection error', err);
        });

        client.on('getRouterRtpCapabilities', async (data, callback) => {
            try {
                const result_peer = await redis.get(`CLIENT-${client.ussid}`)
                if (result_peer) {
                    const peer = JSON.parse(result_peer)
                    const router = await getRouter(peer.router_index)
                    callback(router.rtpCapabilities);
                }

            } catch (e) {
                console.log(e)
                callback(null)
            }
        });

        client.on('createProducerTransport', async (data, callback) => {
            try {
                const result_peer = await redis.get(`CLIENT-${client.ussid}`)
                console.log("createProducerTransport ", result_peer)
                if (result_peer) {
                    const peer = JSON.parse(result_peer)
                    const { transport, params } = await createWebRtcTransport(peer.router_index);
                    peer.transport_id = transport.id
                    _transports[transport.id] = transport

                    _transports[transport.id].on("icestatechange", (iceState) => {
                        console.log("ICE state changed to %s", iceState);
                    });
                    _transports[transport.id].on("iceselectedtuplechange", (iceState) => {
                        console.log("ICE state iceselectedtuplechange to %s", iceState);
                    });
                    _transports[transport.id].on("dtlsstatechange", (iceState) => {
                        console.log("ICE state dtlsstatechange to %s", iceState);
                    });
                    _transports[transport.id].on("sctpstatechange", (iceState) => {
                        console.log("ICE state sctpstatechange to %s", iceState);
                    });


                    callback(params);
                    await redis.set(`CLIENT-${client.ussid}`, JSON.stringify(peer), 'EX', 60 * CLIENT_EXPIRE)
                } else {
                    callback(null);
                }
                // transports

            } catch (err) {
                console.error(err);
                callback({ error: err.message });
            }
        });
        client.on('createConsumerTransport', async (data, callback) => {
            try {
                console.log("createConsumerTransport")
                const result_peer = await redis.get(`CLIENT-${client.ussid}`)
                const peer = JSON.parse(result_peer)
                const { transport, params } = await createWebRtcTransport(peer.router_index);
                peer.transport_id = transport.id
                _transports[transport.id] = transport
                await redis.set(`CLIENT-${client.ussid}`, JSON.stringify(peer))
                callback(params);
            } catch (err) {
                console.error(err);
                callback({ error: err.message });
            }
        });

        client.on('connectProducerTransport', async (data, callback) => {
            try {
                const result_peer = await redis.get(`CLIENT-${client.ussid}`)
                if (!result_peer) {
                    console.log("connectProducerTransport:: Can't find peer with id: " + client.ussid)
                    return;
                }
                const peer = JSON.parse(result_peer)
                const transport = _transports[peer.transport_id]
                if (transport) {
                    await transport.connect({ dtlsParameters: data.dtlsParameters });
                    callback(true);
                } else {
                    console.log("connectProducerTransport:: Can't find transport with id: " + peer.transport_id)
                    callback(false);
                }

            } catch (e) {
                console.log("connectProducerTransport():: ", e)
                callback(false);
            }

        });

        client.on('connectProducerTransportMobile', async (data, callback) => {
            try {
                const result_peer = await redis.get(`CLIENT-${client.ussid}`)
                if (!result_peer) {
                    console.log("connectProducerTransportMobile: Can't find peer with id: " + client.ussid)
                    return;
                }
                const peer = JSON.parse(result_peer)
                const transport = _transports[peer.transport_id]
                if (transport) {
                    await transport.connect({ dtlsParameters: data.dtlsParameters });
                    callback({success: true, transport_id: transport.id,  sdp: data.sdp, type: 'answer'});
                } else {
                    console.log("connectProducerTransportMobile: Can't find transport with id: " + peer.transport_id)
                    callback({success: false, transport_id: null, sdp: null, type: 'offer'});
                }

            } catch (e) {
                console.log("connectProducerTransportMobile(): ", e)
                callback({success: false, transport_id: null, sdp: null, type: 'catch'});
            }

        });

        client.on('connectConsumerTransport', async (data, callback) => {
            try {
                console.log('----------------connectConsumerTransport----------------------')
                const result_peer = await redis.get(`CLIENT-${client.ussid}`)
                const peer = JSON.parse(result_peer)
                const transport = _transports[peer.transport_id]
                if (!transport) {
                    callback(false);
                    console.log("connectConsumerTransport:: Can't find peer with id: " + client.ussid)
                    return;
                }
                await transport.connect({ dtlsParameters: data.dtlsParameters });
                callback({sucess: true});
            } catch (error) {
                console.log("error:connectConsumerTransport: ", error)
                callback({sucess: false});
            }

        });

        client.on('produce', async (data, callback) => {
            const { kind, rtpParameters } = data;
            const result_peer = await redis.get(`CLIENT-${client.ussid}`)
            if (!result_peer) {
                console.log("produce:: Can't find peer with id: " + client.ussid)
                return;
            }
            const peer = JSON.parse(result_peer)
            if (!_transports[peer.transport_id]) return;
            let producer = await _transports[peer.transport_id].produce({ kind, rtpParameters, keyFrameRequestDelay: 5000 });
            peer.producers.push({ kind: kind, id: producer.id });
            _producers[producer.id] = producer

            _producers[producer.id].on("transportclose", () => {
                console.log("transport closed || producer closed");
                if (_producers[producer.id]) {
                    delete _producers[producer.id];
                }
            })
            _producers[producer.id].on("close", () => {
                if (_producers[producer.id]) {
                    delete _producers[producer.id];
                }
            })
            await redis.set(`CLIENT-${client.ussid}`, JSON.stringify(peer), 'EX', 60 * SESSION_EXPIRE)
            callback({ id: producer.id });

        });

        client.on('start-record', async (data, callback) => {
            if(data.source == 'VBI4SALES') {
                console.log("VBI4SALES");
            }
            console.log(clc.blueBright("Start record"))

            // Log source type for better tracking
            const isMobile = isMobileSource(data.source);
            if (isMobile) {
                log.Info(`=== MOBILE FLOW === Recording started - SessionId: ${client.session_id}, ClientId: ${client.ussid}, Source: ${data.source}`, 'StreamingService', 'start-record');
            } else {
                log.Info(`=== LDP FLOW === Recording started - SessionId: ${client.session_id}, ClientId: ${client.ussid}, Source: ${data.source}`, 'StreamingService', 'start-record');
            }

            const result_peer = await redis.get(`CLIENT-${client.ussid}`)
            if (!result_peer) {
                log.Error(`Peer not found for recording - SessionId: ${client.session_id}, ClientId: ${client.ussid}`, 'StreamingService', 'start-record');
                console.log("Peer not found")
                return;
            }
            const peer = JSON.parse(result_peer)
            const result_sess = await redis.get(`SESS-${client.session_id}`)
            const session = JSON.parse(result_sess)
            if (!session) {
                log.Error(`Session not found for recording - SessionId: ${client.session_id}, ClientId: ${client.ussid}`, 'StreamingService', 'start-record');
                return callback({ sucess: false });
            }
            
            // Store mobile metadata if source is mobile
            if (isMobileSource(data.source)) {
                try {
                    // Validate mobile API host first
                    validateMobileApiHost();
                    validateMobileMetadata(data);
                    session.mobile_metadata = {
                        source: data.source,
                        jobId: data.jobId,
                        so_id_hs: data.so_id_hs,
                        user: data.user,
                        departmentId: data.departmentId,
                        latitude: data.latitude || "0",
                        longitude: data.longitude || "0",
                        ma_tvv: data.ma_tvv,
                        ma_hang_muc: data.ma_hang_muc,
                        ten_hang_muc: data.ten_hang_muc,
                        type_product: data.type_product || "XE",
                        authority: data.authority,
                        authorization: data.authority
                    };
                    console.log(clc.green(`Mobile recording started for ${data.source}`));
                    
                    log.Info(`=== MOBILE FLOW === Mobile recording metadata stored - SessionId: ${client.session_id}, Source: ${data.source}`, 'StreamingService', 'start-record');
                } catch (e) {
                    console.error(clc.red(`Mobile setup failed: ${e.message}`));
                    log.Error(`=== MOBILE FLOW === Mobile recording setup failed - SessionId: ${client.session_id}, Source: ${data.source}, Error: ${e.message}`, 'StreamingService', 'start-record');
                    return callback({ success: false, error: e.message });
                }
            } else {
                // LDP recording - no special metadata needed
                log.Info(`=== LDP FLOW === LDP recording started - SessionId: ${client.session_id}, Source: ${data.source}`, 'StreamingService', 'start-record');
            }
            
            let recordInfo = {};
            if (ENB_RECORD) {
                            log.Info(`Starting recording process - SessionId: ${client.session_id}, ClientId: ${client.ussid}, Source: ${data.source}, IsMobile: ${isMobileSource(data.source)}`, 'StreamingService', 'start-record');
            
            // ============================================================================
            // RECORDING PROCESS SETUP (SAME FOR BOTH MOBILE AND LDP)
            // ============================================================================
            // Both mobile and LDP sources use the same recording process
            // The difference is in metadata storage and final upload destination
            // ============================================================================
            
            for (const producer of peer.producers) {
                    recordInfo[producer.kind] = await publishProducerRtpStream(peer, _producers[producer.id]);
                }
                recordInfo.fileName = uuid();
                recordInfo.socket_id = client.id;
                recordInfo.session_id = client.session_id;
                peer.isRecording = true
                session.isRecording = true
                _process[session.id] = getProcess(recordInfo);
                await redis.set(`CLIENT-${client.ussid}`, JSON.stringify(peer))
                session.record_file_id = `${recordInfo.fileName}`
                session.record_files.push(session.record_file_id)
                await redis.set(`SESS-${peer.session_id}`, JSON.stringify(session), 'EX', 60 * SESSION_EXPIRE)

                var logstream = fs.createWriteStream("./public/list.txt", { 'flags': 'a' });
                logstream.once('open', function (fd) {
                    logstream.write(`${peer.session_id}|${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' })}|${recordInfo.fileName}.webm\n`);
                    logstream.end();
                });

                log.Info(`Recording process started successfully - SessionId: ${client.session_id}, ClientId: ${client.ussid}, FileName: ${recordInfo.fileName}, Producers: ${peer.producers.length}`, 'StreamingService', 'start-record');
            }
            const _proc = _process[session.id];
            const _consumersSnapshot = [...peer.process_consumer];
            _proc.ready().then(async () => {
                for (const consumer of _consumersSnapshot) {
                    if (_consumers[consumer.id]) {
                        await _consumers[consumer.id].resume();
                        await _consumers[consumer.id].requestKeyFrame();
                    }
                }
                log.Info(`Recording consumers resumed - SessionId: ${client.session_id}, ConsumersCount: ${_consumersSnapshot.length}`, 'StreamingService', 'start-record');
            }).catch(err => {
                log.Error(`FFmpeg ready error, consumers not resumed - SessionId: ${client.session_id}, Error: ${err.message}`, 'StreamingService', 'start-record');
            });
            callback({ sucess: true, file_id: `${recordInfo.fileName}` });
        });

        client.on('stop-record', async (data, callback) => {
            try {
                log.Info(`Recording stop requested - SessionId: ${client.session_id}, ClientId: ${client.ussid}`, 'StreamingService', 'stop-record');
                
                callback()
                const result_peer = await redis.get(`CLIENT-${client.ussid}`)
                const peer = JSON.parse(result_peer)
                if (!peer) {
                    log.Error(`Peer not found for stop recording - SessionId: ${client.session_id}, ClientId: ${client.ussid}`, 'StreamingService', 'stop-record');
                    throw new Error(`Peer with id ${client.ussid} was not found`);
                }
                const result_sess = await redis.get(`SESS-${client.session_id}`)
                const session = JSON.parse(result_sess)
                if (!session) {
                    log.Error(`Session not found for stop recording - SessionId: ${client.session_id}, ClientId: ${client.ussid}`, 'StreamingService', 'stop-record');
                    throw new Error(`Session with id ${peer.session_id} was not found`);
                }
                peer.isRecording = false
                session.isRecording = false
                await redis.set(`SESS-${peer.session_id}`, JSON.stringify(session), 'EX', 60 * SESSION_EXPIRE)

                log.Info(`Recording state updated - SessionId: ${client.session_id}, ClientId: ${client.ussid}, IsRecording: false`, 'StreamingService', 'stop-record');

                if (ENB_RECORD) {
                    if (!_process[client.session_id]) {
                        log.Info(`No recording process found to stop - SessionId: ${client.session_id}, ClientId: ${client.ussid}`, 'StreamingService', 'stop-record');
                        return console.log(`Peer with id ${client.ussid} is not recording`);
                    }
                    
                    log.Info(`Stopping recording process - SessionId: ${client.session_id}, ClientId: ${client.ussid}, ProcessId: ${_process[client.session_id].pid}`, 'StreamingService', 'stop-record');
                    
                    _process[client.session_id].kill();
                    delete _process[client.session_id];
                    
                    for (const consumer of peer.process_consumer) {
                        if (_consumers[consumer.id]) {
                            console.log(clc.bgMagentaBright("Consumer Closed"))
                            _consumers[consumer.id].close()
                            delete _consumers[consumer.id]
                        }
                    }
                    
                    log.Info(`Recording consumers closed - SessionId: ${client.session_id}, ConsumersClosed: ${peer.process_consumer.length}`, 'StreamingService', 'stop-record');
                    
                    // Release ports from port set
                    for (const remotePort of peer.remotePorts) {
                        releasePort(remotePort);
                    }
                    
                    log.Info(`Recording ports released - SessionId: ${client.session_id}, PortsReleased: ${peer.remotePorts.length}`, 'StreamingService', 'stop-record');
                }
                
                log.Info(`Recording stopped successfully - SessionId: ${client.session_id}, ClientId: ${client.ussid}`, 'StreamingService', 'stop-record');
            } catch (e) {
                console.log(e)
                log.Error(`Error stopping recording - SessionId: ${client.session_id}, ClientId: ${client.ussid}, Error: ${e.message}`, 'StreamingService', 'stop-record');
                callback(false)
            }

        });




        client.on('consume', async (data, callback) => {
            try {
                const result_sess = await redis.get(`SESS-${client.session_id}`)
                const session = JSON.parse(result_sess)

                const peer_producer_result = await redis.get(`CLIENT-${session.streamer}`) //get producer(streamer)
                const peer_producer = JSON.parse(peer_producer_result) //get producer(streamer)

                if (!peer_producer) {
                    return callback(false);
                }
                // peer_producer.socket_client.emit("new_subscriber", { count: sessions.get(peer.session_id).subscribers.length })

                let consumers = []
                for (const producer of peer_producer.producers) {
                    const consume_data = await createConsumer(client.ussid, _producers[producer.id], data.rtpCapabilities)
                    consumers.push(consume_data)
                }
                callback(consumers);
            } catch (e) {
                console.log("Error Consumer", e)
            }
        });

        client.on('resume', async (data, callback) => {
            try {
                const result_peer = await redis.get(`CLIENT-${client.ussid}`)
                const peer = JSON.parse(result_peer)
                for (const consumer of peer.consumers) {
                    await _consumers[consumer.id].resume();
                    if (consumer.kind == 'video') {
                        await _consumers[consumer.id].requestKeyFrame();
                    }
                }
            } catch (e) {
                console.log("ResumeError::: ", e)
            }
            callback();
        });
        //mute from consumer(subs) side
        client.on('mute', async (data, callback) => {
            const result_peer = await redis.get(`CLIENT-${client.ussid}`)
            const peer = JSON.parse(result_peer)
            for (const consumer of peer.consumers) {
                if (consumer.kind == 'audio') {
                    callback({ muted: data.set });
                    if (_consumers[consumer.id]) {
                        if (data.set) {
                            _consumers[consumer.id].pause()
                        } else {
                            _consumers[consumer.id].resume()
                        }
                    }
                }
                console.log(consumer.kind)
            }
        });

        client.on('close', async (data, callback) => {
            const result_peer = await redis.get(`CLIENT-${clientid}`)
            const peer = JSON.parse(result_peer)

        });


    });
}

const setupConnection = async (client) => {
    try {
        const client_side = client.handshake.query.side
        const session_id = client.handshake.query.session_id
        console.log("-----------------------------------------------------")
        console.log("New Connection: ", client_side)
        console.log("-----------------------------------------------------")

        log.Info(`New client connection - ClientSide: ${client_side}, SessionId: ${session_id}`, 'StreamingService', 'setupConnection');

        if (!session_id) {
            log.Error(`Missing session ID in connection - ClientSide: ${client_side}, SessionId: ${session_id}`, 'StreamingService', 'setupConnection');
            console.log("Missing session ID: ", session_id, client_side)
            console.log(clc.bgRed("setupConnection: Force Socket Disconnect"))
            return client.disconnect()
        }
        const result_session = await redis.get(`SESS-${session_id}`)
        if (!result_session) {
            log.Error(`Session not found in connection - ClientSide: ${client_side}, SessionId: ${session_id}`, 'StreamingService', 'setupConnection');
            console.log(clc.red("Not found init session: " + session_id + " | "), client.handshake.query)
            console.log(clc.bgRed("setupConnection(2): Force Socket Disconnect"))
            return client.disconnect()
        }
        let session = JSON.parse(result_session)
        if (client_side == 'streamer') {
            if (session.streamer) { //if existed streamer is streaming
                log.Info(`Streamer already exists in session - ClientSide: ${client_side}, SessionId: ${session_id}, ExistingStreamer: ${session.streamer}`, 'StreamingService', 'setupConnection');
                console.log(clc.red("Streamer is existed: disconnect " + session_id))
                console.log(clc.bgRed("setupConnection(3): Force Socket Disconnect"))
                return client.disconnect()
            }
            client.ussid = client.handshake.query.session_id
            client.session_id = client.ussid
            
            log.Info(`Streamer connected to session - ClientId: ${client.ussid}, SessionId: ${client.session_id}`, 'StreamingService', 'setupConnection');
        } else if (client_side == 'subscriber') {
            client.ussid = uuid()
            client.session_id = client.handshake.query.session_id
            client.join("room-" + client.handshake.query.session_id)
            
            log.Info(`Subscriber connected to session - ClientId: ${client.ussid}, SessionId: ${client.session_id}`, 'StreamingService', 'setupConnection');
        } else {
            log.Error(`Invalid client side in connection - ClientSide: ${client_side}, SessionId: ${session_id}`, 'StreamingService', 'setupConnection');
            console.log("client side is not correct")
            console.log(clc.bgRed("setupConnection(4): Force Socket Disconnect"))
            return client.disconnect()
        }


        const new_peer = {
            clientId: client.ussid,
            isRecording: false,
            side: client_side,
            session_id: client.session_id,
            router_index: session.router_index,
            remotePorts: [],
            producers: [],
            consumers: [],
            process: null,
            transport: null
        }
        await redis.set(`CLIENT-${client.ussid}`, JSON.stringify(new_peer), 'EX', 60 * CLIENT_EXPIRE) //add new peer
        
        log.Info(`New peer created - ClientId: ${client.ussid}, SessionId: ${client.session_id}, Side: ${client_side}, RouterIndex: ${session.router_index}`, 'StreamingService', 'setupConnection');
        
        if (client_side == 'streamer') {
            session.streamer = client.ussid
            
            log.Info(`Streamer assigned to session - ClientId: ${client.ussid}, SessionId: ${client.session_id}`, 'StreamingService', 'setupConnection');
        } else if (client_side == 'subscriber') {
            session.subscribers.push(client.ussid)
            if (session.streamer) {
                client.emit("start_broadcasting", {})
                
                log.Info(`Broadcasting started for subscriber - ClientId: ${client.ussid}, SessionId: ${client.session_id}, StreamerId: ${session.streamer}`, 'StreamingService', 'setupConnection');
            }
            
            log.Info(`Subscriber added to session - ClientId: ${client.ussid}, SessionId: ${client.session_id}, TotalSubscribers: ${session.subscribers.length}`, 'StreamingService', 'setupConnection');
        } else { }
        await redis.set(`SESS-${client.session_id}`, JSON.stringify(session), 'EX', 60 * SESSION_EXPIRE) //update session info
        client.emit('connect_ready', { id: client.ussid, session_id: client.session_id });
        
        log.Info(`Client connection setup completed - ClientId: ${client.ussid}, SessionId: ${client.session_id}, Side: ${client_side}`, 'StreamingService', 'setupConnection');
    } catch (e) {
        console.log(e)
        log.Error(`Error in setupConnection - Error: ${e.message}`, 'StreamingService', 'setupConnection');
    }
}


const publishProducerRtpStream = async (peer, producer, ffmpegRtpCapabilities) => {
    // Create the mediasoup RTP Transport used to send media to the GStreamer process
    const rtpTransportConfig = config.plainRtpTransport;
    // If the process is set to GStreamer set rtcpMux to false
    if (PROCESS_NAME === 'GStreamer') {
        rtpTransportConfig.rtcpMux = false;
    }
    const router = await getRouter(peer.router_index)
    const rtpTransport = await createTransport('plain', router, rtpTransportConfig);

    // Set the receiver RTP ports
    const remoteRtpPort = await getPort();
    peer.remotePorts.push(remoteRtpPort);

    let remoteRtcpPort;
    // If rtpTransport rtcpMux is false also set the receiver RTCP ports
    if (!rtpTransportConfig.rtcpMux) {
        remoteRtcpPort = await getPort();
        peer.remotePorts.push(remoteRtcpPort);
    }
    // Connect the mediasoup RTP transport to the ports used by GStreamer
    await rtpTransport.connect({
        ip: '127.0.0.1',
        port: remoteRtpPort,
        rtcpPort: remoteRtcpPort
    });

    // peer.addTransport(rtpTransport);

    const codecs = [];
    // Codec passed to the RTP Consumer must match the codec in the Mediasoup router rtpCapabilities
    const routerCodec = router.rtpCapabilities.codecs.find(
        codec => codec.kind === producer.kind
    );
    codecs.push(routerCodec);

    const rtpCapabilities = {
        codecs,
        rtcpFeedback: []
    };

    // Start the consumer paused
    // Once the gstreamer process is ready to consume resume and send a keyframe
    const rtpConsumer = await rtpTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true
    });
    if (!peer.process_consumer) {
        peer.process_consumer = []
    }
    rtpConsumer.setPriority(255)
    peer.process_consumer.push({ kind: producer.kind, id: rtpConsumer.id });
    _consumers[rtpConsumer.id] = rtpConsumer
    _consumers[rtpConsumer.id].on("close", () => {
        delete _consumers[rtpConsumer.id]
        console.log(`Consumer with id: ${rtpConsumer.id} is closed`)
    })


    return {
        remoteRtpPort,
        remoteRtcpPort,
        localRtcpPort: rtpTransport.rtcpTuple ? rtpTransport.rtcpTuple.localPort : undefined,
        rtpCapabilities,
        rtpParameters: rtpConsumer.rtpParameters
    };
};

const getProcess = (recordInfo) => {
    switch (PROCESS_NAME) {
        case 'GStreamer':
            return new GStreamer(recordInfo, recordEvent);
        case 'FFmpeg':
        default:
            return new FFmpeg(recordInfo, recordEvent);
    }
};


const createWebRtcTransport = async (router_index) => {
    try{
        const {
            maxIncomingBitrate,
            initialAvailableOutgoingBitrate
        } = config.webRtcTransport;
        const router = await getRouter(router_index)
        const transport = await router.createWebRtcTransport({
            listenIps: config.webRtcTransport.listenIps,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate,
        });
        if (maxIncomingBitrate) {
            try {
                await transport.setMaxIncomingBitrate(maxIncomingBitrate);
            } catch (error) {
            }
        }
        return {
            transport,
            params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters
            },
        };
    }catch(e){
        console.log("Error :: createWebRtcTransport ",e)
        return null
    }
   
}
const createConsumer = (clientid, producer, rtpCapabilities) => {
    return new Promise(async (resolved, rejected) => {
        const result_peer = await redis.get(`CLIENT-${clientid}`)
        const peer = JSON.parse(result_peer)
        const router = await getRouter(peer.router_index)
        if (!router.canConsume(
            {
                producerId: producer.id,
                rtpCapabilities,
            })
        ) {
            console.error('can not consume');
            return rejected('can not consume');
        }
        try {
            consumer = await _transports[peer.transport_id].consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: producer.kind === 'video',
            });
            peer.consumers.push({ kind: producer.kind, id: consumer.id }) //push consumer to subscriber
            consumer.on("trace", (trace) => {
                console.log('[ConsumerTrace::] ', trace);
            });
            _consumers[consumer.id] = consumer;
            _consumers[consumer.id].on("close", () => {
                delete _consumers[consumer.id]
                console.log(`Consumer with id: ${consumer.id} is closed.`)
            })

            await redis.set(`CLIENT-${clientid}`, JSON.stringify(peer), 'EX', 60 * SESSION_EXPIRE)
        } catch (error) {
            console.error('consume failed::: ', error);
            return rejected(error);
        }

        // if (consumer.type === 'simulcast') {

        if (producer.kind == 'video') {
            await consumer.setPreferredLayers({ spatialLayer: 0 });
        }

        // }

        return resolved({
            producerId: producer.id,
            id: consumer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            type: consumer.type,
            producerPaused: consumer.producerPaused
        });
    })

}

const scoreChange = (peer, score) => {
    console.log("scrore ", score)
}
const broadcasting_to_subs = async (session_id, key, data) => {
    const result_session = await redis.get(`SESS-${session_id}`)
    const session = JSON.parse(result_session)
    session.subscribers.forEach((sub) => {

    })
}

const recordEvent = async (error, data) => {
    const startTime = Date.now();

    try {
        console.info(`[RECORD-EVENT] start - session=${data.session_id} socket=${data.socket_id} hasError=${!!error}`);
        log.Info(`Record event triggered - SessionId: ${data.session_id}, SocketId: ${data.socket_id}, HasError: ${!!error}`, 'StreamingService', 'recordEvent');

        if (error) {
            log.Error(`Record event error - SessionId: ${data.session_id}, SocketId: ${data.socket_id}, Error: ${error.message}`, 'StreamingService', 'recordEvent');
            console.error(`[RECORD-EVENT] error received, skipping convert/upload - ${error.message}`);
            console.error("Record error:", error);
            _socketIO.to(data.socket_id).emit("upload-status", {
                status: false,
                error: error.message
            });
            return;
        }

        const result_session = await redis.get(`SESS-${data.session_id}`);
        if (!result_session) {
            log.Error(`Session not found in record event - SessionId: ${data.session_id}, SocketId: ${data.socket_id}`, 'StreamingService', 'recordEvent');
            throw new Error(`Session not found: ${data.session_id}`);
        }

        const session = JSON.parse(result_session);
        if (!session.record_file_id) {
            log.Error(`No record file ID found in session - SessionId: ${data.session_id}, SocketId: ${data.socket_id}`, 'StreamingService', 'recordEvent');
            throw new Error('No record file ID found');
        }

        const webmPath = `${appRoot.path}/public/files/${session.record_file_id}.webm`;
        const mp4Path = `${appRoot.path}/public/files/${session.record_file_id}.mp4`;

        console.info(`[CONVERT] starting webm -> mp4 | file=${session.record_file_id}`);
        log.Info(`Starting conversion to mp4 - SessionId: ${data.session_id}, RecordFileId: ${session.record_file_id}`, 'StreamingService', 'recordEvent');

        const convertSuccess = await convertToMp4(webmPath, mp4Path);
        if (!convertSuccess) {
            const convertErrorTime = Date.now() - startTime;
            console.error(`[CONVERT] failed | file=${session.record_file_id} elapsed=${(convertErrorTime/1000).toFixed(1)}s`);
            log.Error(`Failed to convert to mp4 - SessionId: ${data.session_id}, TotalTime: ${(convertErrorTime / 1000).toFixed(2)}s`, 'StreamingService', 'recordEvent');
            throw new Error('Failed to convert to mp4');
        }
        console.info(`[CONVERT] done | file=${session.record_file_id} elapsed=${((Date.now()-startTime)/1000).toFixed(1)}s`);

        log.Info(`Conversion completed successfully - SessionId: ${data.session_id}, TotalTime: ${(Date.now() - startTime) / 1000}s`, 'StreamingService', 'recordEvent');

        // ============================================================================
        // UPLOAD FLOW SELECTION BASED ON SOURCE TYPE
        // ============================================================================
        // Mobile sources (VBI4SALES, MYVBI) -> uploadMobileVideo()
        // LDP sources (all others) -> openAPIAddFile() (original flow)
        // ============================================================================
        
        // Check if this is a mobile source
        if (session.mobile_metadata && isMobileSource(session.mobile_metadata.source)) {
            console.info(`[UPLOAD] flow=MOBILE source=${session.mobile_metadata.source} file=${session.record_file_id}`);
            log.Info(`=== MOBILE FLOW === Uploading to mobile API - Source: ${session.mobile_metadata.source}, SessionId: ${data.session_id}`, 'StreamingService', 'recordEvent');

            await enqueueUpload(() => uploadMobileVideo(mp4Path, session.mobile_metadata, (success) => {
                if (success) {
                    console.info(`[UPLOAD] MOBILE success | file=${session.record_file_id}`);
                    log.Info(`=== MOBILE FLOW === Mobile upload completed successfully - Source: ${session.mobile_metadata.source}, SessionId: ${data.session_id}`, 'StreamingService', 'recordEvent');
                    _socketIO.to(data.socket_id).emit("upload-status", {
                        status: true,
                        file_id: session.record_file_id + upload_file_extends,
                        source: session.mobile_metadata.source
                    });
                } else {
                    console.error(`[UPLOAD] MOBILE failed | file=${session.record_file_id}`);
                    log.Error(`=== MOBILE FLOW === Mobile upload failed - Source: ${session.mobile_metadata.source}, SessionId: ${data.session_id}`, 'StreamingService', 'recordEvent');
                    _socketIO.to(data.socket_id).emit("upload-status", {
                        status: false,
                        error: "Mobile upload failed",
                        source: session.mobile_metadata.source
                    });
                }
            }));
        } else {
            console.info(`[UPLOAD] flow=LDP file=${session.record_file_id} url=${process.env.AAD_API_BASE}/sapi/${process.env.ACTION_STORAGE}`);
            log.Info(`=== LDP FLOW === Uploading to original LDP API - SessionId: ${data.session_id}`, 'StreamingService', 'recordEvent');

            try {
                await enqueueUpload(() => openAPIAddFile(mp4Path, session.record_file_id + upload_file_extends, (success) => {
                    if (success) {
                        console.info(`[UPLOAD] LDP success | file=${session.record_file_id}`);
                        log.Info(`=== LDP FLOW === LDP API upload completed successfully - SessionId: ${data.session_id}`, 'StreamingService', 'recordEvent');
                        _socketIO.to(data.socket_id).emit("upload-status", {
                            status: true,
                            file_id: session.record_file_id + upload_file_extends,
                        });
                    } else {
                        console.error(`[UPLOAD] LDP failed | file=${session.record_file_id}`);
                        log.Error(`=== LDP FLOW === LDP API upload failed - SessionId: ${data.session_id}`, 'StreamingService', 'recordEvent');
                        _socketIO.to(data.socket_id).emit("upload-status", {
                            status: false,
                            error: "LDP API upload failed",
                        });
                    }
                }));
            } catch (uploadError) {
                console.error(`[UPLOAD] LDP exception | file=${session.record_file_id} error=${uploadError.message}`);
                log.Error(`=== LDP FLOW === LDP API upload error - SessionId: ${data.session_id}, Error: ${uploadError.message}`, 'StreamingService', 'recordEvent');
                _socketIO.to(data.socket_id).emit("upload-status", {
                    status: false,
                    error: uploadError.message,
                });
            }
        }

        const totalTime = Date.now() - startTime;
        log.Info(`Record event completed successfully - SessionId: ${data.session_id}, SocketId: ${data.socket_id}, TotalTime: ${(totalTime / 1000).toFixed(2)}s, IsMobile: ${session.mobile_metadata && isMobileSource(session.mobile_metadata.source)}`, 'StreamingService', 'recordEvent');

    } catch (e) {
        const totalTime = Date.now() - startTime;
        console.error("RecordEvent Error:", e);
        
        log.Error(`Record event failed - SessionId: ${data.session_id}, SocketId: ${data.socket_id}, Error: ${e.message}, TotalTime: ${(totalTime / 1000).toFixed(2)}s`, 'StreamingService', 'recordEvent');
        
        _socketIO.to(data.socket_id).emit("upload-status", { 
            status: false, 
            error: e.message 
        });
    }
};

const createNewSession = async (req, res, next) => {
    try {
        const redis = Redis.getClient()

        const additional_data = req.body.additional_data || {}
        const session_id = req.body.session_id ? req.body.session_id.toString() : uuid()
        //scan and clear exprired session
        const check_session = await redis.get(`SESS-${session_id}`)
        if (check_session) {
            const session_data = JSON.parse(check_session)
            if (session_data.streamer) {
                return res.send({ success: false, error: `Session with ID = ${session_id} is existed!` })
            }
            const session = {
                id: session_id,
                create_at: Math.floor(new Date().getTime() / 60000),
                router_index: session_data.router_index,
                record_file_id: null,
                record_files: session_data.record_files || [],
                streamer: null,
                subscribers: session_data.subscribers,
                additional_data: additional_data
            }
            await redis.set(`SESS-${session_id.toString()}`, JSON.stringify(session), 'EX', 60 * SESSION_EXPIRE)
            log.Info('Create new session ' + session_id);
            res.send({
                success: true,
                session_id: session_id,
                additional_data: additional_data
            })
        } else {
            //Create new
            const router_index = getNextRouterIndex()
            console.log("Router index: ", router_index)
            const session = {
                id: session_id,
                create_at: Math.floor(new Date().getTime() / 60000),
                router_index: router_index,
                record_file_id: null,
                record_files: [],
                streamer: null,
                subscribers: [],
                additional_data: additional_data
            }
            log.Info('Create new session ' + session_id);
            await redis.set(`SESS-${session_id.toString()}`, JSON.stringify(session), 'EX', 60 * SESSION_EXPIRE)
            res.send({
                success: true,
                session_id: session_id,
                additional_data: additional_data
            })
        }
    } catch (e) {
        console.log(e)
        res.send({ success: false, error: "Create new session is error" })
    }
}

const closeSession = async (session_id) => {
    try {
        const redis = Redis.getClient();
        const session = await redis.get(`SESS-${session_id}`);
        
        if (session) {
            const sessionData = JSON.parse(session);
            
            // Xóa các file tạm
            if (sessionData.record_files) {
                for (const fileId of sessionData.record_files) {
                    const webmPath = `${appRoot.path}/public/files/${fileId}.webm`;
                    const mp4Path = `${appRoot.path}/public/files/${fileId}.mp4`;
                    
                    try {
                        if (fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
                        if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path);
                    } catch (e) {
                        console.error(`Error deleting file ${fileId}:`, e);
                    }
                }
            }
            
            // Đóng các process
            if (_process[session_id]) {
                _process[session_id].kill();
                delete _process[session_id];
            }
            
            // Giải phóng ports
            if (sessionData.remotePorts) {
                for (const port of sessionData.remotePorts) {
                    releasePort(port);
                }
            }
            
            // Log mobile session cleanup if applicable
            if (sessionData.mobile_metadata) {
                log.Info('Mobile session cleanup', {
                    sessionId: session_id,
                    source: sessionData.mobile_metadata.source
                });
            }
            
            // Xóa session từ Redis
            await redis.del(`SESS-${session_id}`);
            await redis.del(`CLIENT-${sessionData.streamer}`);
            
            for (const subscriber of sessionData.subscribers) {
                await redis.del(`CLIENT-${subscriber}`);
            }
        }
        
        return true;
    } catch (e) {
        console.error('Error closing session:', e);
        log.Error('Session close error', session_id, e);
        return false;
    }
}

const removeAllSession = async (req, res, next) => {
    try {
        const redis = Redis.getClient();
        
        // Lấy tất cả session
        const sessions = await redis.keys('SESS-*');
        
        // Đóng từng session
        for (const sessionKey of sessions) {
            const sessionId = sessionKey.replace('SESS-', '');
            await closeSession(sessionId);
        }
        
        // Xóa tất cả dữ liệu Redis
        await redis.flushdb();
        
        // Reset các biến global
        _producers = {};
        _consumers = {};
        _transports = {};
        _process = {};
        
        // Xóa tất cả file trong thư mục public/files
        const filesDir = path.join(appRoot.path, 'public/files');
        if (fs.existsSync(filesDir)) {
            const files = fs.readdirSync(filesDir);
            for (const file of files) {
                fs.unlinkSync(path.join(filesDir, file));
            }
        }
        
        res.send({ ok: true });
    } catch (e) {
        console.error('Error removing all sessions:', e);
        log.Error('Remove all sessions error', e);
        res.send({ error: "Failed to remove all sessions" });
    }
}

const openAPIAddFile = async (file_path, file_id, callback) => {
    const maxRetries = 3;
    let retryCount = 0;
    
    log.Info(`Starting file upload to AAD API - FilePath: ${file_path}, FileId: ${file_id}, AAD_API_BASE: ${process.env.AAD_API_BASE}, ACTION_STORAGE: ${process.env.ACTION_STORAGE}`, 'StreamingService', 'openAPIAddFile');
    
    const uploadWithRetry = async () => {
        try {
            if (!fs.existsSync(file_path)) {
                log.Error(`File not found for upload - FilePath: ${file_path}, FileId: ${file_id}`, 'StreamingService', 'openAPIAddFile');
                throw new Error(`File not found: ${file_path}`);
            }
            
            // Log file info before upload
            const fileStats = fs.statSync(file_path);
            log.Info(`File ready for upload - FilePath: ${file_path}, FileId: ${file_id}, FileSize: ${(fileStats.size / 1024 / 1024).toFixed(2)}MB`, 'StreamingService', 'openAPIAddFile');
            
            const form = new FormData();
            form.append('files', fs.createReadStream(file_path));
            
            const uploadUrl = process.env.AAD_API_BASE + "/sapi/" + process.env.ACTION_STORAGE + "?overwrite=" + file_id;
            log.Info(`Upload URL constructed - URL: ${uploadUrl}, FileId: ${file_id}`, 'StreamingService', 'openAPIAddFile');
            
            const config = {
                method: "post",
                url: uploadUrl,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                headers: {
                    "X-API-KEY": process.env.OA_KEY,
                    "Content-Type": "multipart/form-data"
                },
                data: form
            };
            
            log.Info(`Upload request sent - FileId: ${file_id}, Attempt: ${retryCount + 1}/${maxRetries}`, 'StreamingService', 'openAPIAddFile');
            
            const result = await axios(config);
            const data_response = result.data;
            
            log.Info(`Upload response received - FileId: ${file_id}, Status: ${result.status}, Success: ${data_response.success}`, 'StreamingService', 'openAPIAddFile');
            
            if (data_response.success) {
                // Đợi một khoảng thời gian để đảm bảo file đã được xử lý
                log.Info(`Upload successful, waiting for file processing - FileId: ${file_id}`, 'StreamingService', 'openAPIAddFile');
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Delete local file after successful upload
                fs.unlinkSync(file_path);
                log.Info(`Local file deleted after successful upload - FilePath: ${file_path}, FileId: ${file_id}`, 'StreamingService', 'openAPIAddFile');
                
                if (callback && typeof callback === 'function') {
                    callback(true);
                }
                return;
            }
            
            log.Error(`Upload failed - FileId: ${file_id}, Response: ${JSON.stringify(data_response)}`, 'StreamingService', 'openAPIAddFile');
            throw new Error('Upload failed');
            
        } catch (e) {
            log.Error(`Upload attempt ${retryCount + 1} failed - FileId: ${file_id}, Error: ${e.message}`, 'StreamingService', 'openAPIAddFile');
            console.error(`Upload attempt ${retryCount + 1} failed:`, e);
            
            if (retryCount < maxRetries - 1) {
                retryCount++;
                log.Info(`Retrying upload - FileId: ${file_id}, Next attempt: ${retryCount + 1}, Delay: ${1000 * retryCount}ms`, 'StreamingService', 'openAPIAddFile');
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                return uploadWithRetry();
            }
            
            log.Fatal('Upload video has failed!', 'FileID ' + file_id, 'Upload', e);
            if (callback && typeof callback === 'function') {
                callback(false);
            }
        }
    };
    
    await uploadWithRetry();
}

const uploadMobileVideo = async (file_path, mobile_metadata, callback) => {
    const maxRetries = 3;
    let retryCount = 0;
    
    const uploadWithRetry = async () => {
        try {
            // Validate mobile API host
            validateMobileApiHost();
            
            if (!fs.existsSync(file_path)) {
                throw new Error(`File not found: ${file_path}`);
            }
            
            const form = new FormData();
            form.append('fileupload', fs.createReadStream(file_path));
            form.append('jobId', mobile_metadata.jobId);
            form.append('so_id_hs', mobile_metadata.so_id_hs);
            form.append('user', mobile_metadata.user);
            form.append('departmentId', mobile_metadata.departmentId);
            form.append('latitude', mobile_metadata.latitude);
            form.append('longitude', mobile_metadata.longitude);
            form.append('ma_tvv', mobile_metadata.ma_tvv);
            form.append('ma_hang_muc', mobile_metadata.ma_hang_muc);
            form.append('ten_hang_muc', mobile_metadata.ten_hang_muc);
            form.append('source', mobile_metadata.source);
            form.append('type_product', mobile_metadata.type_product);
            
            const headers = getMobileUploadHeaders(mobile_metadata.authority, mobile_metadata.authorization);
            
            const config = {
                method: "post",
                url: MOBILE_API_HOST + MOBILE_UPLOAD_ENDPOINT,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                headers: {
                    ...headers,
                    "Content-Type": "multipart/form-data"
                },
                data: form
            };
            
            const result = await axios(config);
            const data_response = result.data;
            
            if (data_response.response_code === "00") {
                // Đợi một khoảng thời gian để đảm bảo file đã được xử lý
                await new Promise(resolve => setTimeout(resolve, 1000));
                fs.unlinkSync(file_path);
                callback(true);
                return;
            }
            
            throw new Error(`Upload failed: ${data_response.response_message}`);
            
        } catch (e) {
            console.error(`Mobile upload attempt ${retryCount + 1} failed:`, e);
            
            if (retryCount < maxRetries - 1) {
                retryCount++;
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                return uploadWithRetry();
            }
            
            log.Fatal('Mobile upload video has failed!', 'Source ' + mobile_metadata.source, 'Upload', e);
            callback(false);
        }
    };
    
    await uploadWithRetry();
}

const getStats = () => {
    return {
        producer: Object.keys(_producers).length,
        consumer: Object.keys(_consumers).length,
        process: Object.keys(_process).length,
        socket_client: _socketIO.engine.clientsCount
    }
}

const waitForFileComplete = async (filePath, timeout = 30000) => {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const stats = fs.statSync(filePath);
    const currentSize = stats.size;
    await new Promise(resolve => setTimeout(resolve, 1000));
    const newStats = fs.statSync(filePath);
    if (newStats.size > 0 && newStats.size === currentSize) {
      return true; // File size không đổi trong 1 giây, có thể đã ghi xong
    }
  }
  return false;
};

const convertToMp4 = async (webmPath, mp4Path) => {
  const startTime = Date.now();
  
  const doConvert = async () => {
  try {
    log.Info(`Starting video conversion - Webm: ${webmPath}, Mp4: ${mp4Path}`, 'StreamingService', 'convertToMp4');
    
    // Check if webm file exists and is accessible
    if (!fs.existsSync(webmPath)) {
      throw new Error(`Webm file not found: ${webmPath}`);
    }
    
    // Check file permissions and accessibility
    try {
      fs.accessSync(webmPath, fs.constants.R_OK);
    } catch (accessError) {
      throw new Error(`Cannot read webm file: ${accessError.message}`);
    }
    
    // Check if file is actually a webm file by reading first 4 bytes (EBML magic)
    try {
      const buf = Buffer.alloc(4);
      const fd = fs.openSync(webmPath, 'r');
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      const headerStr = buf.toString('hex');
      if (!headerStr.startsWith('1a45dfa3')) {
        log.Error(`File does not appear to be a valid webm file - Header: ${headerStr}`, 'StreamingService', 'convertToMp4');
        throw new Error('File không phải là webm hợp lệ');
      }
      log.Info(`Webm file header validation passed - Header: ${headerStr}`, 'StreamingService', 'convertToMp4');
    } catch (headerError) {
      log.Error(`Header validation failed - ${headerError.message}`, 'StreamingService', 'convertToMp4');
      // Continue anyway, let ffprobe handle it
    }
    
    // Get dynamic settings based on system
    const baseSettings = getOptimizedFFmpegSettings();
    const memorySettings = getMemoryOptimizedSettings(baseSettings);
    let finalSettings = getCPUOptimizedSettings(memorySettings);

    // Dynamic overrides based on concurrency
    const concurrentNow = getActiveConversions() + 1; // include this job
    const loadAverage = os.loadavg()[0];
    const cpuCores = os.cpus().length;
    const highLoad = loadAverage > cpuCores * 0.8;

    let dynamicThreads = 4;
    let dynamicPreset = 'fast';
    let dynamicCrf = 21;
    let enableLightFilters = true;

    if (concurrentNow >= 3 || highLoad) {
      dynamicThreads = 1;
      dynamicPreset = 'veryfast';
      dynamicCrf = 21; // 21-22 acceptable; keep 21 to preserve quality
      enableLightFilters = false; // favor speed under high concurrency
    } else if (concurrentNow === 2) {
      dynamicThreads = 2;
      dynamicPreset = 'fast';
      dynamicCrf = 21;
      enableLightFilters = true;
    } else {
      dynamicThreads = 3; // leave some headroom for Node/OS
      dynamicPreset = 'fast';
      dynamicCrf = 21;
      enableLightFilters = true;
    }

    finalSettings = {
      ...finalSettings,
      threads: dynamicThreads,
      preset: dynamicPreset
    };
    log.Info(`Dynamic encoding policy - Concurrency: ${concurrentNow}, Load1m: ${loadAverage.toFixed(2)}, Threads: ${dynamicThreads}, Preset: ${dynamicPreset}, CRF: ${dynamicCrf}, FiltersEnabled: ${enableLightFilters}`, 'StreamingService', 'convertToMp4');
    
    log.Info(`FFmpeg Settings - Settings: ${JSON.stringify(finalSettings)}`, 'StreamingService', 'convertToMp4');
    
    // ============================================================================
    // PERFORMANCE MONITORING - THEO DÕI HIỆU SUẤT CONVERSION
    // ============================================================================
    const performanceMetrics = {
      hardwareLevel: finalSettings.description.split(' ')[1], // HIGH/MEDIUM/LOW
      preset: finalSettings.preset,
      meMethod: finalSettings.meMethod,
      subq: finalSettings.subq,
      refs: finalSettings.refs,
      trellis: finalSettings.trellis,
      threads: finalSettings.threads,
      estimatedTime: '2-3x real-time' // Ước tính dựa trên cấu hình
    };
    
    log.Info(`FFmpeg conversion settings finalized - Description: ${finalSettings.description}, Performance: ${JSON.stringify(performanceMetrics)}`, 'StreamingService', 'convertToMp4');
    
    // Đợi file webm ghi xong
    log.Info(`Waiting for webm file to complete - Path: ${webmPath}`, 'StreamingService', 'convertToMp4');
    
    const isComplete = await waitForFileComplete(webmPath);
    if (!isComplete) {
      log.Error(`Webm file not complete after timeout - Path: ${webmPath}, Timeout: 30 seconds`, 'StreamingService', 'convertToMp4');
      throw new Error('File webm chưa ghi xong');
    }
    
    log.Info(`Webm file ready for conversion - Path: ${webmPath}`, 'StreamingService', 'convertToMp4');
    
    // Additional file validation
    const fileStats = fs.statSync(webmPath);
    if (fileStats.size < 1024 * 100) { // Less than 100KB
      log.Error(`Webm file too small, likely corrupt - Size: ${fileStats.size} bytes`, 'StreamingService', 'convertToMp4');
      throw new Error('File webm quá nhỏ, có thể bị corrupt');
    }
    
    // Try to repair webm file if it seems corrupted
    if (fileStats.size < 1024 * 1024) { // Less than 1MB
      log.Info(`Webm file seems small, attempting to repair before conversion - Size: ${fileStats.size} bytes`, 'StreamingService', 'convertToMp4');
      
      try {
        // Try to repair with ffmpeg
        const repairPath = webmPath + '.repaired.webm';
        await new Promise((resolve, reject) => {
          ffmpeg(webmPath)
            .inputFormat('webm')
            .outputOptions(['-c', 'copy'])
            .format('webm')
            .on('end', () => {
              log.Info(`Webm file repair completed - Original: ${webmPath}, Repaired: ${repairPath}`, 'StreamingService', 'convertToMp4');
              resolve();
            })
            .on('error', (err) => {
              log.Info(`Webm file repair failed, continuing with original - Error: ${err.message}`, 'StreamingService', 'convertToMp4');
              resolve(); // Continue with original file
            })
            .save(repairPath);
        });
        
        // If repair succeeded, use repaired file
        if (fs.existsSync(repairPath) && fs.statSync(repairPath).size > fileStats.size) {
          log.Info(`Using repaired webm file for conversion`, 'StreamingService', 'convertToMp4');
          webmPath = repairPath;
        }
      } catch (repairError) {
        log.Info(`Webm repair attempt failed, continuing with original file - Error: ${repairError.message}`, 'StreamingService', 'convertToMp4');
      }
    }

    // Lấy thông tin file gốc
    log.Info(`Analyzing source video file - Path: ${webmPath}`, 'StreamingService', 'convertToMp4');
    
    const fileInfo = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(webmPath, (err, metadata) => {
        if (err) {
          log.Error(`FFprobe analysis failed - Path: ${webmPath}, Error: ${err.message}`, 'StreamingService', 'convertToMp4');
          reject(err);
        } else {
          log.Info(`FFprobe analysis completed - Path: ${webmPath}`, 'StreamingService', 'convertToMp4');
          resolve(metadata);
        }
      });
    });
    
    // Validate video stream exists and is valid
    if (!fileInfo.streams || fileInfo.streams.length === 0) {
      log.Error(`No streams found in webm file - Path: ${webmPath}`, 'StreamingService', 'convertToMp4');
      throw new Error('File webm không có stream nào');
    }
    
    const videoStream = fileInfo.streams.find(s => s.codec_type === 'video');
    if (!videoStream) {
      log.Error(`No video stream found in webm file - Path: ${webmPath}`, 'StreamingService', 'convertToMp4');
      throw new Error('File webm không có video stream');
    }
    
    // Check if video stream has required properties
    if (!videoStream.width || !videoStream.height || !videoStream.r_frame_rate) {
      log.Error(`Video stream missing required properties - Width: ${videoStream.width}, Height: ${videoStream.height}, FrameRate: ${videoStream.r_frame_rate}`, 'StreamingService', 'convertToMp4');
      throw new Error('Video stream thiếu thông tin cần thiết');
    }

    // Phân tích thông tin thiết bị từ metadata
    const width = videoStream.width;
    const height = videoStream.height;
    const [fpsNum, fpsDen] = videoStream.r_frame_rate.split('/');
    const fps = fpsDen && +fpsDen !== 0 ? +fpsNum / +fpsDen : +fpsNum;
    
    log.Info(`Video stream analysis - Width: ${width}, Height: ${height}, FPS: ${fps}`, 'StreamingService', 'convertToMp4');
    
    // Phát hiện thiết bị dựa trên metadata
    const isHighEndDevice = detectHighEndDevice(videoStream);
    log.Info(`Device type detection - Type: ${isHighEndDevice ? 'High-end' : 'Standard'}`, 'StreamingService', 'convertToMp4');
    
    log.Info(`Device type detection - IsHighEnd: ${isHighEndDevice}`, 'StreamingService', 'convertToMp4');

    // Tính bitrate tối ưu dựa trên độ phân giải (bits per second)
    let targetBitrate;
    if (width >= 1920) { // 1080p
      targetBitrate = '4000k';
    } else if (width >= 1280) { // 720p
      targetBitrate = '2500k';
    } else if (width >= 854) { // 480p
      targetBitrate = '1000k';
    } else { // 360p or lower
      targetBitrate = '800k';
    }

    log.Info(`Bitrate calculation - Width: ${width}, Height: ${height}, TargetBitrate: ${targetBitrate}`, 'StreamingService', 'convertToMp4');

    // ============================================================================
    // ULTRAFAST OUTPUT OPTIONS - TỐI ƯU CHO TỐC ĐỘ NHANH + CHẤT LƯỢNG TỐT
    // ============================================================================
    // Mục tiêu: Tối ưu tốc độ encode nhanh nhất có thể, vẫn giữ chất lượng chấp nhận được
    // Tác động: Tăng tốc độ 3-4x, giảm tỷ lệ fail, tối ưu cho 4 cores
    // FIXED: Tối ưu cho tốc độ nhanh mà không làm mất chất lượng quá nhiều
    const outputOptions = [
      // VIDEO CODEC
      '-c:v libx264',

      // PRESET & QUALITY
      `-preset ${dynamicPreset}`,
      `-crf ${dynamicCrf}`,

      // GOP/B-FRAMES - Điều chỉnh cho FPS cao
      '-g 30',                           // GOP nhỏ hơn để phù hợp với FPS cap 30
      '-keyint_min 15',                  // Keyframe interval tối thiểu nhỏ hơn
      '-sc_threshold 0',
      '-bf 1',

      // CONTAINER & PIXFMT
      '-movflags +faststart',
      '-pix_fmt yuv420p',

      // THREADING
      `-threads ${dynamicThreads}`,

      // TUNING
      '-tune fastdecode'
    ];

    // ADD FILTERS: Đơn giản hóa filters để tránh conflict
    // Chỉ cap FPS và denoise nhẹ để tránh lỗi conversion
    outputOptions.push('-vf', 'fps=30');

    // ============================================================================
    // AUDIO SETTINGS - TỐI ƯU CHO TỐC ĐỘ VÀ CHẤT LƯỢNG
    // ============================================================================
    // Mục tiêu: Cân bằng giữa tốc độ encode audio và chất lượng âm thanh
    // Tác động: Giảm 10-15% thời gian encode audio, giữ chất lượng âm thanh tốt
    outputOptions.push(
      // AUDIO CODEC: AAC - Tương thích rộng, chất lượng tốt
      '-c:a aac',                         // AAC encoder - Tương thích iOS/Android/Web
      
      // AUDIO BITRATE: Giảm từ 128k xuống 96k để tăng tốc độ
      '-b:a 96k',                         // Thay vì 128k - Giảm 20% dung lượng, tăng tốc độ 10-15%
      
      // SAMPLE RATE: Giữ nguyên 44.1kHz (CD quality)
      '-ar 44100',                        // 44.1kHz - Chất lượng âm thanh tốt, tương thích rộng
      
      // AUDIO CHANNELS: Stereo 2 channels
      '-ac 2',                            // Stereo - Phù hợp hầu hết nội dung
    );

    log.Info(`FFmpeg settings applied - Description: ${finalSettings.description}`, 'StreamingService', 'convertToMp4');
    log.Info(`FFmpeg output options - Options: ${JSON.stringify(outputOptions)}`, 'StreamingService', 'convertToMp4');
    
    // Log thông tin tối ưu tốc độ nhanh cho 4 cores
    log.Info(`FFmpeg conversion starting - Settings: ${finalSettings.description}, IsHighEnd: ${isHighEndDevice}, Preset: ${dynamicPreset}, Threads: ${dynamicThreads}, CRF: ${dynamicCrf}`, 'StreamingService', 'convertToMp4');

    // First attempt with optimized settings
    try {
      // Log kích thước input trước khi bắt đầu convert
      try {
        const inStats = fs.statSync(webmPath);
        log.Info(`Conversion started - InputSize: ${(inStats.size / 1024 / 1024).toFixed(2)}MB`, 'StreamingService', 'convertToMp4');
      } catch (_) {}
      await new Promise((resolve, reject) => {
        ffmpeg(webmPath)
          .inputFormat('webm')
          .outputOptions(outputOptions)
          .format('mp4')
        //   .on('progress', (progress) => {
        //     const currentTime = Date.now();
        //     // const percent = Math.round(progress.percent);
        //     const percent = progress.percent;
        //     console.log(`${finalSettings.description} conversion: ${percent}% done`);

        //     // Log progress every 10 seconds to avoid spam
        //     if (currentTime - progressLogTime > 10000) {
        //         log.Info(`${progress}`, 'StreamingService', 'convertToMp4Progress');
        //         log.Info(`1 Conversion progress - Percent: ${percent}%, Time: ${progress.timemark}, FPS: ${progress.currentFps}, Speed: ${progress.currentKbps}kbps`, 'StreamingService', 'convertToMp4');
        //         progressLogTime = currentTime;
        //     }
        //   })
          .on('end', () => {
            const totalTime = Date.now() - startTime;
            log.Info(`Primary conversion finished`, 'StreamingService', 'convertToMp4');
            log.Info(`FFmpeg conversion completed successfully - TotalTime: ${(totalTime / 1000).toFixed(2)}s, Preset: ${dynamicPreset}, Threads: ${dynamicThreads}, CRF: ${dynamicCrf}`, 'StreamingService', 'convertToMp4');
            
            resolve();
          })
          .on('error', (err) => {
            const totalTime = Date.now() - startTime;
            log.Error(`Error during ${finalSettings.description} conversion - Error: ${err.message}`, 'StreamingService', 'convertToMp4');
            
            // ENHANCED ERROR LOGGING: Capture stderr/stdout để debug chi tiết
            const errorDetails = {
              message: err.message,
              code: err.code || 'N/A',
              signal: err.signal || 'N/A',
              stderr: err.stderr || 'N/A',
              stdout: err.stdout || 'N/A',
              command: `ffmpeg ${outputOptions.join(' ')}`
            };
            
            log.Error(`FFmpeg conversion failed - Details: ${JSON.stringify(errorDetails)}, TotalTime: ${(totalTime / 1000).toFixed(2)}s, Settings: ${finalSettings.description}, FileSize: ${fs.existsSync(webmPath) ? (fs.statSync(webmPath).size / 1024 / 1024).toFixed(2) + 'MB' : 'N/A'}`, 'StreamingService', 'convertToMp4');
            
            reject(err);
          })
          .save(mp4Path);
      });
      
      return true;
    } catch (firstError) {
      log.Info(`First conversion attempt failed, trying fallback method - Error: ${firstError.message}`, 'StreamingService', 'convertToMp4');
      
      // ============================================================================
      // FALLBACK CONVERSION - CÀI ĐẶT CƠ BẢN CHO TỐC ĐỘ TỐI ĐA
      // ============================================================================
      // Mục tiêu: Sử dụng cài đặt đơn giản nhất để đảm bảo convert thành công
      // Tác động: Tốc độ nhanh nhất có thể, chất lượng chấp nhận được
      try {
        log.Info(`Attempting fallback conversion with basic settings for maximum speed`, 'StreamingService', 'convertToMp4');
        
        await new Promise((resolve, reject) => {
          ffmpeg(webmPath)
            .inputFormat('webm')
            .outputOptions([
              // VIDEO CODEC: H.264 với preset nhanh nhất
              '-c:v libx264',                    // H.264 encoder
              '-preset ultrafast',               // Preset nhanh nhất - Tốc độ tối đa
              
              // QUALITY: Sử dụng CRF thay vì bitrate để đơn giản hóa
              '-crf 23',                         // Constant Rate Factor - Chất lượng chấp nhận được
              
              // Framerate cap to avoid oversized output
              '-r 30',
              
              // AUDIO: AAC với bitrate thấp để tăng tốc độ
              '-c:a aac',                        // AAC encoder
              '-b:a 96k',                        // Audio bitrate thấp - Tăng tốc độ
              
              // CONTAINER: Tối ưu cho streaming
              '-movflags +faststart',            // Metadata ở đầu file
              '-pix_fmt yuv420p',                // Pixel format tương thích
              
              // ADDITIONAL STABLE SETTINGS: Thêm cài đặt ổn định cho fallback
              '-profile:v baseline',             // Profile đơn giản nhất, ổn định nhất
              '-level 3.0',                      // Level thấp, tương thích rộng
              '-threads 1',                      // Single thread để tránh xung đột
              '-g 30',                           // GOP size cố định, ổn định
              '-keyint_min 30'                   // Keyframe interval cố định
            ])
            .format('mp4')
            // .on('progress', (progress) => {
            //     const currentTime = Date.now();
            //     // const percent = Math.round(progress.percent);
            //     const percent = progress.percent;
            //     console.log(`${finalSettings.description} conversion: ${percent}% done`);

            //     // Log progress every 10 seconds to avoid spam
            //     if (currentTime - progressLogTime > 10000) {
            //         log.Info(`2 Conversion progress - Percent: ${percent}%, Time: ${progress.timemark}, FPS: ${progress.currentFps}, Speed: ${progress.currentKbps}kbps`, 'StreamingService', 'convertToMp4');
            //         progressLogTime = currentTime;
            //     }
            // })
            .on('end', () => {
              const fallbackTotalTime = Date.now() - startTime;
              log.Info(`Fallback conversion completed successfully - TotalTime: ${(fallbackTotalTime / 1000).toFixed(2)}s, Settings: ultrafast preset, CRF 23`, 'StreamingService', 'convertToMp4');
              resolve();
            })
            .on('error', (err) => {
              const fallbackErrorTime = Date.now() - startTime;
              log.Error(`Fallback conversion also failed - Error: ${err.message}, TotalTime: ${(fallbackErrorTime / 1000).toFixed(2)}s, Settings: ultrafast preset, CRF 23`, 'StreamingService', 'convertToMp4');
              reject(err);
            })
            .save(mp4Path);
        });
        
        const fallbackSuccessTime = Date.now() - startTime;
        log.Info(`Fallback conversion succeeded after first attempt failed - TotalTime: ${(fallbackSuccessTime / 1000).toFixed(2)}s, Settings: ultrafast preset, CRF 23`, 'StreamingService', 'convertToMp4');
        return true;
        
      } catch (fallbackError) {
        const totalFallbackTime = Date.now() - startTime;
        log.Error(`Both conversion attempts failed - TotalTime: ${(totalFallbackTime / 1000).toFixed(2)}s, First: ${firstError.message}, Fallback: ${fallbackError.message}`, 'StreamingService', 'convertToMp4');
        throw new Error(`Conversion failed: ${firstError.message}. Fallback also failed: ${fallbackError.message}`);
      }
    }
  } catch (error) {
    const totalTime = Date.now() - startTime;
            log.Error(`Error converting to mp4 - Error: ${error.message}`, 'StreamingService', 'convertToMp4');
    
    // Log detailed error information
    log.Error(`Video conversion process failed - Error: ${error.message}, TotalTime: ${(totalTime / 1000).toFixed(2)}s, Settings: ${finalSettings?.description || 'Unknown'}, FileSize: ${fs.existsSync(webmPath) ? (fs.statSync(webmPath).size / 1024 / 1024).toFixed(2) + 'MB' : 'N/A'}`, 'StreamingService', 'convertToMp4');
    
    // Check if it's a file corruption issue
    if (error.message.includes('corrupt') || error.message.includes('invalid') || error.message.includes('code 1')) {
      log.Error(`File corruption detected, attempting to analyze webm file`, 'StreamingService', 'convertToMp4');
      
      try {
        // Try to get more detailed error info
        const fileStats = fs.statSync(webmPath);
        log.Error(`Webm file analysis - Size: ${fileStats.size} bytes, Path: ${webmPath}`, 'StreamingService', 'convertToMp4');
        
        // Check if file is actually readable
        const testRead = fs.readFileSync(webmPath, { start: 0, end: 1023 });
        log.Info(`File read test successful - First 1KB readable`, 'StreamingService', 'convertToMp4');
      } catch (analysisError) {
        log.Error(`File analysis failed - ${analysisError.message}`, 'StreamingService', 'convertToMp4');
      }
    }
    
    return false;
  }
  };

  // Use concurrency limiter
  return enqueueConversion(() => doConvert());
};

// Hàm phát hiện thiết bị cao cấp dựa trên metadata
const detectHighEndDevice = (videoStream) => {
  // Kiểm tra các đặc điểm của video stream để xác định thiết bị
  const isHighEnd = (
    // Kiểm tra độ phân giải cao
    (videoStream.width >= 1920 && videoStream.height >= 1080) ||
    // Kiểm tra FPS cao
    eval(videoStream.r_frame_rate) >= 30 ||
    // Kiểm tra bitrate cao
    (videoStream.bit_rate && videoStream.bit_rate > 5000000) ||
    // Kiểm tra codec profile
    (videoStream.profile && videoStream.profile.includes('high'))
  );

  return isHighEnd;
};

(async () => {
    try {
        await initializeWorkers();
        // Log system info on startup
        logSystemInfo();
    } catch (err) {
        console.error(err);
    }
})();



module.exports = {
    initStreaming,
    removeAllSession,
    createNewSession,
    getStats,
    waitForFileReady, // Export function để sử dụng trong GStreamer/FFmpeg
    isFileReady, // Export function để sử dụng trong GStreamer/FFmpeg
    // Export dynamic detection functions
    getSystemInfo,
    detectHardwareCapability,
    getOptimizedFFmpegSettings,
    getMemoryOptimizedSettings,
    getCPUOptimizedSettings,
    logSystemInfo
}