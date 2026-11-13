# Lưu video giới thiệu trong uploads

Luồng: chọn video để xem trước tại frontend → bấm Lưu → gửi file lên backend → backend lưu vào `uploads/introduction-videos/<uuid>.mp4` hoặc `.webm` → cập nhật riêng `association_settings.introductionVideoUrl` trong MongoDB. Video được phát qua `/uploads/introduction-videos/<uuid>.<ext>` trên chính backend.

## API

`POST /api/v1/admin/introduction-videos/upload`

- Header: `Authorization: Bearer <admin-access-token>`.
- Body: `multipart/form-data`, đúng một file ở trường `video`, không kèm trường khác.
- Hỗ trợ MP4/WebM, tối thiểu 12 byte và tối đa 100 MiB. Backend kiểm tra phần mở rộng, MIME và chữ ký đầu file.
- File được ghi trực tiếp ra ổ đĩa, không nạp toàn bộ video vào RAM. File tạm được ẩn cho đến khi kiểm tra xong. Khi lưu database thất bại, file mới được dọn; video cũ được giữ.

HTTP 201:

```json
{
  "data": {
    "url": "/uploads/introduction-videos/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.mp4",
    "name": "gioi-thieu.mp4",
    "size": 52428800
  }
}
```

API cập nhật URL video ngay khi thành công, không cần gọi endpoint xác nhận hoặc xin URL upload. Các trường giới thiệu khác được giữ nguyên. `GET /api/v1/public/settings` trả đường dẫn video mới. Khi frontend và backend khác domain, ghép đường dẫn với origin backend để phát video.

Lỗi: 400 nếu thiếu file, sai định dạng hoặc sai trường multipart; 401/403 nếu thiếu quyền admin; 413 nếu file vượt giới hạn; 503 nếu chạy trên Vercel.

## Frontend: chỉ upload khi bấm Lưu

```js
let selectedVideo = null;
let previewUrl = null;

function onVideoSelected(file, videoElement) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  selectedVideo = file;
  previewUrl = file ? URL.createObjectURL(file) : null;
  videoElement.src = previewUrl || "";
  // Chọn file chỉ tạo preview, chưa gọi API.
}

async function onSave(apiOrigin, accessToken) {
  if (!selectedVideo) return;
  const body = new FormData();
  body.append("video", selectedVideo);
  const response = await fetch(
    apiOrigin + "/api/v1/admin/introduction-videos/upload",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body,
    },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result.message));
  selectedVideo = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  return new URL(result.data.url, apiOrigin).href;
}
```

Không tự đặt `Content-Type` cho FormData; trình duyệt thêm multipart boundary. Trong khi đang lưu, khóa nút Lưu để tránh gửi trùng. Nếu form có các trường giới thiệu khác, lưu chúng trước upload video, hoặc khi PUT settings tiếp theo phải dùng URL mới trả về; tránh gửi URL cũ ghi đè video mới.

## Triển khai

- Không cần Cloudflare R2, API key hay cấu hình bucket/CORS R2.
- Backend phải chạy trên máy/VPS có ổ đĩa bền vững và quyền ghi thư mục uploads. CORS backend vẫn cần origin frontend trong `CORS_ORIGINS`.
- Docker Compose trong `deploy/vietnam/compose.yaml` gắn volume `backend_uploads` vào `/app/uploads` để giữ file khi tạo lại container. Không dùng `docker compose down -v` nếu muốn giữ dữ liệu.
- Vercel không hỗ trợ lưu file lâu dài vào thư mục dự án; cần chuyển backend sang máy chủ có disk nếu muốn dùng cách này.
- Nếu dùng reverse proxy, cho phép request hơn 100 MiB (cộng multipart overhead) và thời gian upload đủ dài. Nếu domain đi qua Cloudflare proxy, giới hạn request của Cloudflare vẫn áp dụng; dùng endpoint upload truy cập trực tiếp backend khi cần.
- Sao lưu cả MongoDB và volume uploads. Khi thay video, file cũ được giữ để tránh làm hỏng liên kết; dọn file không còn tham chiếu theo nhu cầu.

Các endpoint chunk MongoDB cũ được giữ để tương thích frontend cũ và video đã có; frontend chuyển sang endpoint `/upload` để video mới được lưu vào folder. Hai endpoint R2 `upload-url` và `confirm-upload` đã được gỡ.
