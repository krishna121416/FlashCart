// Wraps an async route/controller so a rejected promise reaches Express's
// error handler instead of becoming an unhandled rejection.
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { asyncHandler };
