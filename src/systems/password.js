const { scrypt, randomBytes, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(scrypt);

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key  = await scryptAsync(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password, hash) {
  const [salt, key] = hash.split(':');
  const derived = await scryptAsync(password, salt, 64);
  return timingSafeEqual(Buffer.from(key, 'hex'), derived);
}

module.exports = { hashPassword, verifyPassword };
