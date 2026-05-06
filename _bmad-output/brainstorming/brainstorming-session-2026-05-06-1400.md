---
stepsCompleted: [1, 2, 3, 4]
inputDocuments: []
session_topic: 'Phân tích các tính năng của dự án stream-service đang có'
session_goals: 'Phân tích toàn diện: (1) lập bản đồ tính năng, (2) tìm điểm yếu & khoảng trống, (3) khám phá cơ hội cải thiện'
selected_approach: 'progressive-flow'
techniques_used: ['Mind Mapping', 'Six Thinking Hats', 'SCAMPER Method', 'Solution Matrix']
ideas_generated: [13]
context_file: ''
---

# Brainstorming Session Results

**Người dùng:** HieuTV-Team-StreamService
**Ngày:** 2026-05-06

---

## Tổng quan phiên làm việc

**Chủ đề:** Phân tích các tính năng của dự án stream-service đang có
**Mục tiêu:** Phân tích toàn diện 3 tầng:
1. Lập bản đồ đầy đủ tất cả tính năng hiện có
2. Tìm điểm yếu, rủi ro, tính năng còn thiếu
3. Brainstorm ý tưởng nâng cấp từ những gì đang có

**Phương pháp:** Progressive Technique Flow (Mind Mapping → Six Thinking Hats → SCAMPER → Solution Matrix)

---

## Phase 1 — Bản đồ Tính năng (Mind Mapping)

*Phân tích từ codebase thực tế: server.js, controller/Streaming.js, controller/Dashboard.js, controller/SystemMonitor.js, service/*, routes/*, public/*.*

### Nhánh 1 — Core Streaming (WebRTC / mediasoup)

- Tạo phòng/session mới (`POST /api/stream/new-session`)
- Khởi tạo mediasoup Workers đa nhân theo số CPU
- Tạo Router cho từng session
- Tạo WebRTC Transport (UDP/TCP, port 40000–49999)
- SDP signaling — trao đổi codec info với client (VP8, VP9, H264, Opus)
- Nhận media stream từ browser (Producer)
- Ghi stream trực tiếp ra file `.webm`

### Nhánh 2 — Video Processing Pipeline

- Ghi WebM từ WebRTC stream
- Chuyển đổi WebM → MP4 (FFmpeg, preset `fast`, H.264, 4-core optimized)
- Hàng đợi convert (tối đa 3 concurrent, in-memory)
- Upload MP4 lên external API
- Hàng đợi upload (tối đa 2 concurrent, in-memory)

### Nhánh 3 — Session & Data Management

- Redis lưu trạng thái session (`SESS-*`)
- Redis lưu thông tin peer/client (`CLIENT-*`)
- Xóa tất cả session (`GET /api/stream/remove-all`)
- File `list.txt` lưu lịch sử file đã tạo

### Nhánh 4 — Web UI

- Trang chủ `/` — bắt đầu stream
- Dashboard `/dashboard` — stats (sessions, peers, files, disk)
- Logs Dashboard `/logs-dashboard` — xem log hệ thống

### Nhánh 5 — Authentication

- Đăng nhập qua AAD (Azure Active Directory)
- Session-based (`express-session`)
- Middleware `requireLogin` bảo vệ tất cả route

### Nhánh 6 — System Monitoring

- CPU, RAM, disk usage real-time
- Số process FFmpeg đang chạy
- API endpoints: `/api/monitoring/stats`, `/system-stats`, `/process-stats`, `/session-stats`, `/filesystem-stats`
- Log filtering theo service / method / level
- FFmpeg logs riêng: `/api/monitoring/logs/ffmpeg`

---

## Phase 2 — Phân tích Điểm mạnh & Khoảng trống (Six Thinking Hats)

### Mũ Trắng — Sự thật từ code

| Tính năng | Thực trạng |
|---|---|
| WebRTC (mediasoup v3) | Đang dùng — khởi tạo nhiều worker theo số CPU |
| Convert WebM→MP4 | Đang dùng — FFmpeg với preset `fast`, codec H.264 |
| Hàng đợi convert | Max 3 convert đồng thời (hardcode) |
| Hàng đợi upload | Max 2 upload đồng thời (hardcode) |
| Redis session | Đang dùng — lưu SESS-* và CLIENT-* |
| Auth (AAD) | Đang dùng — bảo vệ tất cả route |
| Dashboard UI | Có — xem stats, xóa file |
| Monitoring API | Có — CPU/RAM/disk/log |

### Mũ Đen — Rủi ro & Điểm yếu

**[Khoảng trống #1] Không có retry khi convert thất bại**
Nếu FFmpeg convert lỗi, file WebM không được thử lại — mất dữ liệu vĩnh viễn.

**[Khoảng trống #2] File WebM không được dọn dẹp sau convert**
Sau khi MP4 tạo xong, file WebM gốc vẫn còn — lâu dài đầy disk mà không biết lý do.

**[Khoảng trống #3] Không có giới hạn thời gian recording**
Client mất kết nối đột ngột → session "zombie" tồn tại mãi trong Redis → rò rỉ bộ nhớ.

**[Khoảng trống #4] Upload thất bại không có fallback**
API upload lỗi → file MP4 nằm yên trên server, không retry. Server restart → mất luôn.

**[Khoảng trống #5] Không có health check endpoint**
Không có `/healthz` hay `/ping` → load balancer / Docker / Kubernetes không thể kiểm tra service còn sống.

### Mũ Vàng — Điểm mạnh

- Concurrency limiter được thiết kế tốt — tránh server quá tải
- Monitoring API khá đầy đủ — phân loại rõ từng loại metric
- Logging có filter — dễ debug khi có vấn đề FFmpeg
- Auth tích hợp AAD — bảo mật cấp doanh nghiệp
- Socket.io sẵn có — nền tảng tốt để mở rộng real-time features

### Mũ Xanh lá — Cơ hội

- Thêm WebSocket progress cho client (dùng Socket.io đang có)
- Tự động dọn dẹp file cũ sau convert/upload thành công
- Persistent queue dùng Redis đang có → không mất job khi restart

---

## Phase 3 — Ý tưởng Cải tiến (SCAMPER)

### S — Substitute

**[S1] Thay `file list.txt` bằng Redis**
*Concept:* Dùng Redis sorted set (timestamp làm score) thay file text — query được, không corrupt, không mất khi restart.
*Novelty:* Sẵn Redis rồi, không tốn thêm infrastructure.

**[S2] Thay in-memory queue bằng Bull/BullMQ**
*Concept:* Queue convert/upload dùng Redis làm backend → persist qua restart, retry tự động, có UI xem queue.
*Novelty:* Giải quyết đồng thời 3 vấn đề: persist + retry + visibility.

**[S3] Thay hardcode `CONVERSION_MAX_CONCURRENT = 3` bằng dynamic**
*Concept:* Tính max concurrent tự động theo số CPU thực tế (`Math.max(1, cpuCores - 1)`).
*Novelty:* Code đã có `os.cpus()` sẵn — thêm 1 dòng là xong.

### C — Combine

**[C1] Gộp Socket.io (đang có) + Convert Progress**
*Concept:* FFmpeg có event `progress` — pipe thẳng qua Socket.io về client. User thấy tiến trình convert real-time.
*Novelty:* Infrastructure đã có 100%, chỉ cần nối dây.

**[C2] Gộp Dashboard + Logs thành Unified Dashboard**
*Concept:* Gộp `/dashboard` và `/logs-dashboard` thành một trang có tab/panel — giảm context switching khi debug.
*Novelty:* Cùng layout, cùng auth — chỉ là UX improvement.

### A — Adapt

**[A1] Adapt Health Check pattern → thêm `/healthz`**
*Concept:* Endpoint trả `{ status: "ok", redis: "ok", workers: N }` — cần cho Docker/Kubernetes tự động restart khi service chết.
*Novelty:* ~10 dòng code, tránh downtime không phát hiện được.

**[A2] Adapt Heartbeat → tự động kill zombie session**
*Concept:* Client ping mỗi 30s. Nếu không ping sau 2 phút → server tự đóng session, giải phóng Redis và mediasoup resources.
*Novelty:* Giải quyết memory leak âm thầm.

### M — Modify

**[M1] Thêm disk space guard trước khi nhận recording**
*Concept:* Trước khi tạo session mới, check `diskusage` (đã import sẵn!) — nếu disk > 90% thì từ chối với lỗi rõ ràng.
*Novelty:* Tránh server treo vì đầy disk lúc đang ghi.

**[M2] Retry với exponential backoff cho Upload**
*Concept:* Upload fail → chờ 5s → 10s → 20s → sau 3 lần log error và giữ file lại. Hiện tại fail là mất luôn.
*Novelty:* Network hiccup không gây mất dữ liệu.

### E — Eliminate

**[E1] Xóa `detectEnvironment()` — dead code**
*Concept:* Function đã được comment là không cần thiết nhưng vẫn tồn tại — gây hiểu nhầm khi maintain.
*Novelty:* Giảm cognitive load cho developer.

**[E2] Xóa WebM sau khi convert + upload thành công**
*Concept:* WebM chỉ là file trung gian. Sau khi MP4 xong và upload OK → xóa WebM. Tiết kiệm disk đáng kể.
*Novelty:* WebM thường lớn hơn MP4 tương đương do không được optimize.

### R — Reverse

**[R1] Push notification khi convert/upload xong**
*Concept:* Thay vì user F5 dashboard → Socket.io push event về browser tự động khi file sẵn sàng.
*Novelty:* Socket.io đã kết nối sẵn từ đầu.

**[R2] Log streaming real-time (SSE)**
*Concept:* Thêm `/api/monitoring/logs/stream` dùng Server-Sent Events → log hiện ra ngay khi có, như `tail -f`.
*Novelty:* Debug production nhanh hơn nhiều so với polling.

---

## Phase 4 — Ma trận Ưu tiên (Solution Matrix)

| # | Cải tiến | Impact | Effort | Ưu tiên |
|---|---|:---:|:---:|:---:|
| M1 | Disk space guard trước khi record | Cao | Thấp | **P0 — Làm ngay** |
| A1 | Health check `/healthz` | Cao | Thấp | **P0 — Làm ngay** |
| E2 | Xóa WebM sau convert thành công | Cao | Thấp | **P1 — Sprint tới** |
| A2 | Heartbeat → kill zombie session | Cao | Vừa | **P1 — Sprint tới** |
| M2 | Retry upload với exponential backoff | Cao | Vừa | **P1 — Sprint tới** |
| C1 | Socket.io + convert progress real-time | Vừa | Vừa | **P2 — Backlog** |
| S1 | Thay list.txt bằng Redis | Vừa | Vừa | **P2 — Backlog** |
| S2 | Bull/BullMQ persistent queue | Cao | Cao | **P2 — Backlog** |
| R2 | Log streaming SSE | Vừa | Vừa | **P3 — Nice to have** |
| S3 | Dynamic concurrent limit | Vừa | Thấp | **P3 — Nice to have** |
| R1 | Push notification khi xong | Vừa | Thấp | **P3 — Nice to have** |
| C2 | Unified Dashboard + Logs | Thấp | Vừa | **P3 — Nice to have** |
| E1 | Xóa dead code detectEnvironment | Thấp | Thấp | **P3 — Nice to have** |

---

## Tổng kết

**Tính năng hiện có:** 6 nhóm tính năng chính, hệ thống streaming WebRTC hoàn chỉnh từ đầu đến cuối.

**Rủi ro nghiêm trọng nhất:** Không có retry/fallback cho convert và upload — một lần lỗi là mất dữ liệu. Zombie session gây rò rỉ tài nguyên dài hạn.

**Quick wins (làm ngay, ít effort):** M1 (disk guard) + A1 (healthz) + E2 (xóa WebM) + S3 (dynamic concurrency) + R1 (push notification).

**Đầu tư lớn, impact cao:** S2 (Bull/BullMQ) — giải quyết toàn bộ vấn đề queue persist + retry + visibility trong một lần.
