const { getCodecInfoFromRtpParameters } = require('./utils');

// File to create SDP text from mediasoup RTP Parameters
module.exports.createSdpText = (rtpParameters) => {
  const { video, audio } = rtpParameters;
  if(!audio){
    console.log("[SDP] User turn off audio")
  }
  if(!video){
    console.log("[SDP] User turn off video")
  }
  // Video codec info
  const videoCodecInfo = getCodecInfoFromRtpParameters('video', video.rtpParameters);

  // Audio codec info
  const audioCodecInfo = getCodecInfoFromRtpParameters('audio', audio.rtpParameters);
  var rtp_string = 'v=0\r\n' +
    'o=- 0 0 IN IP4 127.0.0.1\r\n' +
    's=FFmpeg\r\n' +
    'c=IN IP4 127.0.0.1\r\n' +
    't=0 0\r\n' +
    `m=video ${video.remoteRtpPort} RTP/AVP ${videoCodecInfo.payloadType}\r\n` +
    `a=rtpmap:${videoCodecInfo.payloadType} ${videoCodecInfo.codecName}/${videoCodecInfo.clockRate}\r\n` +
    'a=sendonly\r\n';

  if (audio) {
    rtp_string +=
      `m=audio ${audio.remoteRtpPort} RTP/AVP ${audioCodecInfo.payloadType}\r\n` +
      `a=rtpmap:${audioCodecInfo.payloadType} ${audioCodecInfo.codecName}/${audioCodecInfo.clockRate}/${audioCodecInfo.channels}\r\n` +
      'a=sendonly\r\n';
  }
  return rtp_string
};