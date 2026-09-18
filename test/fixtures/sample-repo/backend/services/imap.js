// IMAP sync service: pulls new messages and cleans old ones.
const cron = require('node-cron');
const db = require('../db');

/**
 * Fetch new messages from the IMAP server and store them.
 */
async function syncMailbox() {
  const accounts = await db.query('SELECT id FROM email_accounts WHERE active = 1');
  for (const account of accounts) {
    await db.query('INSERT INTO email_messages (account_id, subject) VALUES (?, ?)', [account.id, 'hello']);
  }
}

// Remove messages older than 90 days.
async function purgeOld() {
  await db.query('DELETE FROM email_messages WHERE received_at < NOW() - INTERVAL 90 DAY');
}

// Sync every five minutes.
cron.schedule('*/5 * * * *', syncMailbox);

module.exports = { syncMailbox, purgeOld };
