const { AppError } = require('../utils/AppError');

// Central error handler: known errors (AppError) surface their own status
// and message; anything unexpected is logged server-side and reported to
// the client as a plain 500 with no stack trace.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  console.error(err);
  return res.status(500).json({ error: 'internal server error' });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not found' });
}

module.exports = { errorHandler, notFoundHandler };
