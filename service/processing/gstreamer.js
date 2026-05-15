// Class to handle child process used for running GStreamer

const child_process = require('child_process');
const log = require('node-file-logger');
const { EventEmitter } = require('events');
const { getCodecInfoFromRtpParameters } = require('../core/utils');
var kill = require('tree-kill');
const ffmpeg = require('fluent-ffmpeg')
const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './public/files';

const GSTREAMER_DEBUG_LEVEL = process.env.GSTREAMER_DEBUG_LEVEL || 0;
const GSTREAMER_COMMAND = 'gst-launch-1.0';
const GSTREAMER_OPTIONS = '-v -e';

const options_log = {
  timeZone: 'Asia/Ho_Chi_Minh',
  folderPath: '../../logs/',
  dateBasedFileNaming: true,
  fileNamePrefix: 'StreamSession_',
  fileNameExtension: '.log',
  dateFormat: 'DD_MM_YYYY',
  timeFormat: 'hh:mm:ss A',
}
log.SetUserOptions(options_log);

module.exports = class GStreamer {
  constructor(rtpParameters, recordEvent) {
    this._rtpParameters = rtpParameters;
    this.recordEvent = recordEvent
    this._process = undefined;
    this._observer = new EventEmitter();
    this._ready = false;
    this._readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady  = reject;
    });
    this._createProcess();
  }

  // Trả về Promise resolve khi GStreamer đã chuyển sang trạng thái PLAYING và sẵn sàng nhận RTP.
  // fallbackMs: nếu không nhận được tín hiệu trong thời gian này thì tiếp tục luôn (không crash).
  ready(fallbackMs = 2000) {
    return Promise.race([
      this._readyPromise,
      new Promise(resolve => setTimeout(resolve, fallbackMs))
    ]);
  }

  _createProcess() {
    const recordEvent = this.recordEvent
    const record_data = { socket_id: this._rtpParameters.socket_id, session_id: this._rtpParameters.session_id }
    // Use the commented out exe to create gstreamer dot file
    // const exe = `GST_DEBUG=${GSTREAMER_DEBUG_LEVEL} GST_DEBUG_DUMP_DOT_DIR=./dump ${GSTREAMER_COMMAND} ${GSTREAMER_OPTIONS}`;
    const exe = `GST_DEBUG=${GSTREAMER_DEBUG_LEVEL} ${GSTREAMER_COMMAND} ${GSTREAMER_OPTIONS}`;
    this._process = child_process.spawn(exe, this._commandArgs, {
      detached: false,
      shell: true
    });

    if (this._process.stderr) {
      this._process.stderr.setEncoding('utf-8');
    }

    if (this._process.stdout) {
      this._process.stdout.setEncoding('utf-8');
    }

    this._process.on('message', message =>
      console.log('gstreamer::process::message [pid:%d, message:%o]', this._process.pid, message)
    );

    this._process.on('error', error => {
      log.Error('gstreamer::process::error', this._process.pid, error);
      if (!this._ready) {
        this._ready = true;
        this._rejectReady(error);
      }
    });

    this._process.once('close', () => {
      console.log('gstreamer::process::close [pid:%d]', this._process.pid);
      if (!this._ready) {
        this._ready = true;
        this._rejectReady(new Error('GStreamer process closed before ready'));
      }
      this._observer.emit('process-close');
      try {
        // ===== PHẦN CONVERT ĐÃ ĐƯỢC COMMENT ĐỂ TRÁNH TRÙNG LẶP =====
        // LÝ DO COMMENT: 
        // 1. Trước đây GStreamer convert webm → mp4 với settings đơn giản
        // 2. Sau đó recordEvent trong Streaming.js lại convert lần nữa với settings nâng cao
        // 3. Điều này gây trùng lặp và tốn performance
        // 4. Giải pháp: Chỉ convert 1 lần trong recordEvent với settings tối ưu
        // 5. GStreamer chỉ ghi file webm, recordEvent sẽ convert và upload
        
        // CODE CŨ (ĐÃ COMMENT):
        // const inputfilepath = `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.webm`
        // const outfilepath = `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.mp4`
        // log.Info('Start convert to mp4', `${this._rtpParameters.fileName}.webm`);
        // setTimeout(function () {
        //   ffmpeg(inputfilepath)
        //     .inputFormat('webm')
        //     .outputOptions([
        //       '-crf 16',
        //       '-c:v libx264'
        //     ])
        //     .format('mp4')
        //     .on('end', function (stderrLine) {
        //       recordEvent(null, record_data)
        //     })
        //     .on('error', function (stderrLine) {
        //       recordEvent({ error: stderrLine }, {})
        //     })
        //     .save(outfilepath)
        // }, 2000);
        
        // CODE MỚI: Sử dụng file ready check thay vì setTimeout
        const webmPath = `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.webm`;
        log.Info('GStreamer process finished, bắt đầu check file ready', {
            fileName: this._rtpParameters.fileName,
            webmPath: webmPath,
            timestamp: new Date().toISOString()
        });
        
        // Sử dụng file ready check với progressive delay
        const checkFileAndCallRecordEvent = async () => {
            try {
                // Import waitForFileReady từ controller/Streaming.js
                const { waitForFileReady } = require('../../controller/Streaming');
                
                const isReady = await waitForFileReady(webmPath, 3);
                if (isReady) {
                    log.Info('File webm sẵn sàng, gọi recordEvent', {
                        fileName: this._rtpParameters.fileName,
                        webmPath: webmPath,
                        timestamp: new Date().toISOString()
                    });
                    recordEvent(null, record_data);
                } else {
                    log.Error('File webm không sẵn sàng sau tất cả attempts, báo lỗi', {
                        fileName: this._rtpParameters.fileName,
                        webmPath: webmPath,
                        timestamp: new Date().toISOString()
                    });
                    recordEvent({ 
                        error: 'File webm không sẵn sàng sau multiple checks' 
                    }, record_data);
                }
            } catch (error) {
                log.Error('Lỗi trong quá trình check file và gọi recordEvent', {
                    fileName: this._rtpParameters.fileName,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                recordEvent({ 
                    error: `File check failed: ${error.message}` 
                }, record_data);
            }
        };
        
        // Gọi function check file
        checkFileAndCallRecordEvent();

      } catch (e) {
        log.Error('GSTREAMER ERROR', {
            fileName: this._rtpParameters.fileName,
            error: e.message,
            timestamp: new Date().toISOString()
        });
      }

    });

    this._process.stderr.on('data', data => {
      // console.log('gstreamer::process::stderr::data [data:%o]', data)
    });

    let _stdoutBuffer = '';
    this._process.stdout.on('data', data => {
      // console.log('gstreamer::process::stdout::data', this._process.pid, ' / ', data)
      if (!this._ready) {
        _stdoutBuffer += data;
        // "New clock" xuất hiện khi GStreamer chuyển sang trạng thái PLAYING — đang lắng nghe UDP
        if (_stdoutBuffer.includes('New clock') || _stdoutBuffer.includes('Setting pipeline to PLAYING')) {
          this._ready = true;
          this._resolveReady();
          _stdoutBuffer = '';
        }
      }
    });
  }

  kill() {
    console.log('kill() [pid:%d]', this._process.pid);
    // this._process.kill();
    const pd = this._process.pid
    setTimeout(function () {
      kill(pd);
    }, 2000);
  }

  // Build the gstreamer child process args
  get _commandArgs() {
    let commandArgs = [
      `rtpbin name=rtpbin latency=50 buffer-mode=0 sdes="application/x-rtp-source-sdes, cname=(string)${this._rtpParameters.video.rtpParameters.rtcp.cname}"`,
      '!'
    ];

    commandArgs = commandArgs.concat(this._videoArgs);
    if (this._audioArgs) {
      commandArgs = commandArgs.concat(this._audioArgs);
    } else {
      console.log("Audio is not enable record")
    }
    commandArgs = commandArgs.concat(this._sinkArgs);
    commandArgs = commandArgs.concat(this._rtcpArgs);

    return commandArgs;
  }

  get _videoArgs() {
    const { video } = this._rtpParameters;
    // Get video codec info
    const videoCodecInfo = getCodecInfoFromRtpParameters('video', video.rtpParameters);

    const VIDEO_CAPS = `application/x-rtp,media=(string)video,clock-rate=(int)${videoCodecInfo.clockRate},payload=(int)${videoCodecInfo.payloadType},encoding-name=(string)${videoCodecInfo.codecName.toUpperCase()},ssrc=(uint)${video.rtpParameters.encodings[0].ssrc}`;

    return [
      `udpsrc port=${video.remoteRtpPort} caps="${VIDEO_CAPS}"`,
      '!',
      'rtpbin.recv_rtp_sink_0 rtpbin.',
      '!',
      'queue',
      '!',
      'rtpvp8depay',
      '!',
      'mux.'
    ];
  }

  get _audioArgs() {
    const { audio } = this._rtpParameters;
    if (!audio) {
      return null
    }
    // Get audio codec info
    const audioCodecInfo = getCodecInfoFromRtpParameters('audio', audio.rtpParameters);

    const AUDIO_CAPS = `application/x-rtp,media=(string)audio,clock-rate=(int)${audioCodecInfo.clockRate},payload=(int)${audioCodecInfo.payloadType},encoding-name=(string)${audioCodecInfo.codecName.toUpperCase()},ssrc=(uint)${audio.rtpParameters.encodings[0].ssrc}`;

    return [
      `udpsrc port=${audio.remoteRtpPort} caps="${AUDIO_CAPS}"`,
      '!',
      'rtpbin.recv_rtp_sink_1 rtpbin.',
      '!',
      'queue',
      '!',
      'rtpopusdepay',
      '!',
      'opusdec',
      '!',
      'opusenc',
      '!',
      'mux.'
    ];
  }

  get _rtcpArgs() {
    const { video, audio } = this._rtpParameters;
    var video_sdp = [
      `udpsrc address=127.0.0.1 port=${video.remoteRtcpPort}`,
      '!',
      'rtpbin.recv_rtcp_sink_0 rtpbin.send_rtcp_src_0',
      '!',
      `udpsink host=127.0.0.1 port=${video.localRtcpPort} bind-address=127.0.0.1 bind-port=${video.remoteRtcpPort} sync=false async=false`,
    ]
    var txt_sdp = []
    if (audio) {
      var audio_sdp = [`udpsrc address=127.0.0.1 port=${audio.remoteRtcpPort}`,
        '!',
        'rtpbin.recv_rtcp_sink_1 rtpbin.send_rtcp_src_1',
        '!',
      `udpsink host=127.0.0.1 port=${audio.localRtcpPort} bind-address=127.0.0.1 bind-port=${audio.remoteRtcpPort} sync=false async=false`
      ];
      txt_sdp = [...video_sdp, ...audio_sdp]
    } else {
      console.log("Video with no audio!")
      txt_sdp = [...video_sdp]
    }
    return txt_sdp;
  }

  get _sinkArgs() {
    return [
      'webmmux name=mux',
      '!',
      `filesink location=${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.webm`
    ];
  }
}
