// Class to handle child process used for running FFmpeg

const child_process = require('child_process');
const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg')

const { createSdpText } = require('../core/sdp');
const { convertStringToStream } = require('../core/utils');

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './public/files';

module.exports = class FFmpeg {
  constructor(rtpParameters, recordEvent) {
    this.recordEvent = recordEvent
    this._rtpParameters = rtpParameters;
    this._process = undefined;
    this._observer = new EventEmitter();
    this._createProcess();
  }

  _createProcess() {
    const sdpString = createSdpText(this._rtpParameters);
    const sdpStream = convertStringToStream(sdpString);
    const recordEvent = this.recordEvent
    const record_data = { socket_id: this._rtpParameters.socket_id, session_id: this._rtpParameters.session_id }
    console.log('createProcess() [sdpString:%s]', sdpString);

    this._process = child_process.spawn('ffmpeg', this._commandArgs);

    if (this._process.stderr) {
      this._process.stderr.setEncoding('utf-8');

      this._process.stderr.on('data', data => {
        console.log('ffmpeg::process::data [data:%o]', data)
      }

      );
    }

    if (this._process.stdout) {
      this._process.stdout.setEncoding('utf-8');

      this._process.stdout.on('data', data => {
        console.log('ffmpeg::process::data [data:%o]', data)
      }

      );
    }

    this._process.on('message', message => {
      console.log('ffmpeg::process::message [message:%o]', message)
    });

    this._process.on('error', error => {
      console.error('ffmpeg::process::error [error:%o]', error)
    }
    );

    this._process.once('close', () => {
      console.log('ffmpeg::process::close');
      try {
        // ===== PHẦN CONVERT ĐÃ ĐƯỢC COMMENT ĐỂ TRÁNH TRÙNG LẶP =====
        // LÝ DO COMMENT: 
        // 1. Trước đây FFmpeg convert webm → mp4 với settings đơn giản
        // 2. Sau đó recordEvent trong Streaming.js lại convert lần nữa với settings nâng cao
        // 3. Điều này gây trùng lặp và tốn performance
        // 4. Giải pháp: Chỉ convert 1 lần trong recordEvent với settings tối ưu
        // 5. FFmpeg chỉ ghi file webm, recordEvent sẽ convert và upload
        
        // CODE CŨ (ĐÃ COMMENT):
        // const inputfilepath = `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.webm`
        // const outfilepath = `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.mp4`
        // console.log("Start convert to mp4")
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
        console.log("FFmpeg process finished, bắt đầu check file ready");
        
        // Sử dụng file ready check với progressive delay
        const checkFileAndCallRecordEvent = async () => {
            try {
                // Import waitForFileReady từ controller/Streaming.js
                const { waitForFileReady } = require('../../controller/Streaming');
                
                const isReady = await waitForFileReady(webmPath, 3);
                if (isReady) {
                    console.log("File webm sẵn sàng, gọi recordEvent");
                    recordEvent(null, record_data);
                } else {
                    console.error("File webm không sẵn sàng sau tất cả attempts, báo lỗi");
                    recordEvent({ 
                        error: 'File webm không sẵn sàng sau multiple checks' 
                    }, record_data);
                }
            } catch (error) {
                console.error("Lỗi trong quá trình check file và gọi recordEvent:", error.message);
                recordEvent({ 
                    error: `File check failed: ${error.message}` 
                }, record_data);
            }
        };
        
        // Gọi function check file
        checkFileAndCallRecordEvent();

      } catch (e) {
        console.log("FFMPEG ERROR: ", e)
      }
      this._observer.emit('process-close');

    });

    sdpStream.on('error', error =>
      console.error('sdpStream::error [error:%o]', error)
    );

    // Pipe sdp stream to the ffmpeg process
    sdpStream.resume();
    sdpStream.pipe(this._process.stdin);
  }

  kill() {
    console.log('kill() [pid:%d]', this._process.pid);
    this._process.kill('SIGINT');
  }

  get _commandArgs() {
    let commandArgs = [
      '-loglevel',
      'debug',
      '-protocol_whitelist',
      'pipe,udp,rtp',
      '-fflags',
      '+genpts',
      '-f',
      'sdp',
      '-i',
      'pipe:0'
    ];

    commandArgs = commandArgs.concat(this._videoArgs);
    commandArgs = commandArgs.concat(this._audioArgs);

    commandArgs = commandArgs.concat([
      /*
      '-flags',
      '+global_header',
      */
      `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.webm`
    ]);

    console.log('commandArgs:%o', commandArgs);

    return commandArgs;
  }

  get _videoArgs() {
    return [
      '-map',
      '0:v:0',
      '-c:v',
      'copy'
    ];
  }

  get _audioArgs() {
    return [
      '-map',
      '0:a:0',
      '-strict', // libvorbis is experimental
      '-2',
      '-c:a',
      'copy'
    ];
  }
}