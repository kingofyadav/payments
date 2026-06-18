'use strict';
// Regression test for Bug #3: SSRF via webhook URLs
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateWebhookUrl } = require('../../src/middleware/validateUrl');

describe('validateWebhookUrl — valid public URLs', () => {
  const valid = [
    'https://example.com/webhooks',
    'http://example.com/webhooks',
    'https://api.stripe.com/v1/webhooks',
    'https://hooks.slack.com/services/abc',
    'http://203.0.113.5/hook', // TEST-NET — not private
  ];
  for (const url of valid) {
    test(`accepts ${url}`, () => {
      assert.doesNotThrow(() => validateWebhookUrl(url));
    });
  }
});

describe('validateWebhookUrl — rejects private/internal addresses (IPv4)', () => {
  const blocked = [
    'http://localhost/hook',
    'http://127.0.0.1/hook',
    'http://127.0.0.99/hook',
    'http://10.0.0.1/hook',
    'http://10.255.255.255/hook',
    'http://192.168.1.1/hook',
    'http://192.168.0.254/hook',
    'http://172.16.0.1/hook',
    'http://172.31.255.255/hook',
    'http://169.254.169.254/latest/meta-data/', // AWS metadata / link-local
    'http://0.0.0.0/hook',
  ];
  for (const url of blocked) {
    test(`rejects ${url}`, () => {
      assert.throws(() => validateWebhookUrl(url), Error);
    });
  }
});

describe('validateWebhookUrl — rejects private/internal addresses (IPv6)', () => {
  const blocked = [
    // loopback
    'http://[::1]/hook',
    // unspecified (bind-all)
    'http://[::]/hook',
    // IPv4-mapped loopback — ::ffff:127.0.0.1
    'http://[::ffff:127.0.0.1]/hook',
    // IPv4-mapped RFC-1918
    'http://[::ffff:10.0.0.1]/hook',
    'http://[::ffff:192.168.1.1]/hook',
    'http://[::ffff:172.16.0.1]/hook',
    // IPv4-mapped link-local (AWS metadata)
    'http://[::ffff:169.254.169.254]/hook',
    // unique-local fc00::/7 (fc**)
    'http://[fc00::1]/hook',
    'http://[fc12:3456::1]/hook',
    // unique-local fc00::/7 (fd**)
    'http://[fd00::1]/hook',
    'http://[fdab:cdef::1]/hook',
    // link-local fe80::/10
    'http://[fe80::1]/hook',
    'http://[feb0::1]/hook',
  ];
  for (const url of blocked) {
    test(`rejects ${url}`, () => {
      assert.throws(() => validateWebhookUrl(url), Error);
    });
  }
});

describe('validateWebhookUrl — rejects embedded credentials', () => {
  const blocked = [
    'http://user:pass@example.com/hook',
    'http://user@example.com/hook',
    'https://admin:secret@hooks.example.com/incoming',
  ];
  for (const url of blocked) {
    test(`rejects ${url}`, () => {
      assert.throws(() => validateWebhookUrl(url), /credentials/);
    });
  }
});

describe('validateWebhookUrl — rejects oversized input', () => {
  test('rejects URL longer than 2048 characters', () => {
    assert.throws(() => validateWebhookUrl('https://example.com/' + 'a'.repeat(2050)), Error);
  });

  test('rejects non-string input', () => {
    assert.throws(() => validateWebhookUrl(null), Error);
    assert.throws(() => validateWebhookUrl(42), Error);
  });
});

describe('validateWebhookUrl — rejects non-HTTP protocols', () => {
  const blocked = [
    'ftp://example.com/hook',
    'file:///etc/passwd',
    'data:text/html,<h1>xss</h1>',
    'javascript:alert(1)',
  ];
  for (const url of blocked) {
    test(`rejects ${url}`, () => {
      assert.throws(() => validateWebhookUrl(url), Error);
    });
  }
});

describe('validateWebhookUrl — rejects malformed input', () => {
  test('rejects plain string', () => {
    assert.throws(() => validateWebhookUrl('not a url'), Error);
  });

  test('rejects empty string', () => {
    assert.throws(() => validateWebhookUrl(''), Error);
  });

  test('rejects relative path', () => {
    assert.throws(() => validateWebhookUrl('/webhooks/incoming'), Error);
  });
});
