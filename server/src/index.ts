import { openDatabase } from './database.js';
import { createApp } from './app.js';

const database = openDatabase();
const server = createApp(database).listen(3000, '127.0.0.1', () => {
  console.log('PocketBank API: http://127.0.0.1:3000/api/health');
});
function shutdown(): void {
  server.close(() => { database.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
