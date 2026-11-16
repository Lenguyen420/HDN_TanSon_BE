# Theo dõi hội phí

Chức năng gồm backend, admin tại `/admin/fees` và mục **Hội phí** trong Mini App. Không sử dụng các bản ghi hội phí cũ lưu trên trình duyệt.

## Điều kiện triển khai

- MongoDB Atlas hoặc MongoDB replica set có hỗ trợ transaction (cùng yêu cầu với luồng duyệt hội viên). Không dùng MongoDB standalone cho các thao tác hội phí.
- Deploy backend trước, sau đó deploy admin và Mini App. Dùng cấu hình API base URL/proxy hiện có; toàn bộ endpoint ở prefix `/api/v1`.
- Khi backend khởi động, tạo collection/index cho campaigns, dues và payments. Không gán đợt thu hay sửa dữ liệu hội viên có sẵn.
- Mini App cần Zalo access token hợp lệ và hồ sơ hội viên đang hoạt động có `zaloUserId` đã liên kết. Hồ sơ SDK chưa được xác minh không cấp quyền xem phí. Giới hạn truy cập Zalo Graph/IP Việt Nam hiện có vẫn áp dụng.

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

Admin dùng Bearer JWT quản trị; Mini App dùng Zalo access token đã xác minh hoặc cookie OAuth hiện có.

| Method | Đường dẫn sau /api/v1 | Công dụng |
| --- | --- | --- |
| GET/POST | /admin/membership-fees | Lọc/phân trang hoặc tạo đợt |
| PATCH | /admin/membership-fees/:id | Sửa nháp/metadata hoặc ngừng thu |
| POST | /admin/membership-fees/:id/publish | Công bố |
| GET | /admin/membership-fees/:id/dues | Hội viên, tổng hợp và lịch sử |
| POST | /admin/membership-fee-dues/:id/manual-payment | Ghi nhận thủ công |
| POST | /admin/membership-fee-payments/:id/confirm | Xác nhận đủ tiền |
| POST | /admin/membership-fee-payments/:id/reject | Từ chối |
| GET | /membership-fees/my-dues | Danh sách riêng theo phiên |
| GET | /membership-fees/my-dues/:id | Chi tiết riêng |
| POST | /membership-fees/my-dues/:id/payment-proof | Gửi mã giao dịch/minh chứng |

Danh sách hỗ trợ page/limit (tối đa 100); admin đợt thu hỗ trợ search/year/status; danh sách khoản phải đóng admin hỗ trợ search/status. Ngày quá hạn tính theo ngày Việt Nam, sau hết ngày hạn đóng.

Xác nhận và ghi nhận thủ công chạy transaction, khóa cùng đợt thu để tránh cạnh tranh với ngừng thu. Unique index (campaignId, memberId) chống gán trùng. transactionKey chuẩn hóa trim/uppercase và unique cho giao dịch đã xác nhận; transaction thất bại rollback cả payment, due và audit. Nhật ký nằm trong trường audit của từng bản ghi.

MVP chỉ đóng đủ một lần; không có cổng thanh toán/webhook, tự động xác nhận, tải ảnh minh chứng trực tiếp hoặc sổ quỹ. Minh chứng hiện gửi qua đường dẫn HTTPS và mã giao dịch.

## Kiểm thử

Chạy `node --test test/membership-fees.test.cjs` trong backend; test tạo MongoDB replica set tạm riêng và giả lập Zalo Graph. Bao gồm quyền sở hữu, dữ liệu giả mạo, công bố/xác nhận đồng thời, mã giao dịch trùng, rollback, quá hạn, ngừng thu và thu hồi hội viên.

