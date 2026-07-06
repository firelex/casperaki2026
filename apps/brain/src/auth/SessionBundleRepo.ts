// apps/brain/src/auth/SessionBundleRepo.ts
import type Database from 'better-sqlite3';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { SESSION_TTL_MS } from './middleware.js';

export interface SessionBundle {
  sessionId: string;
  sub: string;
  email: string;
  name: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
}

// Session lifetime shared with the cookie Max-Age (see middleware).
const TTL_MS = SESSION_TTL_MS;

export class SessionBundleRepo {
  private key: Buffer;
  // Prepared once at open — better-sqlite3 has no internal statement cache,
  // so re-preparing on every authenticated request (via get) recompiles SQL.
  private insertStmt: Database.Statement;
  private getStmt: Database.Statement;
  private updateStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private purgeStmt: Database.Statement;

  constructor(private db: Database.Database, secret: string) {
    this.key = scryptSync(secret, 'casperaki-session-bundle', 32);
    this.insertStmt = db.prepare(
      `INSERT INTO user_sessions (session_id, sub, email, name, refresh_token_enc, access_token, access_token_expires_at, last_seen_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM user_sessions WHERE session_id = ?`);
    this.updateStmt = db.prepare(
      `UPDATE user_sessions SET refresh_token_enc = ?, access_token = ?, access_token_expires_at = ?, last_seen_at = ? WHERE session_id = ?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM user_sessions WHERE session_id = ?`);
    this.purgeStmt = db.prepare(`DELETE FROM user_sessions WHERE expires_at < ?`);
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
  }

  private decrypt(blob: string): string {
    const [ivB, ctB, tagB] = blob.split('.');
    const iv = Buffer.from(ivB, 'base64url');
    const ct = Buffer.from(ctB, 'base64url');
    const tag = Buffer.from(tagB, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  create(input: { sub: string; email: string; name: string; refreshToken: string; accessToken: string; accessTokenExpiresAt: string }): SessionBundle {
    const now = new Date();
    const sessionId = randomBytes(32).toString('base64url');
    const bundle: SessionBundle = {
      sessionId,
      sub: input.sub, email: input.email, name: input.name,
      refreshToken: input.refreshToken,
      accessToken: input.accessToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    };
    this.insertStmt.run(sessionId, input.sub, input.email, input.name,
          this.encrypt(input.refreshToken), input.accessToken, input.accessTokenExpiresAt,
          bundle.lastSeenAt, bundle.expiresAt, bundle.createdAt);
    return bundle;
  }

  get(sessionId: string): SessionBundle | null {
    const row = this.getStmt.get(sessionId) as any;
    if (!row) return null;
    return {
      sessionId: row.session_id, sub: row.sub, email: row.email, name: row.name,
      refreshToken: this.decrypt(row.refresh_token_enc),
      accessToken: row.access_token,
      accessTokenExpiresAt: row.access_token_expires_at,
      lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, createdAt: row.created_at,
    };
  }

  updateTokens(sessionId: string, t: { refreshToken: string; accessToken: string; accessTokenExpiresAt: string }): void {
    this.updateStmt.run(this.encrypt(t.refreshToken), t.accessToken, t.accessTokenExpiresAt, new Date().toISOString(), sessionId);
  }

  delete(sessionId: string): void {
    this.deleteStmt.run(sessionId);
  }

  purgeExpired(): void {
    this.purgeStmt.run(new Date().toISOString());
  }
}
