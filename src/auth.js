const crypto = require('node:crypto');

const COOKIE_NAME = 'visitor_session';
const FLASH_COOKIE_NAME = 'visitor_flash';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = String(storedHash || '').split(':');
  if (!salt || !expected) {
    return false;
  }

  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function createSessionValue(secret) {
  const payload = {
    exp: Date.now() + SESSION_TTL_MS
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function readSessionValue(rawValue, secret) {
  if (!rawValue) {
    return null;
  }

  const [encoded, signature] = rawValue.split('.');
  if (!encoded || !signature) {
    return null;
  }

  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (signature !== expected) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(headerValue) {
  const cookies = {};
  if (!headerValue) {
    return cookies;
  }

  for (const part of headerValue.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) {
      continue;
    }
    cookies[name] = decodeURIComponent(rest.join('='));
  }

  return cookies;
}

function setSessionCookie(res, secret, options = {}) {
  const value = createSessionValue(secret);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=43200'
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  appendSetCookie(res, parts.join('; '));
}

function clearSessionCookie(res, options = {}) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (options.secure) {
    parts.push('Secure');
  }
  appendSetCookie(res, parts.join('; '));
}

function setFlashCookie(res, flash, options = {}) {
  const encoded = Buffer.from(JSON.stringify(flash), 'utf8').toString('base64url');
  const parts = [
    `${FLASH_COOKIE_NAME}=${encoded}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=30'
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  appendSetCookie(res, parts.join('; '));
}

function consumeFlashCookie(req, res, options = {}) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[FLASH_COOKIE_NAME];
  if (!raw) {
    return null;
  }

  const parts = [`${FLASH_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (options.secure) {
    parts.push('Secure');
  }
  appendSetCookie(res, parts.join('; '));

  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader('Set-Cookie');
  if (!current) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }
  if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, cookieValue]);
    return;
  }
  res.setHeader('Set-Cookie', [current, cookieValue]);
}

function sessionMiddleware(secret) {
  return (req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    req.session = readSessionValue(cookies[COOKIE_NAME], secret);
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.session) {
    if (req.accepts('html')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Authentication required' });
  }

  return next();
}

module.exports = {
  clearSessionCookie,
  consumeFlashCookie,
  createPasswordHash,
  requireAuth,
  sessionMiddleware,
  setSessionCookie,
  setFlashCookie,
  verifyPassword
};
