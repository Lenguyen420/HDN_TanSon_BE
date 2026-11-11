# Backend Hội Doanh nghiệp Phường Tân Sơn

Express 5 + JavaScript ES Modules + Mongoose + MongoDB, cùng công nghệ chính với dự án job-portal/server. Mã nguồn ở thư mục hdn_tanson_be; frontend Next.js ở D:\HDN_TanSon_Admin\admin-dashboard.

## Chạy với MongoDB Atlas

1. Mở file .env có sẵn. Điền MONGODB_URI bằng URI Atlas có database riêng, ví dụ tanson_association. URI không được bắt đầu bằng dấu #, phải có dạng mongodb+srv://.../tanson_association?... (không dùng nguyên dấu ...).
2. Trong Atlas, tạo Database User có quyền readWrite trên database này và cho phép địa chỉ IP của máy chạy backend. Mật khẩu có ký tự đặc biệt phải được mã hóa URL trong URI.
3. Kiểm tra ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_NAME trong .env. ADMIN_PASSWORD tối thiểu 12 ký tự. JWT_SECRET đã được tạo ngẫu nhiên; không đưa .env lên Git.
4. Chạy các lệnh tại thư mục này:

~~~powershell
npm install
npm run start:dev
~~~

Backend mặc định chạy ở http://127.0.0.1:4000/api/v1. GET /api/v1/health trả ok khi MongoDB đang kết nối; trả HTTP 503 nếu mất kết nối.

Lần chạy đầu tạo tài khoản quản trị nếu username chưa có. Việc đổi ADMIN_PASSWORD trong .env không đặt lại mật khẩu tài khoản đã tồn tại. Không có API đăng ký quản trị công khai. JavaScript chạy trực tiếp. npm run build kiểm tra cú pháp; production chạy npm start; cấu hình database và JWT_SECRET riêng theo môi trường.

## Cấu trúc

Giữ các thư mục trong src như trước, chuyển toàn bộ mã thực thi sang JavaScript ES Modules:

~~~text
src/
  config/
    database.js              # Kết nối, DNS và log MongoDB
    environment.js           # Đọc và kiểm tra .env
    jwt.js                   # Ký/xác minh JWT với jsonwebtoken
  controllers/
    authController.js
    memberController.js
    registrationController.js
    healthController.js
  models/
    AdminUser.js
    AuthSession.js
    Member.js
    Registration.js
  routers/
    appRouter.js             # Ghép Express Router dưới /api/v1
    authRouter.js
    memberRouter.js
    registrationRouter.js
  services/
    authService.js
    memberService.js
    registrationService.js
  middlewares/
    authAdmin.js             # Xác thực và phân quyền
    errorMiddleware.js       # JSON lỗi dùng chung
    validateRequest.js       # Kiểm tra body/query
    rateLimit.js             # Giới hạn tần suất request
  dto/
    auth.dto.js              # Schema Zod
    member.dto.js
    registration.dto.js
  utils/
    password.js              # bcrypt và tương thích mật khẩu cũ
    httpError.js
  main.js                    # Tạo app Express và khởi động server
test/
  api.test.cjs
scripts/
  check.cjs                  # Kiểm tra cú pháp JavaScript
nodemon.json
~~~

Luồng xử lý: request → routers → middleware → controllers → services → models → MongoDB. Routes được khai báo bằng Express Router. Controller chuyển request/response, service xử lý nghiệp vụ, schema Mongoose giữ cấu trúc collection và index. DTO dùng Zod để từ chối dữ liệu sai hoặc trường không được phép.

Không còn dependency NestJS, TypeScript hay decorator trong mã đang chạy. Bản NestJS trước khi chuyển công nghệ nằm tại .reference/nestjs-before-express, được Git/nodemon bỏ qua; không chứa .env. Dự án mẫu job-portal/server không bị chỉnh sửa.

Chạy phát triển bằng npm run start:dev hoặc npm run server; cả hai dùng nodemon. npm start chạy node src/main.js. Chỉ chạy một backend ở cổng 4000. Nodemon tự tải lại khi sửa file .js trong src hoặc .env.

Collection, id, JWT_SECRET và đường dẫn /api/v1 được giữ nguyên. Mật khẩu mới dùng bcrypt. Tài khoản scrypt có sẵn vẫn đăng nhập được; hash được nâng cấp sau lần xác thực thành công, không đặt lại mật khẩu và không thu hồi phiên cũ. Mật khẩu dài hơn 72 byte được SHA-256 trước khi băm bcrypt và đánh dấu định dạng để giữ toàn bộ mật khẩu. Refresh token vẫn lưu dưới dạng SHA-256 như trước.

## API

Tất cả đường dẫn bên dưới có tiền tố /api/v1. Các API hội viên và /auth/me yêu cầu Authorization: Bearer <accessToken>.

| Method | Đường dẫn | Chức năng |
| --- | --- | --- |
| POST | /auth/admin-login | Body username, password |
| POST | /auth/refresh | Body refreshToken, xoay refresh token |
| POST | /auth/logout | Body refreshToken, thu hồi phiên |
| GET | /auth/me | Tài khoản đang đăng nhập |
| GET | /admin/members | Danh sách, tìm kiếm, lọc, phân trang |
| GET | /admin/members/:id | Chi tiết hội viên |
| POST | /admin/members | Tạo hội viên |
| PUT | /admin/members/:id | Cập nhật đầy đủ các trường hồ sơ |
| DELETE | /admin/members/:id | Xóa mềm hội viên |
| POST | /admin/members/import | Chuyển danh sách cũ, giữ mã, bỏ qua mã đã tồn tại |

GET /admin/members nhận page (mặc định 1), limit (mặc định 20, tối đa 100), search, status=active|inactive, isBoard=true|false.

Body hội viên:

~~~json
{
  "name": "Nguyễn Văn Mẫu",
  "company": "Công ty TNHH Mẫu",
  "phone": "0900000001",
  "email": "mau@example.com",
  "birthDate": "1990-01-15",
  "joinedAt": "2026-11-11",
  "jobTitle": "Giám đốc",
  "companyAddress": "Địa chỉ minh họa",
  "status": "active",
  "isBoard": false,
  "position": "Hội viên"
}
~~~

id có thể bỏ trống khi tạo để backend sinh UUID. Khi chuyển dữ liệu cũ phải có id. API import nhận {"members":[...]} tối đa 100 hồ sơ mỗi yêu cầu; mã đã tồn tại (kể cả đã xóa mềm) không bị ghi đè. Nếu lỗi database giữa batch, các hồ sơ trước đó có thể đã được thêm; có thể thử lại do import giữ tính lặp an toàn theo id.

Ngày dùng YYYY-MM-DD. Backend từ chối ngày không tồn tại, ngày sinh tương lai, giá trị trạng thái sai và trường ngoài DTO. isBoard chỉ là thông tin Ban chấp hành, không cấp quyền quản trị.

Response danh sách: {"data":[...],"pagination":{"page":1,"limit":20,"total":0}}. Tạo/sửa/chi tiết trả {"data":{...}}. Lỗi trả {"statusCode":400,"message":"..."} (message có thể là mảng).

Access token sống 15 phút, session sống tối đa 7 ngày. Refresh token được lưu dưới dạng hash và xoay khi dùng. Guard kiểm tra session nên đăng xuất thu hồi cả quyền dùng access token còn hạn. Hai role quản trị hiện hỗ trợ là SUPER_ADMIN và STAFF. Login giới hạn 10 yêu cầu/phút/IP, toàn bộ API mặc định 120/phút/IP. Nếu deploy nhiều instance cần chuyển bộ đếm giới hạn tần suất sang kho dùng chung.

## Nối frontend

.env.local của Next.js:

~~~env
ASSOCIATION_API_URL=http://127.0.0.1:4000/api/v1
~~~

Frontend gọi Next.js cùng origin, Next.js giữ token trong cookie HttpOnly và chuyển tiếp tới backend. Không đặt MongoDB URI hay JWT_SECRET trong NEXT_PUBLIC_*. Dữ liệu hội viên, Ban chấp hành và hồ sơ đăng ký lấy từ backend; các module nội dung khác hiện vẫn cục bộ. API không tự nạp hội viên mẫu. FE hiện chỉ dùng dữ liệu hội viên/hồ sơ lấy từ backend và đã bỏ các nút chuyển dữ liệu mẫu cũ.

Hồ sơ đăng ký đã có collection `registrations` và API quản trị riêng. Phần xác thực dùng cùng tài khoản backend; mật khẩu độc lập với Kidoedu cũ.

## Kiểm tra

~~~powershell
npm run build
npm test
npm run format:check
~~~

npm test tải MongoDB binary ở lần đầu và chạy database tạm, tự dọn khi kết thúc. Không dùng thông tin Atlas để kiểm thử. Kiểm thử Next.js tùy chọn: chạy bản frontend riêng trên cổng 3004 với ASSOCIATION_API_URL=http://127.0.0.1:4001/api/v1, rồi đặt TEST_FRONTEND_URL=http://localhost:3004 khi chạy npm test; cổng 4001 phải trống. Không dùng biến TEST_FRONTEND_URL khi chạy backend thật.

## Lỗi DNS Atlas trên máy phát triển

Nếu DNS mặc định trả `querySrv ECONNREFUSED`, có thể đặt `MONGODB_DNS_SERVERS=1.1.1.1,8.8.8.8` trong `.env`. Thiết lập chỉ áp dụng cho tiến trình Node.js của backend; không thay đổi DNS Windows. Để trống biến này để dùng DNS mặc định.

## API hồ sơ đăng ký và xét duyệt

Tất cả đường dẫn dưới đây có tiền tố /api/v1.

| Method | Đường dẫn | Chức năng |
| --- | --- | --- |
| POST | /public/registrations | Mini App gửi hồ sơ mới, không cần token, giới hạn 5 yêu cầu/phút/IP |
| GET | /admin/registrations | Danh sách, page/limit/search/status |
| GET | /admin/registrations/:id | Chi tiết và kết quả xử lý |
| POST | /admin/registrations | Quản trị tạo hồ sơ chờ duyệt |
| PUT | /admin/registrations/:id | Chỉ sửa hồ sơ pending |
| DELETE | /admin/registrations/:id | Xóa mềm hồ sơ chưa duyệt; không xóa approved |
| POST | /admin/registrations/:id/approve | Body {}, duyệt và tạo hội viên bằng transaction |
| POST | /admin/registrations/:id/reject | Body {"reason":"Thiếu thông tin"}, từ chối hồ sơ pending |
| POST | /admin/registrations/import | Body {"registrations":[...]}, chuyển hồ sơ cũ, tối đa 100/lần |

Các API /admin yêu cầu token. Người gửi hồ sơ qua /public không được chỉ định id, date, status, memberId, isBoard hoặc thông tin duyệt. Backend tự đặt ngày đăng ký và pending, chỉ trả id/status khi tiếp nhận, không có API công khai liệt kê hồ sơ.

Body quản trị tạo/sửa:

~~~json
{
  "fullName": "Nguyễn Văn Mẫu",
  "company": "Công ty TNHH Mẫu",
  "phone": "0900000001",
  "email": "mau@example.com",
  "birthDate": "1990-01-15",
  "jobTitle": "Giám đốc",
  "companyAddress": "Địa chỉ minh họa",
  "taxCode": "",
  "date": "2026-11-11",
  "note": "Mong muốn tham gia Hội"
}
~~~

Body public giống các trường trên nhưng bỏ date. fullName/company/phone bắt buộc. Quản trị có thể cung cấp id khi tạo để phục vụ chuyển đổi. Không dùng PUT để đổi status; dùng approve/reject.

Duyệt dùng MongoDB transaction: cập nhật hồ sơ thành approved và tạo hội viên (isBoard=false, position=Hội viên) cùng một giao dịch. Nếu tạo hội viên lỗi, hồ sơ vẫn pending. Hai yêu cầu duyệt cùng lúc chỉ một yêu cầu thành công, yêu cầu còn lại trả 409. Tạo unique index có điều kiện trên members.sourceRegistrationId và registrations.memberId để giữ quan hệ một-một. Atlas hỗ trợ transaction; môi trường local cần replica set. Bộ test dùng MongoMemoryReplSet riêng và không tác động Atlas.

Hồ sơ được lưu reviewedBy, reviewedAt, rejectionReason và memberId. Hồ sơ approved/rejected không sửa lại nội dung hoặc quyết định. Xóa mềm vẫn giữ dữ liệu kiểm tra trên database. GET có thể lọc status=pending|approved|rejected; limit tối đa 100.

Import giữ trạng thái cũ, không ghi đè theo id và không tạo lại hồ sơ đã xóa mềm. Hồ sơ approved phải có memberId trỏ tới hội viên đã có (có thể đã xóa mềm để giữ lịch sử); chuyển hội viên trước khi chuyển hồ sơ đã duyệt. Không tự tạo hội viên trong thao tác import. Mỗi hồ sơ import dùng transaction riêng; response trả {data:{imported,skipped,failed:[{id,message}]}} để biết các hồ sơ chưa chuyển được. importedBy lưu người thực hiện import; không giả lập người hoặc thời điểm đã duyệt trước đây.

Frontend đã bỏ nút chuyển hồ sơ mẫu cũ. API import vẫn có thể dùng cho chuyển dữ liệu nghiệp vụ được chuẩn bị riêng. Trạng thái duyệt và số liệu chờ duyệt trên giao diện lấy từ API. Mini App chưa được sửa ở repository hiện tại; endpoint public sẵn sàng để nối ở giai đoạn sau.
