import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { atomic } from './database.js';

const deriveKey = promisify(scrypt);
export const sessionLifetime = 8 * 60 * 60 * 1000;
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface User { id: string; display_name: string; email: string; password_hash: string; }
interface Account { number: string; user_id: string; kind: 'checking' | 'savings'; balance_cents: number; }
export function text(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(400, `Invalid ${key}.`);
  return value.trim();
}
export function credentials(body: Record<string, unknown>): { email: string; password: string } {
  const email = text(body, 'email', 254).toLowerCase();
  const password = body['password'];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Enter a valid email.');
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) throw new ApiError(400, 'Password must be 6–128 characters.');
  return { email, password };
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  const key = await deriveKey(password, salt, 64) as Buffer;
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
export function newSession(db: DatabaseSync, userId: string): string {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), userId, Date.now() + sessionLifetime);
  return token;
}
export function sessionUser(db: DatabaseSync, token: string): User | undefined {
  return db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE token_hash = ? AND expires_at > ?`).get(tokenHash(token), Date.now()) as User | undefined;
}
export function publicUser(user: User) { return { id: user.id, displayName: user.display_name, email: user.email }; }
export function openAccount(db: DatabaseSync, userId: string, kind: Account['kind'], balance: number): string {
  const number = randomBytes(8).toString('hex').toUpperCase();
  db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?)').run(number, userId, kind, balance);
  return number;
}
export function register(db: DatabaseSync, name: string, email: string, hash: string): string {
  return atomic(db, () => {
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new ApiError(409, 'An account with this email already exists.');
    const id = randomUUID();
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(id, name, email, hash);
    const checking = openAccount(db, id, 'checking', 100_000);
    db.prepare('INSERT INTO transactions VALUES (?, NULL, ?, ?, ?, NULL)').run(randomUUID(), checking, 100_000, new Date().toISOString());
    return id;
  });
}
export function dashboard(db: DatabaseSync, user: User) {
  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY kind').all(user.id) as unknown as Account[];
  const rows = db.prepare(`SELECT t.*, s.kind AS source_kind, s.user_id AS source_owner,
    d.kind AS destination_kind, d.user_id AS destination_owner,
    su.display_name AS source_name, du.display_name AS destination_name
    FROM transactions t LEFT JOIN accounts s ON s.number = t.source_number
    JOIN accounts d ON d.number = t.destination_number
    LEFT JOIN users su ON su.id = s.user_id JOIN users du ON du.id = d.user_id
    WHERE s.user_id = ? OR d.user_id = ? ORDER BY t.rowid DESC`).all(user.id, user.id);
  return {
    user: publicUser(user),
    accounts: accounts.map(a => ({ number: a.number, kind: a.kind, name: a.kind === 'checking' ? 'Checking' : 'Savings', balanceCents: a.balance_cents })),
    transactions: rows.map(t => {
      const ownSource = t['source_owner'] === user.id;
      const ownDestination = t['destination_owner'] === user.id;
      return {
        reference: t['reference'], createdAt: t['created_at'], amountCents: t['amount_cents'],
        from: ownSource ? t['source_kind'] : null, to: ownDestination ? t['destination_kind'] : null,
        description: !t['source_number'] ? 'Opening deposit' : ownSource && ownDestination ? 'Transfer between accounts' : ownSource ? `Payment to ${t['destination_name']}` : `Payment from ${t['source_name']}`,
        direction: ownSource && ownDestination ? 'internal' : ownSource ? 'outgoing' : 'incoming',
      };
    }),
  };
}
export function transferDetails(db: DatabaseSync, userId: string, body: Record<string, unknown>) {
  const sourceNumber = text(body, 'sourceNumber', 16);
  const destinationNumber = text(body, 'destinationNumber', 16).toUpperCase();
  const amountCents = body['amountCents'];
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) throw new ApiError(400, 'Enter a positive amount in whole cents.');
  const source = db.prepare('SELECT * FROM accounts WHERE number = ? AND user_id = ?').get(sourceNumber, userId) as Account | undefined;
  if (!source) throw new ApiError(403, 'You can only send money from your own accounts.');
  const destination = db.prepare('SELECT * FROM accounts WHERE number = ?').get(destinationNumber) as Account | undefined;
  if (!destination || (destination.user_id !== userId && destination.kind !== 'checking')) throw new ApiError(400, 'Recipient checking account not found.');
  if (source.number === destination.number) throw new ApiError(400, 'Choose a different destination account.');
  if (source.balance_cents < amountCents) throw new ApiError(400, 'Insufficient funds.');
  if (!Number.isSafeInteger(destination.balance_cents + amountCents)) throw new ApiError(400, 'The recipient account cannot receive this amount.');
  const recipient = db.prepare('SELECT display_name FROM users WHERE id = ?').get(destination.user_id)!;
  return { sourceNumber, destinationNumber, amountCents, recipientName: String(recipient['display_name']), destinationKind: destination.kind };
}
export function transferMoney(db: DatabaseSync, userId: string, body: Record<string, unknown>) {
  const requestId = text(body, 'requestId', 36);
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new ApiError(400, 'Invalid transfer request ID.');
  return atomic(db, () => {
    // Retries reuse one request ID, preventing duplicate payments after a lost response.
    const existing = db.prepare(`SELECT t.* FROM transactions t JOIN accounts a ON a.number = t.source_number
      WHERE t.request_id = ? AND a.user_id = ?`).get(`${userId}:${requestId}`, userId);
    if (existing) {
      if (existing['source_number'] !== body['sourceNumber'] || existing['destination_number'] !== body['destinationNumber'] || existing['amount_cents'] !== body['amountCents']) throw new ApiError(409, 'This request ID was already used for a different transfer.');
      return { reference: String(existing['reference']) };
    }
    const detail = transferDetails(db, userId, body);
    db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE number = ?').run(detail.amountCents, detail.sourceNumber);
    db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE number = ?').run(detail.amountCents, detail.destinationNumber);
    const reference = randomUUID();
    db.prepare('INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?)').run(reference, detail.sourceNumber, detail.destinationNumber, detail.amountCents, new Date().toISOString(), `${userId}:${requestId}`);
    return { reference };
  });
}
