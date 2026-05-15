# Fix lỗi video recording bị đen và MP4 = 0 byte

Branch: fix/black-video-recording  
Ngày: 2026-05-07

---

## Vấn đề

Sau khi stream kết thúc, file WebM ghi ra bị đen hoàn toàn, không xem được. File MP4 sau khi convert có dung lượng 0 byte.

---

## Nguyên nhân gốc rễ

### 1. Race condition giữa FFmpeg và consumer (nguyên nhân chính)

Khi bắt đầu ghi, code tạo tiến trình FFmpeg rồi dùng setTimeout 1000ms để chờ trước khi resume consumer và yêu cầu keyframe. Cách chờ cố định này không đảm bảo: nếu FFmpeg cần hơn 1 giây để parse SDP và bind cổng UDP (server tải nặng, khởi động chậm), keyframe sẽ đến trước khi FFmpeg sẵn sàng nhận, bị bỏ qua. Toàn bộ video sau đó chỉ là P-frame không có reference frame nào, kết quả là video đen.

### 2. SDP bị thừa khoảng trắng đầu dòng

File sdp.js dùng template literal có indent, khiến mỗi dòng SDP bị thêm khoảng trắng ở đầu. SDP theo chuẩn RFC 4566 không cho phép khoảng trắng đầu dòng. FFmpeg thường tolerate được, nhưng đây là nguồn rủi ro tiềm ẩn có thể gây parse sai cổng RTP.

### 3. waitForFileComplete trả về true khi file 0 byte

Hàm kiểm tra file hoàn chỉnh so sánh size trước và sau 1 giây. Nếu file có size = 0 ngay từ đầu, điều kiện 0 === 0 luôn đúng, hàm trả về true ngay lập tức và coi file rỗng là đã ghi xong. Điều này khiến quá trình convert MP4 chạy trên file WebM rỗng, tạo ra MP4 = 0 byte.

---

## Những gì đã thay đổi

### service/core/sdp.js

Bỏ template literal có indent, viết lại bằng string concatenation. Mỗi dòng SDP kết thúc bằng CRLF theo đúng chuẩn RFC 4566. Không còn khoảng trắng thừa đầu dòng.

### service/processing/ffmpeg.js

Thêm cơ chế phát hiện khi FFmpeg sẵn sàng thay vì dùng thời gian cố định:

- Constructor tạo một Promise nội bộ (_readyPromise) để theo dõi trạng thái sẵn sàng.
- Stderr handler tích lũy output vào buffer, phát hiện chuỗi "Input #0, sdp" - đây là dòng FFmpeg in ra sau khi đã parse xong SDP và bind xong cổng UDP. Khi phát hiện, resolve _readyPromise ngay lập tức.
- Nếu FFmpeg lỗi hoặc đóng trước khi emit tín hiệu này, reject _readyPromise để không treo vô hạn.
- Method ready(fallbackMs=3000) dùng Promise.race: nếu FFmpeg báo sẵn sàng trước 3 giây thì resolve ngay (thường trong 200-500ms), nếu không thì sau 3 giây tự resolve để đảm bảo flow không bị treo.

### controller/Streaming.js - phần start-record (dòng ~915)

Thay setTimeout 1000ms bằng _proc.ready().then(). Callback trả lời client vẫn được gọi ngay lập tức (không thay đổi hành vi với client). Consumers chỉ resume sau khi FFmpeg xác nhận đã sẵn sàng. Thêm .catch() để log lỗi nếu FFmpeg không thể khởi động, tránh crash.

Snapshot peer.process_consumer tại thời điểm gọi để tránh trường hợp mảng bị thay đổi trước khi .then() chạy.

### controller/Streaming.js - hàm waitForFileComplete (dòng ~1781)

Thêm điều kiện newStats.size > 0 vào điều kiện trả về true. File 0 byte sẽ không bao giờ được coi là hoàn chỉnh, hàm sẽ tiếp tục chờ cho đến khi timeout.

---

## Kết quả kỳ vọng

- Video recording bắt đầu bằng keyframe thực sự, không bị đen.
- Consumer resume nhanh hơn (thường 200-500ms thay vì luôn 1000ms), video bắt đầu nhanh hơn.
- File WebM 0 byte không còn bị coi là hoàn chỉnh, quá trình convert không chạy trên file rỗng.
- SDP hợp lệ theo chuẩn, giảm rủi ro parse sai.

---

## Rủi ro còn lại

Nếu server cực kỳ quá tải đến mức FFmpeg cần hơn 3 giây để sẵn sàng, fallback timeout sẽ kick in và hành vi sẽ giống như setTimeout cũ (nhưng với 3 giây thay vì 1 giây). Trường hợp này rất hiếm trong điều kiện vận hành bình thường.
