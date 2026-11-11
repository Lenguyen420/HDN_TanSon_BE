export class HttpError extends Error {
  constructor(status, message = "Yêu cầu không hợp lệ.") {
    super(message);
    this.status = status;
  }
}
export class BadRequestError extends HttpError {
  constructor(message) {
    super(400, message);
  }
}
export class UnauthorizedError extends HttpError {
  constructor(message = "Phiên đăng nhập không hợp lệ.") {
    super(401, message);
  }
}
export class NotFoundError extends HttpError {
  constructor(message) {
    super(404, message);
  }
}
export class ConflictError extends HttpError {
  constructor(message) {
    super(409, message);
  }
}
