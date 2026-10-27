import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from './src/app.js';
import { openDatabase } from './src/database.js';
import { transferMoney } from './src/banking.js';

interface Account { number: string; kind: string; balanceCents: number; }
interface Snapshot { user: { id: string; email: string }; accounts: Account[]; transactions: { reference: string; amountCents: number; direction: string }[]; }

test('banking API: identity, persistence, ownership, and money movement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pocketbank-test-'));
  const path = join(directory, 'test.sqlite');
  const db = openDatabase(path);
  const server = createApp(db).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const alice = { cookie: '' };
  const bob = { cookie: '' };
  const outsider = { cookie: '' };
  const password = 'simple';
  async function request(client: { cookie: string }, route: string, body?: unknown, writeHeader = true) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(writeHeader ? { 'X-PocketBank-Request': '1' } : {}), Cookie: client.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookie = response.headers.get('set-cookie');
    if (cookie) client.cookie = cookie.split(';')[0];
    return response;
  }
  async function snapshot(client: { cookie: string }): Promise<Snapshot> {
    const response = await request(client, '/api/dashboard');
    assert.equal(response.status, 200);
    return response.json() as Promise<Snapshot>;
  }
  let a: Snapshot;
  let b: Snapshot;
  let checkingA: string;
  let savingsA: string;
  let checkingB: string;
  let savingsB: string;
  try {
    await t.test('requires authentication and the write header', async () => {
      assert.equal((await request(outsider, '/api/dashboard')).status, 401);
      assert.equal((await request(outsider, '/api/auth/register', {}, false)).status, 403);
      assert.equal((await request(outsider, '/api/auth/register', { displayName: 'Bad', email: 'invalid', password })).status, 400);
    });
    await t.test('registration requires matching passwords and accepts relaxed passwords', async () => {
      const body = { displayName: 'Alice', email: 'alice@example.com', password };
      for (const confirmPassword of [undefined, '', 'Simple', 'simple ']) {
        const response = await request(outsider, '/api/auth/register', { ...body, confirmPassword });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).message, 'Passwords do not match.');
      }
      for (const invalid of ['short', 'a'.repeat(129)]) {
        assert.equal((await request(outsider, '/api/auth/register', { ...body, password: invalid, confirmPassword: invalid })).status, 400);
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get()!['count'], 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get()!['count'], 0);
    });
    await t.test('registration creates checking and exactly one opening deposit', async () => {
      for (const [client, name] of [[alice, 'Alice'], [bob, 'Bob']] as const) {
        const response = await request(client, '/api/auth/register', { displayName: name, email: `${name}@example.com`, password, confirmPassword: password });
        assert.equal(response.status, 201);
        const cookie = response.headers.get('set-cookie')!;
        assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i);
      }
      a = await snapshot(alice); b = await snapshot(bob);
      assert.equal(a.accounts.length, 1); assert.equal(a.accounts[0].balanceCents, 100000);
      assert.equal(a.transactions.length, 1); assert.equal(a.transactions[0].amountCents, 100000);
      checkingA = a.accounts[0].number; checkingB = b.accounts[0].number;
      assert.notEqual(checkingA, checkingB);
      assert.equal((await request(outsider, '/api/auth/register', { displayName: 'Other', email: 'ALICE@example.com', password, confirmPassword: password })).status, 409);
      const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(a.user.id)!;
      assert.notEqual(stored['password_hash'], password);
      assert(!JSON.stringify(a).includes('password_hash'));
    });
    await t.test('savings starts empty and can only be opened once', async () => {
      assert.equal((await request(alice, '/api/accounts/savings', {})).status, 201);
      assert.equal((await request(bob, '/api/accounts/savings', {})).status, 201);
      assert.equal((await request(alice, '/api/accounts/savings', {})).status, 409);
      a = await snapshot(alice); b = await snapshot(bob);
      const savings = a.accounts.find(account => account.kind === 'savings')!;
      assert.equal(savings.balanceCents, 0); assert.equal(a.transactions.length, 1);
      savingsA = savings.number; savingsB = b.accounts.find(account => account.kind === 'savings')!.number;
    });
    await t.test('own-account transfers conserve money and retries do not send twice', async () => {
      const body = { sourceNumber: checkingA, destinationNumber: savingsA, amountCents: 12550, requestId: randomUUID() };
      assert.equal((await request(alice, '/api/transfers/preview', body)).status, 200);
      const response = await request(alice, '/api/transfers', body);
      assert.equal(response.status, 200);
      const receipt = await response.json();
      assert.deepEqual(await (await request(alice, '/api/transfers', body)).json(), receipt);
      a = await snapshot(alice);
      assert.deepEqual(a.accounts.map(account => account.balanceCents), [87450, 12550]);
      assert.equal(a.transactions.length, 2);
      assert.equal((await request(alice, '/api/transfers', { ...body, amountCents: 1 })).status, 409);
    });
    await t.test('unknown recipients return a clear error without changing balances', async () => {
      const before = await snapshot(alice);
      const body = { sourceNumber: checkingA, destinationNumber: '0000000000000000', amountCents: 100, requestId: randomUUID() };
      for (const route of ['/api/transfers/preview', '/api/transfers']) {
        const response = await request(alice, route, body);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).message, 'Recipient checking account not found.');
      }
      assert.deepEqual(await snapshot(alice), before);
    });
    await t.test('checking and savings can send to another checking, but not another savings', async () => {
      for (const sourceNumber of [checkingA, savingsA]) {
        const body = { sourceNumber, destinationNumber: checkingB, amountCents: 100, requestId: randomUUID() };
        const preview = await request(alice, '/api/transfers/preview', body);
        assert.equal(preview.status, 200); assert.equal((await preview.json()).recipientName, 'Bob');
        assert.equal((await request(alice, '/api/transfers', body)).status, 200);
        assert.equal((await request(alice, '/api/transfers', { ...body, destinationNumber: savingsB, requestId: randomUUID() })).status, 400);
      }
      b = await snapshot(bob);
      assert.equal(b.accounts[0].balanceCents, 100200);
      assert.equal(b.transactions.filter(item => item.direction === 'incoming').length, 3);
      assert.equal(b.transactions.some(item => item.amountCents === 12550), false);
      assert.equal((await request(alice, '/api/transfers', { sourceNumber: checkingB, destinationNumber: checkingA, amountCents: 100, requestId: randomUUID() })).status, 403);
    });
    await t.test('invalid amounts and overdrafts leave balances and history unchanged', async () => {
      const before = await snapshot(alice);
      for (const amountCents of [0, -1, 1.5, '100', 100000000, Number.MAX_SAFE_INTEGER + 1]) {
        const response = await request(alice, '/api/transfers', { sourceNumber: checkingA, destinationNumber: checkingB, amountCents, requestId: randomUUID() });
        assert.equal(response.status, 400);
      }
      assert.deepEqual(await snapshot(alice), before);
    });
    await t.test('a database failure after debiting rolls the whole transfer back', async () => {
      const before = await snapshot(alice);
      db.exec(`CREATE TRIGGER fail_credit BEFORE UPDATE ON accounts WHEN NEW.number = '${checkingB}' BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
      assert.throws(() => transferMoney(db, before.user.id, { sourceNumber: checkingA, destinationNumber: checkingB, amountCents: 100, requestId: randomUUID() }), /test failure/);
      db.exec('DROP TRIGGER fail_credit');
      assert.deepEqual(await snapshot(alice), before);
    });
    await t.test('logout invalidates sessions, login restores balances, and expired sessions fail', async () => {
      const before = await snapshot(alice);
      const oldCookie = alice.cookie;
      assert.equal((await request(alice, '/api/auth/logout', {})).status, 204);
      assert.equal((await request({ cookie: oldCookie }, '/api/dashboard')).status, 401);
      assert.equal((await request(alice, '/api/auth/login', { email: 'alice@example.com', password: 'WrongPassword123' })).status, 401);
      assert.equal((await request(alice, '/api/auth/login', { email: 'alice@example.com', password })).status, 200);
      assert.deepEqual(await snapshot(alice), before);
      const storedSession = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(before.user.id)!;
      assert(!alice.cookie.includes(String(storedSession['token_hash'])));
      db.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(before.user.id);
      assert.equal((await request(alice, '/api/dashboard')).status, 401);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    const reopened = openDatabase(path);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM users').get()!['count'], 2);
    assert.equal(reopened.prepare('SELECT SUM(balance_cents) AS total FROM accounts').get()!['total'], 200000);
    reopened.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});
