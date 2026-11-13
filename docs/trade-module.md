# Giao thương – Hội Doanh nghiệp Phường Tân Sơn

Triển khai theo `trade-module-spec.md`: giữ vòng đời và các quy tắc nghiệp vụ, thay cách gọi trên giao diện thành doanh nghiệp đăng tin, hội viên/người quan tâm và Ban quản trị Hội. Không có giỏ hàng, đặt hàng, thanh toán hoặc số dư ví trong module này.

## Triển khai

1. Backend dùng MongoDB replica set hoặc Atlas để chạy transaction. Các collection/index `trade_*` được tạo khi khởi động, không tạo danh mục/tin mẫu trên dữ liệu thật.
2. Deploy backend trước, admin sau, Mini App sau cùng. Không cần chuyển dữ liệu nội dung cũ.
3. Trong admin, mở **Giao thương → Danh mục** để tạo danh mục đầu tiên. `SUPER_ADMIN` quản lý danh mục và tài khoản; `STAFF` đọc danh mục, kiểm duyệt tin/đánh giá và hỗ trợ hội thoại.
4. Hội viên hoạt động đã có hồ sơ đăng ký được duyệt có thể đăng tin trên Mini App. Danh mục chưa có thì chưa thể đăng tin.
5. Nên đặt `TRADE_ANALYTICS_HASH_SECRET` riêng, đủ ngẫu nhiên. Nếu bỏ qua, backend dùng `JWT_SECRET` làm salt. Không lưu IP hoặc User-Agent thô.

## Xác thực

- `POST /api/v1/trade-session` nhận `{tokens:[secretReceipt], registrationId?}`. Đây là mã theo dõi bí mật do thiết bị tạo khi đăng ký hội viên; backend so sánh hash với hồ sơ trong DB. Không nhận mã Zalo/tên/vai trò tự khai để cấp quyền.
- Trường hợp không có receipt, có thể dùng `Authorization: Bearer <Zalo access token>` và body `{}`. Backend xác minh trực tiếp với Zalo qua service hiện có. Vẫn chịu các yêu cầu mạng/quyền Zalo của hệ thống hiện tại.
- Trả `{success:true,data:{accessToken,expiresIn:1800,user}}`. JWT có audience riêng `tanson-trade`; không dùng được thay token quản trị.
- Mỗi request kiểm tra lại tài khoản bị khóa và hồ sơ hội viên. Hồ sơ hoạt động tương ứng `BUSINESS/ACTIVE`; người quan tâm đã xác thực nhưng chưa được duyệt là `USER`. Khi mất trạng thái hội viên, không tiếp tục được đăng/gửi duyệt.
- Mini App giữ JWT trong bộ nhớ; không dùng Zalo SDK profile chưa xác minh làm thông tin đăng nhập. Mã receipt đã có được dùng lại, không tạo danh tính giả.
- Admin tiếp tục dùng cookie HttpOnly và proxy `/api/trade/admin/...`, không đưa access token quản trị vào mã client.

## API

Tiền tố `/api/v1`. JSON trả `{success,data,meta?}`; `meta={page,limit,total,totalPages}`. DELETE thành công trả 204. Lỗi nghiệp vụ có `code`, `message`, `statusCode`.

| Nhóm                  | Endpoint                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Danh mục công khai    | `GET /trade-post-categories`                                                                                                                          |
| Danh mục quản trị     | `GET/POST /admin/trade-post-categories`; `GET/PATCH/DELETE /:id`; `PATCH /:id/status`; `PATCH /reorder`                                               |
| Khám phá tin          | `GET /trade-posts`, `GET /trade-posts/:idOrSlug`                                                                                                      |
| Đăng/sửa/xóa tin      | `POST /trade-posts`; `PATCH/DELETE /trade-posts/:id`; `GET /:id/manage`; `PATCH /:id/submit`                                                          |
| Tin của doanh nghiệp  | `GET /trade-posts/me`, `GET /trade-posts/me/analytics`, `GET /trade-posts/:id/analytics`                                                              |
| Kiểm duyệt            | `GET /admin/trade-posts`, `GET/PATCH/DELETE /admin/trade-posts/:id`; `PATCH /:id/approve`, `reject`, `hide`, `unhide`, `archive`, `feature`           |
| Thống kê quản trị     | `GET /admin/trade-posts/analytics/summary`, `GET /admin/trade-posts/:id/analytics`                                                                    |
| Lưu tin               | `GET /trade-posts/me/saved`; `POST/DELETE /trade-posts/:idOrSlug/save`                                                                                |
| Tương tác             | `POST /trade-posts/:idOrSlug/interactions` với `CONTACT_PHONE`, `CONTACT_ZALO`, `SHARE`                                                               |
| Đánh giá công khai    | `GET/POST /trade-posts/:id/reviews`; `GET /:id/reviews/summary`; `POST /:id/reviews/:reviewId/replies`                                                |
| Đánh giá của tôi      | `GET /reviews/me?tradePostId=...`; `PATCH/DELETE /reviews/:id`; `POST /reviews/:id/images`; `DELETE /reviews/:id/images/:imageId`                     |
| Phản hồi doanh nghiệp | `GET /trade-management/reviews`; `PUT/DELETE /trade-management/reviews/:id/reply`                                                                     |
| Kiểm duyệt đánh giá   | `GET /admin/reviews`, `/admin/reviews/stats`, `/admin/reviews/:id`; `PATCH /:id/status`; `DELETE /:id`                                                |
| Hội thoại             | `GET/POST /trade-conversations`; `GET /:id`; `GET/POST /:id/messages`; `PATCH /:id/read`; `GET /:id/events`                                           |
| Quản trị hội thoại    | `GET /admin/trade-conversations`, `/:id`, `/:id/messages`; `DELETE /:id`                                                                              |
| Ảnh                   | `POST /trade-media` với binary `application/octet-stream`, tối đa 1 MiB; `GET/HEAD /trade-media/:id`; `DELETE /trade-media/:id` khi chưa được sử dụng |
| Thông báo             | `GET /trade-notifications`; `PATCH /trade-notifications/read` với `{ids:[...]}`; `GET /admin/trade-notifications`                                     |
| Tài khoản             | `GET /admin/trade-users`; `PATCH /admin/trade-users/:id` với `status` hoặc `businessType`                                                             |

Query danh sách hỗ trợ phân trang, tìm theo tiêu đề/tóm tắt/địa chỉ, danh mục, chủ tin, nổi bật, mục đích, giá, nhóm ngành và các cách sắp xếp trong đặc tả. Tin không có giá xếp cuối ở cả hai chiều giá. `status` chỉ lọc danh sách của tôi/quản trị.

## Các bảo đảm nghiệp vụ

- Tạo luôn là `DRAFT`; gửi duyệt `PENDING`; Ban quản trị duyệt thành `PUBLISHED` hoặc trả `REJECTED` kèm lý do. Sửa các nội dung quan trọng của tin công bố đưa về `PENDING`.
- Hết hạn chỉ là điều kiện đọc, không đổi trạng thái tự động. `expiresAt` được ưu tiên; chỉ khi null mới dùng `eventEndAt`.
- PATCH kiểm tra bản ghi sau khi ghép thay đổi. Nullable nhận null để xóa. Giá bị xóa tự động ở tin cộng đồng; thời gian hoạt động bị xóa ở tin thương mại.
- Giữ các mã `businessType` tương thích tài liệu. Trên UI, `TEMPLE_MANAGEMENT` được gọi là “Đơn vị hoạt động cộng đồng” và chỉ đăng phi lợi nhuận.
- Danh mục dùng version để chống ghi đè. Tạo/sửa tin khóa danh mục trong transaction để tránh xóa danh mục đồng thời.
- Ảnh lưu riêng trong GridFS, chỉ chủ ảnh được gắn ảnh vào tin/đánh giá. Embedded danh sách ảnh giữ thứ tự. Media dùng danh sách tham chiếu để tránh xóa ảnh còn được dùng ở nơi khác; ảnh bị gỡ được dọn sau commit.
- Lưu tin, đánh giá và hội thoại dùng transaction. Bộ đếm lưu/điểm đánh giá được tính lại từ dữ liệu gốc; khóa ghi trên tin giúp các transaction đồng thời retry thay vì làm mất bộ đếm.
- Index partial unique của đánh giá giữ một đánh giá chưa xóa/người/tin; xóa xong được đánh giá lại.
- Hội thoại có unique `(tradePostId,customerId)`, không được tự nhắn tin cho tin của mình. Người ngoài nhận 404. Hội thoại đã đóng trả 410 và không mở lại.
- Ghi audit kiểm duyệt và thông báo bền vững trong DB. Thống kê và thông báo best-effort: lỗi không làm hỏng thao tác đã commit. Thông báo tin mới chỉ tạo ở lần duyệt công bố đầu.
- Giới hạn riêng theo đặc tả: đánh giá/trả lời 10/phút, mở hội thoại 30/phút, tin nhắn/lưu tin 60/phút, ghi danh mục 30/phút; vẫn có hạn mức API chung.

## Cập nhật hội thoại

Thay transport WebSocket của hệ thống gốc bằng **SSE có xác thực**, phù hợp backend HTTP/Vercel hiện tại. Giữ sự kiện `CHAT_MESSAGE` với payload `{conversationId,tradePostId,message}`. Mỗi kết nối tối đa 25 giây; client nối lại và đọc lịch sử từ DB. Mini App có kiểm tra lại lịch sử mỗi 10 giây khi đang mở hội thoại để phục hồi khi mạng/stream bị gián đoạn. Tin nhắn mới không tạo thông báo chuông; chỉ hội thoại mới tạo thông báo kết nối.

Thông báo khác được đọc trong mục Giao thương của hai FE. Chưa tích hợp gửi Zalo OA vì dự án chưa có kênh OA cho module này; dữ liệu và thông báo trong ứng dụng vẫn đầy đủ.

## Kiểm tra

### Bình luận và trả lời

- `GET /api/v1/trade-posts/:id/comments?page=1&limit=20`: danh sách bình luận, mới nhất trước; trả thông tin người viết và câu trả lời của chủ tin.
- `GET /api/v1/trade-posts/:id/comments/:commentId`: đọc đúng bình luận từ thông báo, kể cả bình luận nằm ở trang cũ.
- `POST /api/v1/trade-posts/:id/comments` nhận `{content}` (1–500 ký tự sau khi trim). Cần phiên giao thương đã xác thực; không bắt buộc đánh giá sao. Có thể bình luận nhiều lần.
- `PUT /api/v1/trade-posts/:id/comments/:commentId/reply` nhận `{content}`. Chỉ tài khoản người đăng tin được trả lời hoặc sửa câu trả lời; không nhận userId/ownerId từ client.
- Chỉ tin đang công bố, còn hiệu lực và thuộc danh mục hoạt động mới đọc/ghi bình luận được. Bình luận lưu trong `trade_comments`, phân trang và giới hạn ghi 10 lần/phút theo IP.
- Bình luận mới và thông báo `TRADE_COMMENT_RECEIVED` cho chủ tin được ghi trong cùng transaction. Câu trả lời và thông báo `TRADE_COMMENT_REPLIED` cho người bình luận cũng vậy. Người dùng tự bình luận tin của mình không nhận thông báo cho chính mình; cập nhật câu trả lời không đổi không tạo thông báo trùng.
- Thông báo có `commentId`, mở đúng trang chi tiết và khu vực bình luận. Chuông và danh sách đang mở cập nhật mỗi 15 giây khi ứng dụng ở foreground. Đây là thông báo trong Mini App; không gửi Zalo OA push.
- Giao diện mới có thẻ tin ngang, tab danh mục, sắp xếp, lưu tin, gọi điện, khu vực giao dịch, đánh giá sao và thanh liên hệ cố định. Tệp/ảnh vẫn chọn từ máy và dùng cơ chế tải lên hiện có; không thay đổi xác thực OA.

- `npm test` backend chạy cả các trường hợp xác thực, version, trạng thái, hiệu lực, lưu tin đồng thời, điểm đánh giá, quyền riêng tư hội thoại và ảnh trong replica set tạm.
- Admin: `npm test`, `npm run build`, `npm run lint`; có kiểm thử Host/origin và transport kiểm duyệt.
- Mini App: `npm test`, `npm run build`; kiểm thử trao đổi receipt lấy JWT, browse công khai và DELETE 204.
- Đã kiểm tra bằng trình duyệt với dữ liệu tạm: đăng tin/gửi duyệt → admin duyệt → xem/lưu/đánh giá → mở hội thoại → nhận tin nhắn phản hồi. Không tạo dữ liệu mẫu trên production.
