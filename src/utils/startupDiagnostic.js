// Only log known, static messages. Driver errors can contain credentials or URIs.
const diagnostics = new Map([
  [
    "Điền MONGODB_URI trong .env trước khi chạy.",
    "MONGODB_URI_INVALID: Thêm MONGODB_URI hợp lệ vào Environment Variables của Vercel.",
  ],
  [
    "JWT_SECRET cần ít nhất 32 ký tự.",
    "JWT_SECRET_INVALID: JWT_SECRET phải có ít nhất 32 ký tự.",
  ],
  ["PORT không hợp lệ.", "PORT_INVALID: Kiểm tra biến PORT."],
  [
    "ADMIN_PASSWORD cần ít nhất 6 ký tự.",
    "ADMIN_PASSWORD_INVALID: ADMIN_PASSWORD phải có ít nhất 6 ký tự.",
  ],
  [
    "Không kết nối được MongoDB. Kiểm tra URI, DNS và IP được phép trên Atlas.",
    "MONGODB_CONNECTION_FAILED: Kiểm tra URI, Database User, Network Access và DNS trên Atlas.",
  ],
]);

export function startupDiagnostic(error) {
  return (
    diagnostics.get(error?.message) ||
    "INITIALIZATION_FAILED: Khởi tạo backend thất bại sau bước kiểm tra cấu hình; cần kiểm tra database, index và dịch vụ khởi tạo."
  );
}
