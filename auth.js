const crypto = require('crypto');
const cookie = require('cookie');

const COOKIE_NAME = 'dc_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function requireSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET environment variable is required');
  return secret;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sign(payloadObj) {
  const secret = requireSecret();
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const secret = requireSecret();
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!obj.exp || Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

// Checks (id, password) against the fixed user/admin credentials in env
// vars. Returns the role string on success, or null.
function checkCredentials(id, password) {
  if (typeof id !== 'string' || typeof password !== 'string') return null;

  const userId = process.env.USER_ID;
  const userPassword = process.env.USER_PASSWORD;
  if (userId && userPassword && id === userId && timingSafeEqualStr(password, userPassword)) {
    return 'user';
  }

  const adminId = process.env.ADMIN_ID;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminId && adminPassword && id === adminId && timingSafeEqualStr(password, adminPassword)) {
    return 'admin';
  }

  return null;
}

function setSessionCookie(res, role) {
  const token = sign({ role, exp: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  }));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  }));
}

function getSession(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  return verify(cookies[COOKIE_NAME]);
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.session = session;
  next();
}

module.exports = {
  checkCredentials,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  requireAuth,
  requireAdmin,
};
