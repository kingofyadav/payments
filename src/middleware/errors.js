// Consistent error format for all API responses
// { error: { code, description, field?, source, step?, reason?, metadata } }

const HTTP_TO_CODE = {
  400: 'BAD_REQUEST_ERROR',
  401: 'AUTHENTICATION_ERROR',
  403: 'AUTHORIZATION_ERROR',
  404: 'NOT_FOUND_ERROR',
  409: 'CONFLICT_ERROR',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMIT_ERROR',
  500: 'SERVER_ERROR',
};

function apiError(res, status, description, opts = {}) {
  const { field, source = 'business', step, reason, metadata = {} } = opts;
  const code = opts.code || HTTP_TO_CODE[status] || 'SERVER_ERROR';
  const body = { code, description, source, metadata };
  if (field)  body.field  = field;
  if (step)   body.step   = step;
  if (reason) body.reason = reason;
  return res.status(status).json({ error: body });
}

module.exports = { apiError };
