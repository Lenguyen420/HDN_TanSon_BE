# API Contract quản lý thu chi

Base path **`/api/v1/admin/finance`**. Tất cả endpoint yêu cầu `Authorization: Bearer <admin-access-token>`. Frontend Admin có thể chuyển tiếp qua proxy cùng origin đang giữ token trong cookie HttpOnly. Proxy cần chuyển tiếp query, JSON, `Idempotency-Key`, mã trạng thái và nội dung nhị phân. Với XLSX/chứng từ, chuyển tiếp `Content-Type` và `Content-Disposition` rồi tải tệp từ response dạng Blob.

## API và quyền

Hai vai trò dùng cùng cơ chế đăng nhập hiện tại. `SUPER_ADMIN` có mọi quyền trong bảng. `STAFF` được xem, xuất, tải chứng từ, tạo/sửa/hủy phiếu thủ công và đảo phiếu thủ công. JWT hội viên, Mini App, Giao thương và Zalo không truy cập được module.

| Method | Đường dẫn tương đối                     | Request                                                        | Response thành công                                                  | Quyền tối thiểu                                       |
| ------ | --------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| GET    | `/settings`                             | —                                                              | 200 `{data: FinanceSettings}`                                        | STAFF                                                 |
| POST   | `/settings/opening`                     | `{expectedOpeningDate, expectedOpeningBalance}`                | 201 `{data: FinanceSettings}`                                        | SUPER_ADMIN                                           |
| GET    | `/summary`                              | `from?, to?`                                                   | 200 `{data: Summary}`                                                | STAFF                                                 |
| GET    | `/daily`                                | `from?, to?, type?, q?, status?, includeEmpty?, page?, limit?` | 200 `{data: DailyRow[], pagination, from, to}`                       | STAFF                                                 |
| GET    | `/daily/:date`                          | `type?, q?, page?, limit?`                                     | 200 `{data: {...DailyRow, transactions: Transaction[], pagination}}` | STAFF                                                 |
| POST   | `/transactions/preview`                 | `{businessDate, type, amount}`                                 | 200 `{data: Preview}`                                                | STAFF                                                 |
| POST   | `/transactions`                         | `CreateTransaction` + header bắt buộc                          | 201 `{data: Transaction}`                                            | STAFF                                                 |
| PATCH  | `/transactions/:id`                     | Trường được sửa, `version` bắt buộc                            | 200 `{data: Transaction}`                                            | STAFF                                                 |
| POST   | `/transactions/:id/void`                | `{version, reason}`                                            | 200 `{data: Transaction}`                                            | STAFF                                                 |
| POST   | `/transactions/:id/reverse`             | `{businessDate, reason}` + header bắt buộc                     | 201 `{data: Transaction}`                                            | STAFF cho phiếu thủ công, SUPER_ADMIN cho phiếu nguồn |
| GET    | `/transactions/:id/audit`               | `page?, limit?`                                                | 200 `{data: AuditLog[], pagination}`                                 | STAFF                                                 |
| GET    | `/transactions/:id/attachments/:fileId` | —                                                              | 200 nhị phân PDF hoặc ảnh                                            | STAFF                                                 |
| POST   | `/daily/:date/close`                    | Không có body hoặc `{}`                                        | 200 `{data: DailyClose}`                                             | SUPER_ADMIN                                           |
| POST   | `/sponsorships/:id/receive`             | ID khoản tài trợ, `{businessDate}` + header bắt buộc           | 201 `{data: Transaction}`                                            | SUPER_ADMIN                                           |
| GET    | `/pending-receipts`                     | `page?, limit?`                                                | 200 `{data: PendingReceipt[], pagination}`                           | STAFF                                                 |
| GET    | `/export`                               | `from?, to?`                                                   | 200 tệp XLSX                                                         | STAFF                                                 |

Endpoint tạo phiếu, đảo phiếu và nhận tài trợ yêu cầu `Idempotency-Key` 1–128 ký tự, chỉ gồm chữ, số, dấu `.`, `_`, `:`, `-` (có thể dùng UUID). Retry cùng thao tác, cùng tài khoản và cùng body trả đúng kết quả ban đầu, kể cả sau khi phiếu đã sửa. Dùng key mới cho thao tác mới. PATCH và void dùng `version` đọc từ phiếu. Gửi lại thao tác chốt chính ngày đã chốt trả snapshot cũ.

## Ngày, số tiền và bộ lọc

- `businessDate`, `openingDate`, `from`, `to` và tham số `:date` là ngày `YYYY-MM-DD` ở `Asia/Ho_Chi_Minh`. Các timestamp trong JSON là UTC ISO 8601. Ngày tới tương lai bị từ chối.
- Số tiền là số JSON nguyên VND. Mỗi phiếu từ 1 đến 1.000.000.000.000 VND. Giới hạn số dư mở đầu, tổng chi và số dư mở đầu cộng tổng thu trong suốt sổ là 999.999.999.999.999 VND để số liệu chính xác cả trong Excel.
- `type`: `INCOME`, `EXPENSE`. `category`: `MEMBERSHIP_FEE`, `SPONSORSHIP`, `ACTIVITY`, `ADMINISTRATION`, `EVENT`, `OTHER`. `paymentMethod`: `CASH`, `BANK_TRANSFER`.
- `Transaction.status`: `POSTED`, `VOIDED`. `DailyRow.status`: `OPEN`, `CLOSED`. `sourceType`: `MANUAL`, `MEMBERSHIP_FEE`, `SPONSORSHIP`, `ADJUSTMENT`.
- `from` mặc định ngày đầu của tháng chứa `to`; `to` mặc định hôm nay. Khoảng bao gồm hai đầu. Nếu `from` trước ngày mở sổ thì lấy từ ngày mở sổ; khoảng nằm hoàn toàn trước ngày mở sổ trả 422. Lịch sử và XLSX tối đa 366 ngày mỗi lần.
- `pagination` gồm `page` từ 1 đến 100000, `limit` từ 1 đến 100 (mặc định lần lượt 1 và 20), `total` là số mục sau lọc. Ngày sắp xếp mới trước. Phiếu và audit trong một ngày sắp theo giờ tạo rồi ID tăng dần.
- Theo mặc định lịch sử liệt kê ngày có phiếu (kể cả ngày chỉ có phiếu hủy) hoặc snapshot chốt. Dùng `includeEmpty=true` để xem cả ngày trống. `type` và `q` lọc ngày có phiếu **đang ghi sổ** phù hợp, kể cả khi bật `includeEmpty`. `q` tối đa 200 ký tự, tìm chuỗi nguyên văn trong nội dung và không phân biệt hoa thường.
- Số dư đầu mỗi ngày kế thừa số dư cuối của ngày trước, kể cả qua ngày trống hoặc khi chưa thao tác chốt thủ công. Số dư cuối ngày bằng số dư đầu ngày cộng tổng thu trừ tổng chi của ngày đó.
- Báo cáo giữ nguyên số dư và tổng thực tế khi áp dụng bộ lọc lịch sử. Chi tiết ngày hiển thị cả phiếu hủy; bộ lọc nếu có chỉ tác động đến danh sách phiếu. Khoảng ngày đầu kỳ/cuối kỳ dùng số dư ở đầu/cuối kỳ; phiếu hủy không tính vào số tiền.

## Request và response

### Thiết lập ban đầu

`GET /settings` trước khi mở sổ:

```json
{
  "data": {
    "initialized": false,
    "openingDate": null,
    "openingBalance": null,
    "closedThrough": null,
    "openingProposal": {
      "openingDate": "2026-11-23",
      "openingBalance": 20000000,
      "feePaymentCount": 12
    }
  }
}
```

`openingProposal` chứa ngày hiện tại theo giờ Việt Nam và tổng số tiền thanh toán hội phí đã xác nhận thực nhận, sau khi loại các khoản đã hoàn tiền. `POST /settings/opening` nhận `{"expectedOpeningDate":"2026-11-23","expectedOpeningBalance":20000000}` lấy nguyên giá trị từ đề xuất để xác nhận. Backend kiểm tra lại ngày và số tiền trong transaction trước khi mở sổ. Nếu giá trị thay đổi, API trả `409 FINANCE_OPENING_CHANGED` để Frontend tải lại.

Thành công trả `initialized: true`, `openingDate`, `openingBalance`, `openingFeePaymentCount`, `closedThrough: null`, `createdBy` và `createdAt`. Chỉ mở sổ một lần. Sổ đã được mở từ trước tiếp tục dùng số dư gốc đã lưu. Sau khi chốt, `closedThrough` là ngày mới nhất đã chốt.

### Tổng hợp và theo ngày

`GET /summary?from=2026-11-23&to=2026-11-25`:

```json
{
  "data": {
    "from": "2026-11-23",
    "to": "2026-11-25",
    "openingBalance": 20000000,
    "totalIncome": 2000000,
    "totalExpense": 500000,
    "closingBalance": 21500000,
    "breakdown": [
      { "category": "ACTIVITY", "totalIncome": 0, "totalExpense": 500000 },
      {
        "category": "MEMBERSHIP_FEE",
        "totalIncome": 2000000,
        "totalExpense": 0
      }
    ]
  }
}
```

`GET /daily?from=2026-11-23&to=2026-11-23`:

```json
{
  "data": [
    {
      "businessDate": "2026-11-23",
      "openingBalance": 20000000,
      "totalIncome": 2000000,
      "totalExpense": 500000,
      "closingBalance": 21500000,
      "contentSummary": "Thu hội phí; In tài liệu",
      "status": "OPEN",
      "transactionCount": 2,
      "matchingTransactionCount": 2,
      "activityCount": 2,
      "closedBy": null,
      "closedAt": null
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1 },
  "from": "2026-11-23",
  "to": "2026-11-23"
}
```

`transactionCount` đếm toàn bộ phiếu đang ghi sổ, `matchingTransactionCount` đếm phiếu đang ghi sổ khớp bộ lọc, `activityCount` kể cả phiếu hủy. `contentSummary` lấy tối đa 3 nội dung phù hợp. Chi tiết `GET /daily/2026-11-23` trả `data` là một hàng tổng hợp của ngày (không lọc) kèm `transactions` và `pagination` cho phiếu. Mỗi phiếu trong danh sách có `reversal: null` hoặc `reversal: {id, businessDate}` nếu đã bị đảo. Dùng giá trị này để ẩn thao tác sửa/hủy/đảo và dẫn đến phiếu đảo, kể cả khi phiếu gốc đang nằm trong ngày đã chốt.

Chốt trả `DailyClose` với `businessDate`, `openingBalance`, `totalIncome`, `totalExpense`, `closingBalance`, `status: "CLOSED"`, `closedBy`, `closedAt`. Chốt theo thứ tự, có thể bỏ qua ngày không còn phiếu đang ghi sổ. Ngày bị bỏ qua trước mốc chốt cũng bị khóa; `closedBy` và `closedAt` của ngày đó là `null`.

### Tạo, sửa, hủy và đảo phiếu

`POST /transactions`:

```json
{
  "businessDate": "2026-11-25",
  "type": "EXPENSE",
  "amount": 1200000,
  "content": "Chi phí họp Ban chấp hành",
  "category": "ACTIVITY",
  "paymentMethod": "BANK_TRANSFER",
  "counterparty": "Nguyễn Văn A",
  "referenceNo": "UNC-2026",
  "note": "Đã kiểm tra chứng từ",
  "attachments": [{ "name": "chung-tu.pdf", "base64": "JVBERi0xLjQ=" }]
}
```

Sáu trường đầu bắt buộc; `content` tối đa 1000 ký tự. `counterparty`, `referenceNo` tối đa 250 ký tự; `note` tối đa 2000. `attachments` tối đa 3 tệp PDF/JPG/PNG/WebP, chứa base64 thuần. Giới hạn 1 MiB mỗi tệp và 2 MiB tệp mới mỗi request. Mã phiếu, người tạo, nguồn và số dư do backend xác định.

```json
{
  "data": {
    "id": "3cbe1799-8863-4df5-b592-25dfa11e5b7a",
    "code": "TC-3CBE1799-8863-4DF5-B592-25DFA11E5B7A",
    "businessDate": "2026-11-25",
    "type": "EXPENSE",
    "amount": 1200000,
    "content": "Chi phí họp Ban chấp hành",
    "category": "ACTIVITY",
    "paymentMethod": "BANK_TRANSFER",
    "counterparty": "Nguyễn Văn A",
    "referenceNo": "UNC-2026",
    "note": "Đã kiểm tra chứng từ",
    "sourceType": "MANUAL",
    "status": "POSTED",
    "createdBy": "admin-id",
    "updatedBy": "admin-id",
    "version": 1,
    "createdAt": "2026-11-25T02:00:00.000Z",
    "updatedAt": "2026-11-25T02:00:00.000Z",
    "attachments": [
      {
        "id": "file-id",
        "name": "chung-tu.pdf",
        "type": "application/pdf",
        "size": 8,
        "url": "/api/v1/admin/finance/transactions/3cbe1799-8863-4df5-b592-25dfa11e5b7a/attachments/file-id"
      }
    ]
  }
}
```

Phiếu nguồn có `sourceId`, `sourceEventKey`; phiếu đảo có `reversalOf`. Phiếu nguồn hội phí dùng ID thanh toán để tra chứng từ ở endpoint hội phí Admin hiện có, nếu thanh toán có ảnh minh chứng.

- `POST /transactions/preview` nhận `{"businessDate":"2026-11-25","type":"EXPENSE","amount":1200000}`. Ví dụ trả `{"data":{"businessDate":"2026-11-25","beforeBalance":21500000,"afterBalance":20300000,"firstNegativeDate":null,"withinLimit":true,"allowed":true}}`. Đây là số dư cuối ngày trước/sau khi thêm phiếu. Giá trị chính thức được kiểm tra lại khi lưu, gồm cả các ngày sau chịu ảnh hưởng.
- `PATCH /transactions/:id` nhận ví dụ `{"version":1,"content":"Chi phí họp đã đối chiếu","retainAttachmentIds":[]}`. Khi không gửi `retainAttachmentIds`, giữ mọi chứng từ cũ; mảng rỗng gỡ toàn bộ khỏi phiếu. Tệp đã gỡ vẫn có thể tải từ lịch sử audit. Cả ngày cũ và ngày mới phải đang mở.
- `POST /transactions/:id/void` nhận ví dụ `{"version":2,"reason":"Nhập nhầm chứng từ"}`. Phiếu trả về có `status: "VOIDED"` và `version` mới.
- `POST /transactions/:id/reverse` nhận ví dụ `{"businessDate":"2026-11-25","reason":"Đã hoàn tiền"}`. Lập phiếu ngược chiều toàn bộ giá trị, vào ngày mở bằng hoặc sau ngày gốc. Phiếu gốc và số liệu ngày chốt được giữ lại. Nếu cần sửa một phần sai sót, lập phiếu đảo toàn bộ rồi tạo phiếu đúng. Mỗi phiếu gốc chỉ có một phiếu đảo. Với phiếu nguồn, chỉ thực hiện khi đã hoàn tiền hoặc cần hủy xác nhận thực nhận.
- `GET /transactions/:id/audit` trả mảng `{id, entityId, action, before, after, reason, actorId, createdAt}` và `pagination`. `action` của phiếu gồm `CREATE`, `UPDATE`, `VOID`, `REVERSE`, `REVERSED`, `SOURCE_RECEIVED`. `REVERSED` có `after: {reversalId}`; các sự kiện tạo có `before: null`. Khởi tạo và chốt cũng được lưu audit cùng người thực hiện.

### Xác nhận nguồn và xuất báo cáo

- Hai route hội phí cũ `POST /api/v1/admin/membership-fee-payments/:id/confirm` và `POST /api/v1/admin/membership-fee-dues/:id/manual-payment` tự ghi phiếu thu từ số tiền đã xác nhận sau khi mở sổ. Luồng gửi/từ chối minh chứng không tạo phiếu. Đảo phiếu hội phí giữ thanh toán gốc, chứng từ và dấu vết hoàn tiền; khoản phải đóng chuyển về chưa đóng nếu đợt đang mở, hoặc đã hủy nếu đợt đã ngừng.
- Hội phí thực nhận sau khi đã chốt trong ngày được lưu cùng giao dịch xác nhận vào hàng đợi. `GET /pending-receipts` trả `{id,postOn,createdAt,receivedOn,amount,sourceType,sourceId,referenceNo}` cho các khoản đang chờ ngày mở. Từ ngày kế tiếp, lượt đọc báo cáo hoặc thao tác ghi sổ sẽ chuyển khoản đến hạn vào sổ một lần duy nhất. Snapshot ngày đóng không đổi. Trước khi ghi sổ, khoản chờ chưa có phiếu để đảo.
- `POST /sponsorships/:id/receive` nhận ví dụ `{"businessDate":"2026-11-25"}`. ID đến từ `GET /api/v1/admin/partners/:id` trong danh sách `contributions`. Dùng ngày tiền thực nhận, khác ngày đăng bài nếu cần. Backend lấy tiền và hình thức từ khoản tài trợ. Sau xác nhận, các trường `financeReceiptId`, `financeReceivedDate`, `financeReceivedAt`, `financeReceivedBy` có mặt trong phản hồi Admin của khoản tài trợ; nếu hoàn tiền có thêm `financeRefundId`, `financeRefundedAt`, `financeRefundedBy`. Tài trợ tiền đã ghi sổ phải hoàn tiền trước khi xóa hoặc sửa loại, số tiền, hình thức. Một khoản tài trợ có một lần xác nhận thực nhận; khoản thu mới dùng bản ghi tài trợ mới. Hiện vật và đăng bài công khai không tạo phiếu.
- `GET /export` tải `thu-chi-<from>-<to>.xlsx`, MIME `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Sheet **Tổng hợp ngày** có tất cả ngày trong kỳ kể cả ngày trống; sheet **Chi tiết phiếu** có cả phiếu hủy và phiếu đảo. Nội dung do người dùng nhập được lưu dạng văn bản trong XLSX nên dấu `=`, `+`, `-`, `@` không chạy công thức. Mỗi lần xuất tối đa 10.000 phiếu và 4 MiB.

## Lỗi

Lỗi nghiệp vụ trả ví dụ `{"statusCode":409,"success":false,"code":"FINANCE_DATE_CLOSED","message":"Ngày đã chốt sổ."}`. Lỗi validation Zod dùng `{statusCode:400,message:string[]}`. Auth và rate limit dùng envelope hiện tại `{statusCode,message}`.

| HTTP | Mã hoặc tình huống                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | Validation, `FINANCE_INVALID_IDEMPOTENCY_KEY`, `FINANCE_INVALID_ATTACHMENTS`, định dạng chứng từ sai                                                                                                                                                                                                                                                    |
| 401  | JWT thiếu, sai hoặc hết hạn                                                                                                                                                                                                                                                                                                                             |
| 403  | `FINANCE_FORBIDDEN` cho thao tác yêu cầu vai trò cao hơn                                                                                                                                                                                                                                                                                                |
| 404  | `FINANCE_ENTRY_NOT_FOUND`, `FINANCE_ATTACHMENT_NOT_FOUND`, `FINANCE_SPONSORSHIP_NOT_FOUND`                                                                                                                                                                                                                                                              |
| 409  | `FINANCE_NOT_INITIALIZED`, `FINANCE_ALREADY_INITIALIZED`, `FINANCE_OPENING_CHANGED`, `FINANCE_DATE_CLOSED`, `FINANCE_CLOSE_OUT_OF_ORDER`, `FINANCE_ENTRY_LOCKED`, `FINANCE_VERSION_CONFLICT`, `FINANCE_IDEMPOTENCY_CONFLICT`, `FINANCE_NOT_REVERSIBLE`, `FINANCE_SPONSORSHIP_ALREADY_RECEIVED`, `FINANCE_SPONSORSHIP_LOCKED`, `FINANCE_SOURCE_CONFLICT` |
| 413  | Body hoặc chứng từ vượt giới hạn                                                                                                                                                                                                                                                                                                                        |
| 422  | `FINANCE_DATE_OUT_OF_RANGE`, `FINANCE_INSUFFICIENT_FUNDS`, `FINANCE_REVERSAL_DATE`, `FINANCE_SPONSORSHIP_NOT_CASH`, `FINANCE_TOTAL_LIMIT`, `FINANCE_RANGE_TOO_LONG`, `FINANCE_EXPORT_LIMIT`                                                                                                                                                             |
| 429  | Giới hạn tần suất hiện có                                                                                                                                                                                                                                                                                                                               |

Với lỗi version/day closed, tải lại chi tiết trước khi trình bày trạng thái hoặc lưu lần nữa. Với lỗi mạng khi tạo/đảo/xác nhận, giữ nguyên dữ liệu form và key đến khi biết kết quả. Kiểm tra `GET /settings` trước khi tải báo cáo và hiển thị thao tác mở sổ theo vai trò.

## Triển khai, đối soát và kiểm thử

- Dùng MongoDB Atlas hoặc MongoDB replica set (MongoDB 5.2 trở lên cho truy vấn tổng hợp ngày). Khởi động Backend bằng lệnh hiện tại `npm start` hoặc `npm run start:local` để tạo các collection `finance_*`, index và bản ghi khóa kỹ thuật. Migration cộng thêm schema, không thay đổi/xóa bản ghi cũ. Không cần chạy lệnh backfill. Tài khoản DB cần quyền tạo collection/index như các module hiện có.
- `SUPER_ADMIN` xác nhận mở sổ trong ngày hiện tại theo giờ Việt Nam. Thanh toán hội phí đã thực nhận trước thời điểm mở sổ được tính một lần vào số dư đầu kỳ. Hội phí thực nhận sau thời điểm mở sổ được ghi thành phiếu thu. Đối chiếu sổ với tiền mặt và ngân hàng. Khoản chi cũ hoặc khoản thu ngoài hội phí chưa xuất hiện trong hệ thống cần được ghi nhận bằng phiếu phù hợp sau khi mở sổ. Khoản tài trợ công khai chỉ được tính từ khi xác nhận thực nhận.
- Chạy `node --test test/finance.test.cjs` trên MongoDB replica set tạm, rồi `npm test` cho toàn bộ Backend. Kiểm tra môi trường tích hợp bằng cách đăng nhập cả hai vai trò, mở sổ, tạo phiếu có chứng từ, gửi lại cùng key, xem số dư liên ngày, xác nhận một khoản hội phí và một tài trợ tiền, chốt, đảo phiếu vào ngày mở rồi tải XLSX. Dùng database thử nghiệm và không khởi tạo số dư minh họa trên production.
