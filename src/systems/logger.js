'use strict';
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // In test environments, silence all output so test output stays clean.
  ...(process.env.NODE_ENV === 'test' ? { level: 'silent' } : {}),
  base: { service: 'payengine', version: 'v10' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// Optional Sentry integration — no-ops if SENTRY_DSN is unset.
let _sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'production' });
    _sentry = Sentry;
    logger.info('Sentry error tracking initialised');
  } catch {
    logger.warn('SENTRY_DSN set but @sentry/node is not installed — run: npm install @sentry/node');
  }
}

function captureException(err, context = {}) {
  if (_sentry) _sentry.captureException(err, { extra: context });
}

module.exports = { logger, captureException };
