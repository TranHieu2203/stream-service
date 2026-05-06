// Config file for mediasoup elements

const os = require('os');
const IP = process.env.EXTIP // '192.168.150.19'
module.exports = Object.freeze({
  numWorkers: Object.keys(os.cpus()).length,
  listenIp: IP,
  worker: {
    logLevel: 'debug',
    logTags: [
      'rtp',
      'srtp',
      'rtcp',
      'info',
      'ice',
      'dtls',
      'rtx',
      'bwe',
      'score',
      'simulcast',
      'svc'
    ],
    rtcMinPort: 40000,
    rtcMaxPort: 49999
  },
  router: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000
        }
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: {
          'profile-id': 2,
          'x-google-start-bitrate': 1000
        }
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000
        }
      },
    ]
  },
  webRtcTransport: {
    listenIps: [{ ip: '0.0.0.0', announcedIp: IP }], // TODO: Change announcedIp to your external IP or domain name
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    maxIncomingBitrate: 100000000,
    initialAvailableOutgoingBitrate: 100000000
  },
  plainRtpTransport: {
    listenIp: { ip: '0.0.0.0', announcedIp: IP }, // TODO: Change announcedIp to your external IP or domain name
    rtcpMux: true,
    comedia: false
  }
});