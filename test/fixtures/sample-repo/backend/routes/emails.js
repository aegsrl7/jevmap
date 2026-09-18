// Email routes: list, archive and stats for the inbox page.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { optionalAuth } = require('../middleware/auth');

// List emails with filters (category, archived).
router.get('/api/emails', optionalAuth, async (req, res) => {
  const rows = await db.query('SELECT * FROM email_messages WHERE archived = 0');
  res.json(rows);
});

// Archive one email and notify the connected clients.
router.post('/api/emails/:id/archive', optionalAuth, async (req, res) => {
  await db.query('UPDATE email_messages SET archived = 1 WHERE id = ?', [req.params.id]);
  const io = req.app.get('io');
  io.emit('email-updated', { id: req.params.id });
  res.json({ ok: true });
});

// Count unread emails per category.
function countUnread(rows) {
  return rows.filter((r) => !r.read).length;
}

// Format a sender for the list view.
const formatSender = (email) => {
  return `${email.from_name} <${email.from_address}>`;
};

module.exports = router;
