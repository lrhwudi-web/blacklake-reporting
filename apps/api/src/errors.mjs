export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, status, code, message, details) {
  if (!condition) throw new AppError(status, code, message, details);
}

export function publicError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details } }
    };
  }

  console.error(error);
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "系统暂时繁忙，请稍后再试。" } }
  };
}

