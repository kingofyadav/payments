const { randomBytes } = require('crypto');

// URL-safe chars, excludes 0/O/l/I to avoid confusion
const CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function generateCode(len = 8) {
  const bytes = randomBytes(len);
  return Array.from(bytes, b => CHARS[b % CHARS.length]).join('');
}

module.exports = { generateCode };
