export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}
export const badRequest = (m) => new ApiError(400, m);
export const unauthorized = (m = 'Не авторизовано') => new ApiError(401, m);
export const forbidden = (m = 'Нет доступа') => new ApiError(403, m);
export const notFound = (m = 'Не найдено') => new ApiError(404, m);
export const tooMany = (m = 'Слишком много запросов') => new ApiError(429, m);
