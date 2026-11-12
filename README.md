# Backend Hội Doanh nghiệp Phường Tân Sơn

## Đăng nhập Zalo OAuth trên web

Backend Express hỗ trợ OAuth v4 theo mẫu controller Zalo với PKCE SHA-256. Tài liệu giao thức: https://docs.zaloplatforms.com/docs/Social/social-api/tham-khao/user-access-token-v4.

Thêm Environment Variables trên Vercel backend:

~~~env
ZALO_APP_ID=<App ID của ứng dụng Zalo Social Login>
ZALO_APP_SECRET=<App Secret của cùng ứng dụng>
ZALO_REDIRECT_URI=https://behdntanson.vercel.app/api/v1/auth/zalo/callback
~~~

Giữ `JWT_SECRET` ít nhất 32 ký tự; khóa này cũng được dùng để dẫn xuất khóa mã hóa token Zalo. Đổi khóa sẽ vô hiệu các phiên OAuth đang có. Trong Zalo Developers → ứng dụng → Đăng nhập → Web, đăng ký chính xác callback URL trên rồi redeploy backend. Không dùng ID Official Account thay App ID. Không đưa App Secret vào frontend.

| Method | Đường dẫn | Chức năng |
| --- | --- | --- |
| GET | `/api/v1/auth/zalo/login` | Mở bằng điều hướng trình duyệt để chuyển sang trang cấp quyền Zalo |
| GET | `/api/v1/auth/zalo/callback` | Zalo trả code/state, backend đổi code và xác minh hồ sơ, trả JSON người dùng/hội viên và đặt cookie phiên |
| GET | `/api/v1/auth/zalo/me` | Kiểm tra danh tính hiện tại bằng cookie phiên |
| POST | `/api/v1/auth/zalo/logout` | Thu hồi phiên và xóa cookie |

State/verifier lưu trong MongoDB, ràng buộc cookie trình duyệt, hết hạn sau 10 phút và chỉ được sử dụng một lần. Phiên cookie HttpOnly, SameSite=Lax, Secure trên HTTPS sống tối đa 15 phút (không vượt thời hạn token Zalo). MongoDB chỉ giữ hash mã phiên và token Zalo được mã hóa AES-256-GCM; không trả access/refresh token ra JSON hoặc URL. Không tự làm mới token; hết phiên thì đăng nhập lại. Callback hiện trả JSON, chưa chuyển về một trang frontend cụ thể.

Các API `/member/identity`, `/member/members` và `/member/session` nhận cookie OAuth hoặc Bearer token từ Mini App. Kiểm tra hội viên đang hoạt động ở mỗi yêu cầu; đăng nhập Zalo không tạo quyền admin hay tự tạo hồ sơ hội viên. OAuth web không tự cung cấp số điện thoại; luồng Mini App xin quyền tên/ảnh/số điện thoại bằng SDK vẫn giữ nguyên. Không giả định ID từ hai ứng dụng Zalo khác nhau tương đương: phải dùng đúng ứng dụng đã cấu hình.

Cookie SameSite=Lax dùng cho web cùng site; frontend khác site cần một luồng chuyển tiếp cùng origin trước khi dùng cookie. Không chỉ thêm `credentials: include` để vượt giới hạn cookie cross-site. Khi phát triển localhost có thể dùng callback HTTP localhost với cùng đường dẫn nếu môi trường không phải production và đã đăng ký callback tương ứng trên Zalo.

Kiểm thử OAuth dùng MongoDB tạm và giả lập phản hồi máy chủ Zalo: PKCE, chống CSRF, state một lần, token mã hóa, phiên qua instance, thu hồi/hết hạn và phân quyền. Đăng nhập Zalo thật cần cấu hình ứng dụng và thử bằng tài khoản đã cấp quyền.

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

## Deploy backend lên Vercel

`vercel.json` chọn framework Express, giữ bước kiểm tra cú pháp và để Vercel tự xác định output. `src/index.js` export Express app cho Vercel; MongoDB chỉ kết nối khi có request đầu tiên, dùng lại app/kết nối cho các request tiếp theo trong cùng instance. `npm start` vẫn dùng `src/main.js` khi chạy máy chủ thông thường.

Trong Vercel Project → Settings → Build and Deployment:

1. Root Directory phải trỏ tới thư mục chứa `package.json` và `vercel.json` của backend này.
2. Chọn Framework Preset **Express**; tắt override Output Directory đang đặt `public`. Không tạo `public` hoặc đổi output thành `dist`: backend không sinh website tĩnh.
3. Thêm Environment Variables theo `.env.example`: `MONGODB_URI`, `JWT_SECRET` (ít nhất 32 ký tự), `ADMIN_USERNAME`, `ADMIN_PASSWORD` (ít nhất 12 ký tự), `ADMIN_NAME`, `CORS_ORIGINS` (origin frontend thật). Thêm `ZALO_APP_SECRET` nếu dùng xác thực Mini App. Cấu hình Atlas cho phép backend kết nối.
4. Push mã nguồn đã sửa và Redeploy. Kiểm tra `https://<backend-domain>/api/v1/health`. Đường dẫn `/` trả 404 vì không có API tại đó. Đặt `ASSOCIATION_API_URL=https://<backend-domain>/api/v1` trên frontend rồi redeploy frontend.

Các cảnh báo `npm fund`, `cache-dir` và install scripts trong log không phải nguyên nhân của `STATIC_BUILD_NO_OUT_DIR`. Nếu có lỗi bcrypt khi chạy thật, xem lại quyền chạy install script của `bcrypt`; `mongodb-memory-server` chỉ dùng khi kiểm thử.

**Lưu ảnh trên Vercel:** Backend tự lưu ảnh mới trong MongoDB GridFS (bucket `images`), dùng chung `MONGODB_URI`. API `/uploads/{folder}/{filename}` đọc ảnh từ MongoDB, giữ nguyên đường dẫn trong nội dung. Không cần khóa dịch vụ lưu trữ ngoài. Local mặc định dùng ổ đĩa; đặt `IMAGE_STORAGE=mongodb` để dùng GridFS khi chạy local.

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

Frontend gọi Next.js cùng origin, Next.js giữ token trong cookie HttpOnly và chuyển tiếp tới backend. Không đặt MongoDB URI hay JWT_SECRET trong NEXT_PUBLIC_*. Dữ liệu hội viên, Ban chấp hành, hồ sơ đăng ký, tin tức, sự kiện, thăm hội viên, thông báo, banner và thông tin Hội lấy từ backend. Hội phí, tài trợ và lịch sử tham gia còn lưu cục bộ. API không tự nạp dữ liệu mẫu hoặc tự chuyển nội dung cũ trong trình duyệt lên MongoDB.

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

## API nội dung và hoạt động

Đã nối đủ 5 màn hình trong nhóm **Nội dung & hoạt động** của admin-dashboard. Mỗi nhóm dùng collection MongoDB riêng: `news`, `events`, `member_visits`, `notifications`, `banners`. Không tự tạo nội dung mẫu.

Các đường dẫn có tiền tố `/api/v1`; thay `{collection}` bằng `news`, `events`, `member-visits`, `notifications` hoặc `banners`:

| Method | Đường dẫn | Chức năng |
| --- | --- | --- |
| GET | /admin/{collection} | Danh sách quản trị, gồm bản nháp |
| GET | /admin/{collection}/:id | Chi tiết |
| POST | /admin/{collection} | Tạo mới, trả HTTP 201 |
| PUT | /admin/{collection}/:id | Gửi đầy đủ nội dung để cập nhật |
| DELETE | /admin/{collection}/:id | Xóa mềm, giữ bản ghi trên MongoDB |
| GET | /public/{collection} | Danh sách nội dung đã công bố |
| GET | /public/{collection}/:id | Chi tiết đã công bố; nội dung ẩn trả 404 |

Mọi API `/admin` yêu cầu Bearer access token và kiểm tra phiên như API hội viên. Tạo mới có thể bỏ `id` để sinh UUID; mã không đổi khi sửa. Body chỉ nhận đúng các trường được khai báo; không nhận timestamps hoặc deletedAt từ client. Xóa mềm không cho sửa lại qua PUT.

Query: `page=1`, `limit=20` (tối đa 100), `search`, `status`; bài viết/sự kiện/thăm hội viên có thêm `topic`, thông báo có thêm `category`. `topic` và `category` lọc chính xác; tìm kiếm không phân biệt hoa/thường, ký tự regex được xử lý như văn bản. API công khai không nhận `status` và không cho ghi dữ liệu. Response giống API hội viên: danh sách `{data:[...],pagination:{page,limit,total}}`, chi tiết/tạo/sửa `{data:{...}}`, xóa `{success:true}`.

Body tin tức:

~~~json
{
  "title": "Kết nối doanh nghiệp Tân Sơn",
  "topic": "Hoạt động Hội",
  "publishedAt": "2026-11-11",
  "status": "draft",
  "image": "",
  "author": "Ban biên tập",
  "summary": "Nội dung tóm tắt chương trình.",
  "paragraphs": ["Đoạn thứ nhất.", "Đoạn thứ hai."]
}
~~~

Sự kiện dùng các trường tin tức và thêm `event` bắt buộc:

~~~json
{
  "date": "2026-11-20",
  "time": "08:00 - 11:00",
  "venue": "Hội trường",
  "address": "Phường Tân Sơn",
  "agenda": [{"time":"08:00","title":"Đón tiếp"}]
}
~~~

Thăm hội viên dùng các trường tin tức và thêm `visit` bắt buộc:

~~~json
{
  "company": "Công ty mẫu",
  "representative": "Nguyễn Văn A",
  "date": "2026-11-11",
  "address": "Phường Tân Sơn",
  "field": "Thương mại"
}
~~~

Body thông báo:

~~~json
{
  "title": "Thông báo sinh hoạt Hội",
  "category": "Hoạt động Hội",
  "date": "2026-11-11",
  "time": "08:00",
  "status": "draft",
  "description": "Nội dung tóm tắt.",
  "paragraphs": ["Nội dung thông báo."]
}
~~~

Body banner:

~~~json
{
  "image": "/association/banner.webp",
  "alt": "Hoạt động kết nối doanh nghiệp",
  "order": 1,
  "status": "inactive"
}
~~~

Ngày dùng YYYY-MM-DD có thật; giờ thông báo để trống hoặc HH:mm (24 giờ), giờ sự kiện/lịch trình là chuỗi để hỗ trợ khung giờ. `paragraphs` có ít nhất một đoạn không rỗng. Bài viết/thông báo mặc định `draft`; banner mặc định `inactive` khi bỏ status. Ảnh nhận URL HTTP(S), đường dẫn bắt đầu bằng `/`, hoặc data URL JPG/PNG/WebP base64 tối đa 1.400.000 ký tự, tương thích ImagePicker hiện tại. Không nhận SVG, javascript URL hoặc URL dạng `//host`. Body các API quản trị nội dung giới hạn 2 MiB; các API cũ vẫn 256 KiB. Chưa có endpoint upload file riêng.

API công khai chỉ trả `published` có ngày công bố không ở tương lai theo múi giờ Việt Nam; thông báo xét thêm giờ nếu có. Banner công khai chỉ trả `active`, sắp theo `order` tăng dần, mã làm khóa phụ ổn định. Sự kiện sắp theo ngày tổ chức giảm dần, chuyến thăm theo ngày thăm giảm dần, tin tức theo ngày công bố giảm dần. Thay đổi ngày tổ chức không thay đổi ngày công bố.

Dashboard đã có Axios service `api/contentApi.ts`, route chuyển tiếp cùng origin `/api/association/{collection}` và hook lấy dữ liệu từ backend. Lưu/sửa/xóa dùng cookie HttpOnly; lỗi API được hiển thị trên giao diện. Nội dung cũ trong localStorage được giữ lại nhưng không tự nhập vào MongoDB hoặc dùng làm dữ liệu thay thế khi API lỗi. Mini App chưa được sửa; có thể nối các endpoint public ở trên.

Kiểm thử nội dung nằm trong `test/content.test.cjs`, dùng MongoDB tạm riêng và không kết nối Atlas. Kiểm thử Next.js tùy chọn trong `test/api.test.cjs` bao gồm CRUD đủ năm nhóm nội dung, cookie HttpOnly, chặn origin lạ và đường dẫn sai.

### Lưu ảnh trong uploads

Ảnh người dùng chọn vẫn được trình duyệt thu nhỏ và gửi cùng body tạo/sửa nội dung. Backend giải mã ảnh JPG/PNG/WebP, kiểm tra chữ ký định dạng, sinh tên UUID và ghi file vào thư mục tương ứng:

~~~text
uploads/
  news/
  events/
  member-visits/
  banners/
~~~

Trường `image` lưu trong MongoDB và trả về API là đường dẫn tương đối, ví dụ `uploads/news/550e8400-e29b-41d4-a716-446655440000.webp`. Không lưu base64 của ảnh tải mới trong MongoDB. Khi sửa nội dung và giữ ảnh cũ, gửi lại nguyên đường dẫn; khi bỏ ảnh gửi chuỗi rỗng (banner vẫn bắt buộc có ảnh). Backend kiểm tra file của đường dẫn uploads tồn tại trước khi lưu. Nếu thao tác database thất bại, file mới được dọn lại; file cũ được giữ để không làm hỏng bản ghi khác hoặc lịch sử xóa mềm.

File được phục vụ qua `GET /uploads/{folder}/{filename}` ở gốc backend, ngoài tiền tố `/api/v1`. Dashboard có route cùng origin `/uploads/[...path]` để chuyển tiếp ảnh từ backend và hiển thị trong xem trước, bảng, chi tiết và tổng quan. Không cần thay trường image thành URL tuyệt đối trong DB. Đường dẫn ảnh tĩnh/HTTP(S) cũ tiếp tục được hỗ trợ; bản ghi base64 cũ chuyển thành file khi được lưu lại.

Các thư mục được tạo khi backend khởi động; Git chỉ giữ `.gitkeep`, bỏ qua file ảnh. Khi triển khai, giữ thư mục uploads trên ổ lưu trữ bền vững và sao lưu cùng database.

## API Thông tin Hội

Phần Cấu hình → Thông tin Hội của admin-dashboard đã nối backend cho ba nhóm: Giới thiệu Hội, Liên hệ & hỗ trợ, Trợ lý sự kiện. Dữ liệu nằm trong collection `association_settings`, với `_id` cố định `association`; không có danh sách nhiều cấu hình hoặc API xóa.

| Method | Đường dẫn (tiền tố /api/v1) | Quyền và kết quả |
| --- | --- | --- |
| GET | /admin/settings | Bearer token SUPER_ADMIN hoặc STAFF, lấy cấu hình và thông tin lần sửa |
| PUT | /admin/settings | Bearer token, tạo lần đầu hoặc cập nhật cấu hình chung, HTTP 200 |
| GET | /public/settings | Không cần token, Mini App đọc thông tin Hội; không trả người sửa hoặc timestamps |

Response `{data:{id:"association",...}}`. Bản quản trị có thêm `updatedAt` và `updatedBy`, backend tự ghi từ tài khoản đăng nhập. Các endpoint trả `Cache-Control: no-store`. GET không nhận query hoặc tham số id; PUT chỉ nhận body cấu hình, không nhận query.

Body PUT:

~~~json
{
  "name": "Hội Doanh nghiệp Phường Tân Sơn",
  "slogan": "Trách nhiệm - Sẵn sàng - Vươn mình",
  "introduction": "Giới thiệu Hội và các hoạt động chính.",
  "mission": "Kết nối và đồng hành cùng doanh nghiệp.",
  "department": "Ban thư ký",
  "address": "Địa chỉ liên hệ của Hội",
  "hours": "Thứ hai - thứ sáu, 08:00 - 17:00",
  "phone": "0900000001",
  "email": "contact@example.com",
  "zaloUrl": "https://zalo.me/123456789",
  "assistantGreeting": "Xin chào! Tôi có thể giúp gì cho bạn?",
  "assistantQuestions": "Đăng ký sự kiện ở đâu? | Tại mục Sự kiện.\nLiên hệ ai? | Ban thư ký."
}
~~~

`name` và `slogan` bắt buộc, không được chỉ có khoảng trắng. PUT gửi toàn bộ cấu hình; trường tùy chọn bỏ qua hoặc gửi chuỗi rỗng sẽ được xóa về `""`. `id` có thể bỏ qua hoặc bằng `association`; không thể thay mã. Các trường ngoài schema, kể cả `updatedBy`, `updatedAt`, `role`, `logo`, đều bị từ chối. Chưa bổ sung trường tải logo vì biểu mẫu hiện dùng logo nhận diện cố định.

Giới hạn: name 250 ký tự, slogan 500; introduction và mission mỗi trường 20.000; department 250; address 1.000; hours 500; phone 30; email 254; zaloUrl 2.048; assistantGreeting 5.000; assistantQuestions 30.000. Email phải hợp lệ hoặc trống, điện thoại dùng chữ số và dấu `+(). -`, liên kết Zalo là URL HTTPS không chứa tài khoản/mật khẩu hoặc để trống. Câu hỏi–trả lời lưu dưới dạng chuỗi theo biểu mẫu, tối đa 100 dòng có nội dung, mỗi dòng `câu hỏi | câu trả lời`; cho phép dòng trống và ký tự `|` bổ sung trong câu trả lời. Dữ liệu là văn bản, không phải HTML để thực thi.

Khi chưa lưu lần đầu, GET trả tên Hội và khẩu hiệu mặc định hiện có, các trường liên hệ và trợ lý trống; không ghi bản mặc định vào DB khi đọc. Lưu đồng thời lần đầu vẫn chỉ tạo một bản ghi; các lần lưu sau thay toàn bộ cấu hình theo yêu cầu hoàn tất cuối cùng. Không có cơ chế gộp chỉnh sửa đồng thời.

Frontend dùng `api/settingsApi.ts` và route `/api/association/settings` (GET, PUT), token nằm trong cookie HttpOnly. Form khóa thao tác khi đang lưu, hiển thị lỗi API và tải lại dữ liệu sau lưu thành công. Hook dữ liệu và bản xuất JSON sử dụng thông tin Hội lấy từ API. Cấu hình cũ trong localStorage không tự chuyển hoặc dùng thay thế khi API lỗi; không ghi đè dữ liệu MongoDB bằng dữ liệu trình duyệt. Mini App chưa được sửa, có thể nối `GET /api/v1/public/settings` để lấy cấu hình.

Kiểm thử tại `test/settings.test.cjs` dùng MongoDB tạm, bao gồm quyền truy cập, cấu hình mặc định, lưu đồng thời, lưu/xóa giá trị tùy chọn, kiểm tra dữ liệu, bảo vệ trường hệ thống và đọc lại sau khi khởi động lại app. Luồng cookie qua Next.js được kiểm tra tùy chọn trong `test/api.test.cjs` cùng các module khác.

## Chuyển ảnh local cũ lên Vercel

1. Kiểm tra `MONGODB_URI` trong môi trường chạy lệnh trỏ đúng database backend Vercel.
2. Chạy `npm run images:migrate` để xem số ảnh, chưa ghi database.
3. Chạy `npm run images:migrate -- --apply` để sao chép ảnh sang GridFS. Lệnh giữ nguyên file local và đường dẫn trong nội dung, bỏ qua ảnh đã có giống hệt; dừng nếu cùng đường dẫn nhưng khác nội dung. Không chạy đồng thời nhiều lần migration.
4. Deploy backend rồi kiểm tra URL `/uploads/banners/...` trả ảnh. Không cần sửa frontend hoặc trang quản trị.

Ảnh dùng dung lượng MongoDB và được sao lưu cùng database. Không tự xóa ảnh cũ khi sửa/xóa mềm nội dung; ảnh mới được dọn nếu lưu nội dung thất bại.

## Mini App xem công khai

Mini App mở các màn hình mà không yêu cầu xác thực Zalo. `GET /api/v1/public/members` cung cấp danh bạ hội viên đang hoạt động, hỗ trợ tìm kiếm/phân trang như danh bạ cũ; chỉ trả tên, doanh nghiệp, chức danh và vai trò. Không trả số điện thoại, email, ngày sinh hoặc liên kết Zalo. Các API quản trị và API hồ sơ cá nhân vẫn giữ xác thực.


## Tối ưu tải và ghi dữ liệu

vercel.json đặt region sin1 (Singapore) cùng vùng GCP Atlas hiện tại. Cần redeploy để áp dụng; nếu đổi vùng database phải kiểm tra lại cấu hình region. Pool giới hạn 10 kết nối mỗi instance, minPoolSize 0 và thu hồi kết nối nhàn sau 60 giây. Init các nhóm model chạy song song; tài khoản quản trị có sẵn không bị upsert/hash lại lúc cold start. Hash giả chống dò tài khoản chỉ được tạo khi cần kiểm tra đăng nhập sai, vẫn giữ bcrypt cost 12. Session và trạng thái tài khoản vẫn kiểm tra từ database mỗi request.

Các index danh sách khớp trường sort thực tế (gồm _id để thứ tự ổn định). Sửa nội dung chỉ đọc ảnh trước khi cập nhật, không gửi lại ảnh cũ trong $set nếu ảnh không đổi.

### Ảnh base64 cũ

Chạy `npm run images:migrate-inline` để đếm, không thay đổi database. Chạy `npm run images:migrate-inline -- --apply --verify-origin https://behdntanson.vercel.app` để chuyển sang GridFS. Công cụ lưu backup trong .reference/inline-image-backups, xác minh ảnh truy cập được trước khi đổi reference và dùng so sánh giá trị ảnh cũ để giữ chỉnh sửa đồng thời. Không đổi id, nội dung bài hoặc updatedAt. Backup có cả giá trị gốc và đường dẫn thay thế.

Ngày 12/11/2026 đã chuyển 1 ảnh theo xác nhận của chủ dự án; JSON /public/news giảm từ 196.874 xuống 473 byte. Backup: .reference/inline-image-backups/8ea60fc7-89b4-4227-8698-9adac168f98d.json.

### CORS cho Mini App đã deploy

Backend luôn cho phép origin chính thức `https://h5.zdn.vn` của Zalo Mini App, đồng thời giữ các origin web trong `CORS_ORIGINS`. Middleware CORS áp dụng cả OPTIONS trước các route. Không dùng ký tự `*` hoặc thêm đường dẫn app vào origin. Redeploy backend sau khi cập nhật mã nguồn.
