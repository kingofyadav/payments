'use strict';

// RFC-1918 / loopback / link-local IPv4 ranges
const PRIVATE_IPV4_RE = /^(?:localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/i;

// IPv6: loopback (::1), unspecified (::), unique-local (fc00::/7 → fc** / fd**),
// link-local (fe80::/10 → fe80–febf), and ALL IPv4-mapped (::ffff:*) — no
// legitimate webhook endpoint is reached via IPv4-mapped IPv6 notation.
const PRIVATE_IPV6_RE = /^(?:::1$|::$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:|::ffff:)/i;

function validateWebhookUrl(url) {
  if (typeof url !== 'string' || url.length > 2048)
    throw new Error('url must be a string of 2048 characters or fewer');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('url must be a valid absolute HTTP/HTTPS URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('url must use http or https');

  // Credentials in a webhook URL serve no legitimate purpose and would cause
  // the HTTP client to attach a Basic-Auth header to the outbound request —
  // a potential data-exfiltration vector if the host check is ever bypassed.
  if (parsed.username || parsed.password)
    throw new Error('url must not contain embedded credentials');

  // WHATWG URL wraps IPv6 literals in brackets: "[::1]" — strip them before matching.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (PRIVATE_IPV4_RE.test(host))
    throw new Error('url must not point to a private, loopback, or link-local address');

  if (PRIVATE_IPV6_RE.test(host))
    throw new Error('url must not point to a private, loopback, or link-local address');

  return true;
}

module.exports = { validateWebhookUrl };
