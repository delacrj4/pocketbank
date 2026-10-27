import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  ApiError, credentials, dashboard, hashPassword, newSession, openAccount, publicUser,
  register, sessionLifetime, sessionUser, text, tokenHash, transferDetails, transferMoney, verifyPassword,
  type User,
} from './banking.js';

function cookieToken(request: Request): string {
  return request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('pocketbank_session='))?.slice('pocketbank_session='.length) ?? '';
}
function setSession(response: Response, token: string): void {
  // HTTP-only local development. HTTPS deployments would also set Secure.
  response.cookie('pocketbank_session', token, { httpOnly: true, sameSite: 'strict', path: '/api', maxAge: sessionLifetime });
}
function bodyOf(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new ApiError(400, 'Expected a JSON object.');
  return request.body;
}

export function createApp(db: DatabaseSync) {
  const app = express();
  const authAttempts = new Map<string, { count: number; until: number }>();
  app.disable('x-powered-by');
  app.use('/api', (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (request, _response, next) => {
    // Cross-origin forms cannot set this header, and CORS is not enabled.
    if (request.method !== 'GET' && request.get('X-PocketBank-Request') !== '1') return next(new ApiError(403, 'Invalid request origin.'));
    next();
  });
  app.get('/api/health', (_request, response) => {
    db.prepare('SELECT 1').get();
    response.json({ status: 'ok', database: 'connected', app: 'PocketBank' });
  });
  app.use('/api/auth', (request, _response, next) => {
    if (request.path === '/logout') return next();
    const key = request.ip ?? 'local';
    const now = Date.now();
    for (const [ip, item] of authAttempts) if (item.until <= now) authAttempts.delete(ip);
    const entry = authAttempts.get(key) ?? { count: 0, until: now + 15 * 60 * 1000 };
    entry.count++;
    authAttempts.set(key, entry);
    if (entry.count > 30) return next(new ApiError(429, 'Too many sign-in attempts. Try again in 15 minutes.'));
    next();
  });
  app.post('/api/auth/register', async (request, response) => {
    const body = bodyOf(request);
    const name = text(body, 'displayName', 60);
    const { email, password } = credentials(body);
    if (body['confirmPassword'] !== password) throw new ApiError(400, 'Passwords do not match.');
    const hash = await hashPassword(password);
    const id = register(db, name, email, hash);
    setSession(response, newSession(db, id));
    response.status(201).json({ registered: true });
  });
  app.post('/api/auth/login', async (request, response) => {
    const { email, password } = credentials(bodyOf(request));
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
    // Perform the KDF even for unknown emails.
    const valid = await verifyPassword(password, user?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`);
    if (!user || !valid) throw new ApiError(401, 'Email or password is incorrect.');
    const previous = cookieToken(request);
    if (previous) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(previous));
    setSession(response, newSession(db, user.id));
    response.json({ user: publicUser(user) });
  });
  app.post('/api/auth/logout', (request, response) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(cookieToken(request)));
    response.clearCookie('pocketbank_session', { httpOnly: true, sameSite: 'strict', path: '/api' });
    response.sendStatus(204);
  });
  app.use('/api', (request, response, next) => {
    const user = sessionUser(db, cookieToken(request));
    if (!user) return next(new ApiError(401, 'Please sign in.'));
    response.locals['user'] = user;
    next();
  });
  app.get('/api/dashboard', (_request, response) => response.json(dashboard(db, response.locals['user'])));
  app.post('/api/accounts/savings', (_request, response) => {
    const user: User = response.locals['user'];
    if (db.prepare("SELECT number FROM accounts WHERE user_id = ? AND kind = 'savings'").get(user.id)) throw new ApiError(409, 'You already have a savings account.');
    openAccount(db, user.id, 'savings', 0);
    response.status(201).json(dashboard(db, user));
  });
  app.post('/api/transfers/preview', (request, response) => response.json(transferDetails(db, response.locals['user'].id, bodyOf(request))));
  app.post('/api/transfers', (request, response) => response.json(transferMoney(db, response.locals['user'].id, bodyOf(request))));
  app.use('/api', (_request, _response, next) => next(new ApiError(404, 'Endpoint not found.')));
  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof ApiError) { response.status(error.status).json({ message: error.message }); return; }
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      response.status(400).json({ message: 'Invalid request body.' }); return;
    }
    console.error(error);
    response.status(500).json({ message: 'An unexpected error occurred. Try again.' });
  };
  app.use(handleError);
  return app;
}
