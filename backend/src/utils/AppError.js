// A tiny typed error so controllers can throw with an intended HTTP status
// and the central error handler doesn't have to guess what code to send.
class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = { AppError };
