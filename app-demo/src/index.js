import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';

let socket = null;
let device = null;
let producerTransport = null;
let localStream = null;
let photoCount = 0;

const $ = id => document.getElementById(id);

function log(msg, type = 'info') {
  const el = $('log');
  const line = document.createElement('div');
  line.className = `log-${type}`;
  line.textContent = `[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`;
  el.prepend(line);
}

function setStatus(text, live = false) {
  $('status-text').textContent = text;
  $('dot').className = live ? 'live' : '';
}

function setButtons(streaming) {
  $('btn-start').disabled = streaming;
  $('btn-stop').disabled = !streaming;
  $('btn-capture').disabled = !streaming;
}

async function startStream() {
  const serverUrl = $('server-url').value.trim();
  const source    = $('source').value.trim() || 'app-demo';
  if (!serverUrl) { alert('Nhập URL server'); return; }

  setStatus('Đang tạo session...');
  log('Tạo session mới...');

  try {
    // 1. Tạo session
    const resp = await fetch(`${serverUrl}/api/stream/new-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ additional_data: { source } })
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || 'Tạo session thất bại');
    const session_id = data.session_id;
    $('session-id-display').textContent = `Session: ${session_id}`;
    log(`Session tạo thành công: ${session_id}`);

    // 2. Lấy camera
    setStatus('Đang lấy camera...');
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    $('video').srcObject = localStream;
    log('Camera OK');

    // 3. Kết nối Socket.io
    setStatus('Đang kết nối server...');
    socket = io(serverUrl, {
      query: { side: 'streamer', session_id },
      transports: ['websocket']
    });

    await new Promise((resolve, reject) => {
      socket.on('connect', () => { log('Socket.io connected'); resolve(); });
      socket.on('connect_error', (e) => reject(new Error('Socket lỗi: ' + e.message)));
      setTimeout(() => reject(new Error('Timeout kết nối')), 10000);
    });

    // 4. Lấy RTP capabilities
    setStatus('Đang handshake mediasoup...');
    const rtpCapabilities = await new Promise((res, rej) => {
      socket.emit('getRouterRtpCapabilities', {}, (caps) => {
        caps ? res(caps) : rej(new Error('Không lấy được RTP capabilities'));
      });
    });
    log('RTP capabilities OK');

    // 5. Load mediasoup Device
    device = new Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    log('Device loaded');

    // 6. Tạo producer transport
    const transportParams = await new Promise((res, rej) => {
      socket.emit('createProducerTransport', {}, (params) => {
        params?.error ? rej(new Error(params.error)) : res(params);
      });
    });
    log('Producer transport params OK');

    producerTransport = device.createSendTransport(transportParams);

    producerTransport.on('connect', ({ dtlsParameters }, callback) => {
      socket.emit('connectProducerTransport', { dtlsParameters }, callback);
    });

    producerTransport.on('produce', ({ kind, rtpParameters, appData }, callback) => {
      socket.emit('produce', { kind, rtpParameters, appData }, ({ id }) => callback({ id }));
    });

    // 7. Produce video
    const videoTrack = localStream.getVideoTracks()[0];
    await producerTransport.produce({ track: videoTrack });
    log('Video producer OK');

    // 8. Produce audio
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      await producerTransport.produce({ track: audioTrack });
      log('Audio producer OK');
    }

    // 9. Bắt đầu ghi
    socket.emit('start-record', { source }, (res) => {
      log(`Ghi hình bắt đầu (source: ${source})`);
    });

    // 10. Thông báo subscribers
    socket.emit('broadcasting');

    setStatus('LIVE', true);
    setButtons(true);
    log('Streaming!', 'success');

  } catch (err) {
    log('Lỗi: ' + err.message, 'error');
    setStatus('Lỗi');
    stopStream();
  }
}

function stopStream() {
  if (socket) { socket.disconnect(); socket = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (producerTransport) { producerTransport.close(); producerTransport = null; }
  $('video').srcObject = null;
  $('session-id-display').textContent = '';
  setStatus('Đã dừng');
  setButtons(false);
  log('Đã dừng stream');
}

function capturePhoto() {
  const video = $('video');
  if (!video.videoWidth) return;
  const canvas = $('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  photoCount++;
  const ts   = new Date().toLocaleTimeString('vi-VN');
  const name = `anh-${String(photoCount).padStart(3, '0')}.png`;
  const url  = canvas.toDataURL('image/png');

  const item = document.createElement('div');
  item.className = 'photo-item';
  item.innerHTML = `<img src="${url}" alt="${name}"><a href="${url}" download="${name}">⬇ ${ts}</a>`;
  $('photos').prepend(item);
  $('photos-label').style.display = 'block';
  log(`Đã chụp ảnh: ${name}`, 'success');
}

$('btn-start').addEventListener('click', startStream);
$('btn-stop').addEventListener('click', stopStream);
$('btn-capture').addEventListener('click', capturePhoto);
