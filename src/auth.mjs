import crypto from 'node:crypto';
import { constantTimeTextEqual, verifyPassword } from './password.mjs';

const COOKIE_NAME = 'lesson4_demo_session';

function cookieMap(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function tokenHash(token, secret) {
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

function attemptKey(request, username, secret) {
  const peer = request.socket?.remoteAddress || 'unknown';
  return crypto.createHmac('sha256', secret).update(`${peer}\0${String(username).toLowerCase()}`).digest('hex');
}

export function sessionCookie(token, settings, clear = false) {
  const pieces = [`${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (settings.production) pieces.push('Secure');
  pieces.push(clear ? 'Max-Age=0' : `Max-Age=${Math.max(60, settings.auth.sessionTtlMinutes * 60)}`);
  return pieces.join('; ');
}

export function createAuth(pool, settings) {
  async function audit(eventType, user, summary = {}) {
    await pool.query(
      `INSERT INTO app_audit_events(actor_username,actor_display_name,event_type,event_summary)
       VALUES($1,$2,$3,$4::jsonb)`,
      [user?.username || null, user?.displayName || null, eventType, JSON.stringify(summary)]
    );
  }

  async function getSession(request) {
    const token = cookieMap(request.headers.cookie)[COOKIE_NAME];
    if (!token || token.length < 32 || token.length > 256) return null;
    const hash = tokenHash(token, settings.auth.sessionSecret);
    const result = await pool.query(
      `UPDATE app_sessions SET last_seen_at=now()
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()
       RETURNING username,display_name,created_at,last_seen_at,expires_at`, [hash]
    );
    const row = result.rows[0];
    return row ? { username: row.username, displayName: row.display_name, expiresAt: row.expires_at } : null;
  }

  async function login(request, username, password) {
    const key = attemptKey(request, username, settings.auth.sessionSecret);
    const previous = await pool.query('SELECT * FROM auth_login_attempts WHERE attempt_key=$1', [key]);
    if (previous.rows[0]?.blocked_until && new Date(previous.rows[0].blocked_until) > new Date()) {
      await audit('login_rate_limited', null, { attempt_key: key });
      return { ok: false, status: 429 };
    }

    const usernameOk = constantTimeTextEqual(username, settings.auth.username);
    const passwordOk = await verifyPassword(password, settings.auth.passwordHash);
    if (!usernameOk || !passwordOk) {
      const windowMinutes = settings.auth.failureWindowMinutes;
      const limit = settings.auth.maxFailures;
      const lockMinutes = settings.auth.lockMinutes;
      await pool.query(`
        INSERT INTO auth_login_attempts(attempt_key,window_started_at,failure_count,blocked_until)
        VALUES($1,now(),1,NULL)
        ON CONFLICT(attempt_key) DO UPDATE SET
          window_started_at=CASE WHEN auth_login_attempts.window_started_at < now()-($2::text||' minutes')::interval THEN now() ELSE auth_login_attempts.window_started_at END,
          failure_count=CASE WHEN auth_login_attempts.window_started_at < now()-($2::text||' minutes')::interval THEN 1 ELSE auth_login_attempts.failure_count+1 END,
          blocked_until=CASE WHEN (CASE WHEN auth_login_attempts.window_started_at < now()-($2::text||' minutes')::interval THEN 1 ELSE auth_login_attempts.failure_count+1 END) >= $3
            THEN now()+($4::text||' minutes')::interval ELSE NULL END,
          updated_at=now()`, [key, windowMinutes, limit, lockMinutes]);
      await audit('login_failed', null, { attempt_key: key });
      return { ok: false, status: 401 };
    }

    await pool.query('DELETE FROM auth_login_attempts WHERE attempt_key=$1', [key]);
    const oldToken = cookieMap(request.headers.cookie)[COOKIE_NAME];
    if (oldToken) await pool.query('UPDATE app_sessions SET revoked_at=now() WHERE token_hash=$1', [tokenHash(oldToken, settings.auth.sessionSecret)]);
    const token = crypto.randomBytes(32).toString('base64url');
    const user = { username: settings.auth.username, displayName: settings.auth.displayName };
    await pool.query(
      `INSERT INTO app_sessions(token_hash,username,display_name,expires_at)
       VALUES($1,$2,$3,now()+($4::text||' minutes')::interval)`,
      [tokenHash(token, settings.auth.sessionSecret), user.username, user.displayName, settings.auth.sessionTtlMinutes]
    );
    await audit('login_succeeded', user);
    return { ok: true, status: 200, user, cookie: sessionCookie(token, settings) };
  }

  async function logout(request, user) {
    const token = cookieMap(request.headers.cookie)[COOKIE_NAME];
    if (token) await pool.query('UPDATE app_sessions SET revoked_at=now() WHERE token_hash=$1', [tokenHash(token, settings.auth.sessionSecret)]);
    await audit('logout', user);
    return sessionCookie('', settings, true);
  }

  return { audit, getSession, login, logout, clearCookie: () => sessionCookie('', settings, true) };
}
