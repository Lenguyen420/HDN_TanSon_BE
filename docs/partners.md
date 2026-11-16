# Đơn vị đồng hành

Base URL theo convention dự án: `/api/v1`.

- Public: `GET /partners` (alias `/public/partners`), `GET /partners/:id` (alias `/public/partners/:id`).
- Admin Bearer token: `GET/POST /admin/partners`, `GET/PATCH/DELETE /admin/partners/:id`, `POST /admin/partners/:id/contributions`, `PATCH/DELETE /admin/contributions/:id`, `GET /admin/partners/statistics`.
- Admin dùng trang `/admin/sponsorships`; Mini App mở tiện ích **Đơn vị đồng hành**. Cookie admin được chuyển tiếp qua proxy `/api/association` hiện có.

Danh sách hỗ trợ `page`, `limit` (tối đa 100), `search` theo tên và `sort=amount|updated|name`. Admin thêm `isPublished=true|false`. Chi tiết phân trang lịch sử bằng `page`, `limit`; `contributionId` trả thêm `selectedContribution` để thông báo mở được khoản cũ ngoài trang đầu. Chỉ trả khoản thuộc đơn vị và đúng quyền công khai.

Tạo đơn vị và khoản đóng góp cần `requestId` UUID được giữ nguyên khi thử lại cùng thao tác. ID được tạo ổn định theo admin/đơn vị/requestId, MongoDB bảo đảm duy nhất cả khi gửi đồng thời. Gửi cùng requestId với dữ liệu khác trả 409. PATCH cập nhật trường được gửi; ẩn không xóa nội dung đã lưu. Có audit người tạo/sửa/xóa và thời gian; không trả audit, hội viên liên kết, trạng thái gửi hay request hash ra API public.

Khoản bằng tiền: `type=money`, `paymentMethod=cash|bank_transfer`, `amount` nguyên không âm. Hiện vật: `type=in_kind`, `itemName`, `quantity>0`, `estimatedValue` tùy chọn. Cả hai cần `title`, `description`, `contributionDate` YYYY-MM-DD; tùy chọn `eventId`. Tiền tối đa 1.000.000.000.000 VNĐ/khoản. Hiện vật không cộng vào lũy kế tiền.

Ảnh dùng chung `ImageStorage`, folder `partners`, lưu trên disk/GridFS theo cấu hình hiện tại. Logo và tối đa 3 ảnh công khai/khoản, mỗi data URL tối đa 1.400.000 ký tự, body tối đa 4500 KiB. Admin dùng ImagePicker hiện có để thu nhỏ ảnh. Chỉ tải ảnh được phép công khai; đường dẫn ảnh có thể truy cập trực tiếp. Không tải chứng từ chứa thông tin nhạy cảm.

Tổng công khai tính tại thời điểm đọc, từ các khoản công khai chưa xóa của đơn vị công khai chưa xóa. Không lưu lũy kế thủ công. Thống kê admin nhận `from`, `to` theo ngày đóng góp, bao gồm biên; `totalPartners` đếm mọi đơn vị chưa xóa, các tổng đóng góp và `byPartner` chỉ tính dữ liệu công khai. Giá trị hiện vật ước tính và số lượt hiện vật thống kê riêng.

Thông báo nội bộ tái sử dụng `/public/notification-feed`, `source=partners`, chứa `partnerId`, `contributionId`. `sendNotification=true` chỉ hợp lệ khi đơn vị và khoản đều công khai. Trạng thái `notification.status=sent`, `sentAt` ghi nguyên tử cùng khoản đóng góp: ở đây “sent” nghĩa là đã công bố vào hộp thư nội bộ, không phải thiết bị đã đọc hay gửi Zalo OA. Feed suy ra trực tiếp từ bản ghi này với ID ổn định, nên không có bước gửi bên ngoài và không có bản tin trùng khi retry. Nếu lưu DB thất bại, thông báo cũng không được công bố. Ẩn/xóa khoản hoặc đơn vị sẽ bỏ thông báo khỏi feed. Sửa không chọn gửi không tạo thông báo mới. Mini App nhận qua cơ chế polling hiện có; Zalo OA không được triển khai.

Kiểm tra: `node --test test/partners.test.cjs`; toàn bộ backend `npm test`. Các bài test sử dụng MongoDB tạm riêng, không sửa dữ liệu thật.

## Cập nhật luồng công bố và hiển thị đóng góp

- Công bố đơn vị lần đầu (tạo với `isPublished=true` hoặc chuyển nháp sang công khai) tự tạo thông báo giới thiệu cho mọi người trong hộp thư Mini App. Lưu nháp không thông báo; sửa hoặc ẩn/công bố lại không tạo bản trùng, giữ nguyên thời điểm gửi đầu tiên.
- Đơn vị công khai từ phiên bản cũ chưa có thông báo: mở Sửa đơn vị, chọn **Gửi thông báo nội bộ**, lưu. Backend nhận `sendNotification=true` và ghi trạng thái một lần. Không tự phát lại tất cả dữ liệu cũ khi đọc API.
- Thông báo giới thiệu có `partnerId`, không cần `contributionId`; thông báo khoản đóng góp vẫn có cả hai. Admin và Mini App dùng cùng feed `source=partners`.
- Danh sách đơn vị trả thêm `latestContributions` (tối đa 3 khoản công khai, ngày mới nhất), chỉ gồm tên khoản, loại, tiền hoặc hiện vật/số lượng và ngày; không chứa trường audit hay khoản nháp.
- Mini App hiện các khoản gần nhất ngay dưới từng đơn vị và nút **Xem lịch sử đóng góp**. Giới thiệu/địa chỉ/website được thu gọn trong trang chi tiết để lịch sử dễ thấy hơn.
- Admin có **Thêm khoản đóng góp** ngay trên từng dòng đơn vị. Tạo hồ sơ đơn vị không tự sinh khoản tiền/hiện vật. Cần nhập khoản đóng góp thực tế; khoản mới mặc định công khai khi đơn vị đã công khai, và tùy chọn gửi thông báo được chọn sẵn, có thể bỏ chọn.
