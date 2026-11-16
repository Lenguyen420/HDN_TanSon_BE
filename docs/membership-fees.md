# Theo dõi hội phí

Chức năng gồm backend, admin tại `/admin/fees` và mục **Hội phí** trong Mini App. Không sử dụng các bản ghi hội phí cũ lưu trên trình duyệt.

## Điều kiện triển khai

- MongoDB Atlas hoặc MongoDB replica set có hỗ trợ transaction (cùng yêu cầu với luồng duyệt hội viên). Không dùng MongoDB standalone cho các thao tác hội phí.
- Deploy backend trước, sau đó deploy admin và Mini App. Dùng cấu hình API base URL/proxy hiện có; toàn bộ endpoint ở prefix `/api/v1`.
- Khi backend khởi động, tạo collection/index cho campaigns, dues và payments. Không gán đợt thu hay sửa dữ liệu hội viên có sẵn.
- Giữ backend trên Vercel. Mini App dùng mã bí mật theo dõi hồ sơ đăng ký đang lưu trên thiết bị (cùng nguồn mã với Giao thương). Hồ sơ phải được duyệt, liên kết hội viên đang hoạt động và chưa bị xóa. Luồng hội phí không gọi Zalo Graph và không yêu cầu máy chủ có IP Việt Nam.

## Sử dụng

1. Admin tạo đợt hội phí: tên, năm, tiền VND nguyên, hạn đóng, mô tả, hướng dẫn chuyển khoản và đối tượng.
2. Điền ngân hàng, tài khoản, chủ tài khoản và nội dung chuyển khoản thực tế trong hướng dẫn từng đợt. Hệ thống không tự đặt thông tin ngân hàng.
3. Có thể lưu/sửa nháp. Khi công bố, backend chốt các hội viên đang hoạt động tại thời điểm đó; mỗi hội viên chỉ được gán một lần. Công bố lại không gán thêm hội viên mới.
4. Sau công bố chỉ sửa tên, mô tả, hạn đóng, hướng dẫn. Số tiền, năm, đối tượng được khóa. Khoản đã đóng giữ nguyên số tiền đã chốt.
5. Hội viên xem danh sách và chi tiết; gửi mã giao dịch, đường dẫn minh chứng HTTPS tùy chọn và ghi chú. Trạng thái chuyển sang chờ xác nhận; không tự ghi đã đóng.
6. Admin kiểm tra minh chứng rồi xác nhận hoặc từ chối kèm lý do. Từ chối trả khoản về chưa đóng/quá hạn để gửi lại. Có thể ghi nhận tiền mặt/chuyển khoản thủ công cho khoản chưa đóng, nhập số phiếu/mã giao dịch.
7. Ngừng thu sẽ hủy khoản chưa đóng/chờ xác nhận và từ chối minh chứng đang chờ. Khoản đã đóng được giữ lại. Không mở lại đợt đã ngừng.
8. Nút Làm mới cập nhật kết quả đối soát. Mini App cũng tải lại khi quay về ứng dụng.

## API

Admin dùng Bearer JWT quản trị. Mini App gửi POST /membership-fees/session với body {tokens: [<mã bí mật 64 ký tự hex>]} để đổi lấy JWT 30 phút dành riêng cho hội phí, rồi gửi Authorization: Bearer <JWT> cho các API cá nhân. Không dùng chung JWT Giao thương/admin, Zalo token, cookie OAuth hoặc zaloUserId tự khai báo.

| Method | Đường dẫn sau /api/v1 | Công dụng |
| --- | --- | --- |
| GET/POST | /admin/membership-fees | Lọc/phân trang hoặc tạo đợt |
| PATCH | /admin/membership-fees/:id | Sửa nháp/metadata hoặc ngừng thu |
| POST | /admin/membership-fees/:id/publish | Công bố |
| GET | /admin/membership-fees/:id/dues | Hội viên, tổng hợp và lịch sử |
| POST | /admin/membership-fee-dues/:id/manual-payment | Ghi nhận thủ công |
| POST | /admin/membership-fee-payments/:id/confirm | Xác nhận đủ tiền |
| POST | /admin/membership-fee-payments/:id/reject | Từ chối |
| POST | /membership-fees/session | Đổi mã hồ sơ đã duyệt lấy phiên hội phí |
| GET | /membership-fees/my-dues | Danh sách riêng theo phiên |
| GET | /membership-fees/my-dues/:id | Chi tiết riêng |
| POST | /membership-fees/my-dues/:id/payment-proof | Gửi mã giao dịch/minh chứng |

Danh sách hỗ trợ page/limit (tối đa 100); admin đợt thu hỗ trợ search/year/status; danh sách khoản phải đóng admin hỗ trợ search/status. Ngày quá hạn tính theo ngày Việt Nam, sau hết ngày hạn đóng.

Xác nhận và ghi nhận thủ công chạy transaction, khóa cùng đợt thu để tránh cạnh tranh với ngừng thu. Unique index (campaignId, memberId) chống gán trùng. transactionKey chuẩn hóa trim/uppercase và unique cho giao dịch đã xác nhận; transaction thất bại rollback cả payment, due và audit. Nhật ký nằm trong trường audit của từng bản ghi.

MVP chỉ đóng đủ một lần; không có cổng thanh toán/webhook, tự động xác nhận, tải ảnh minh chứng trực tiếp hoặc sổ quỹ. Minh chứng hiện gửi qua đường dẫn HTTPS và mã giao dịch.

## Kiểm thử

Chạy `node --test test/membership-fees.test.cjs` trong backend; test tạo MongoDB replica set tạm riêng và cấu hình Zalo Graph luôn báo lỗi để bảo đảm hội phí không gọi tới Zalo. Bao gồm quyền sở hữu, dữ liệu giả mạo, công bố/xác nhận đồng thời, mã giao dịch trùng, rollback, quá hạn, ngừng thu và thu hồi hội viên.


## Xác thực bằng mã hồ sơ trên Vercel

- Session chỉ chấp nhận mảng 1–20 mã bí mật; so khớp SHA-256 với notificationTokenHash hiện có. Không cấp quyền từ memberId/name/phone/zaloUserId do frontend gửi.
- Nếu thiết bị lưu nhiều mã, chọn hồ sơ đã duyệt gắn hội viên đang hoạt động theo thứ tự tạo mới nhất; không chọn hồ sơ pending/rejected thay cho hội viên hợp lệ.
- JWT chỉ giữ trong bộ nhớ mini app; tự đổi mã lấy phiên mới khi gần hết hạn hoặc thử lại một lần khi API trả 401. Không lặp lại yêu cầu khi mất mạng/403 và không tự xác nhận thanh toán.
- Mỗi API kiểm tra lại mã hash, trạng thái hồ sơ, liên kết hội viên và tình trạng hội viên. Xóa hồ sơ, thu hồi duyệt, xoay mã hoặc ngừng hội viên làm mất quyền ngay cả khi JWT chưa hết hạn.
- Mã bí mật không được đưa vào URL hoặc log. JWT có issuer/audience riêng cho hội phí; không cấp quyền admin/Giao thương.
- Thiết bị không còn mã (đổi điện thoại/xóa dữ liệu) hoặc hội viên do admin tạo trực tiếp chưa có hồ sơ đã duyệt sẽ cần liên hệ Ban thư ký. Không yêu cầu người dùng đăng ký trùng, không tự tạo mã hay gắn hồ sơ bằng ID Zalo.
- Deploy backend mới trước rồi build/deploy mini app. Giữ nguyên VITE_API_BASE_URL trỏ backend Vercel; không thay region hay cấu hình VPS.
