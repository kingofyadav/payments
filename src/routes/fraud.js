'use strict';
const express   = require('express');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { listBlacklist, addToBlacklist, removeFromBlacklist, VALID_TYPES } = require('../fraud/blacklist');
const { VALID_OPERATORS, VALID_ACTIONS } = require('../fraud/rules_engine');
const { apiError } = require('../middleware/errors');

const router = express.Router();

// ── Blacklists ────────────────────────────────────────────────────────────────

router.get('/blacklists', (req, res) => {
  const { type, limit, offset } = req.query;
  if (type && !VALID_TYPES.includes(type))
    return apiError(res, 400, `type must be one of: ${VALID_TYPES.join(', ')}`);
  res.json(listBlacklist({ type, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0 }));
});

router.post('/blacklists', (req, res) => {
  const { type, value, reason, expires_at } = req.body;
  try {
    const entry = addToBlacklist(type, value, { reason, added_by: req.merchantId, expires_at });
    res.status(201).json(entry);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

router.delete('/blacklists/:type/:value', (req, res) => {
  const removed = removeFromBlacklist(req.params.type, req.params.value);
  if (!removed) return apiError(res, 404, 'Blacklist entry not found');
  res.json({ deleted: true });
});

// ── Fraud Rules ───────────────────────────────────────────────────────────────

router.get('/rules', (req, res) => {
  const rules = getDb().prepare(
    'SELECT * FROM fraud_rules WHERE is_active=1 AND (merchant_id IS NULL OR merchant_id=?) ORDER BY score DESC'
  ).all(req.merchantId);
  res.json({ count: rules.length, items: rules });
});

router.post('/rules', (req, res) => {
  const { name, description, field, operator, value, action, score } = req.body;
  if (!name || !field || !operator || value === undefined || !action)
    return apiError(res, 400, 'name, field, operator, value, action are required');
  if (!VALID_OPERATORS.includes(operator))
    return apiError(res, 400, `operator must be one of: ${VALID_OPERATORS.join(', ')}`);
  if (!VALID_ACTIONS.includes(action))
    return apiError(res, 400, `action must be one of: ${VALID_ACTIONS.join(', ')}`);

  const db  = getDb();
  const id  = 'frule_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO fraud_rules
      (id, merchant_id, name, description, field, operator, value, action, score, is_active, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,1,?)
  `).run(id, req.merchantId, name, description ?? null, field, operator,
      String(value), action, parseInt(score) || 25, now);
  res.status(201).json(db.prepare('SELECT * FROM fraud_rules WHERE id=?').get(id));
});

router.patch('/rules/:id', (req, res) => {
  const db   = getDb();
  const rule = db.prepare('SELECT * FROM fraud_rules WHERE id=?').get(req.params.id);
  if (!rule) return apiError(res, 404, 'Rule not found');
  if (rule.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden — cannot edit global rules');

  const allowed = ['name', 'description', 'value', 'action', 'score', 'is_active'];
  const sets = [], vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { sets.push(`${key}=?`); vals.push(req.body[key]); }
  }
  if (!sets.length) return apiError(res, 400, 'Nothing to update');
  db.prepare(`UPDATE fraud_rules SET ${sets.join(',')} WHERE id=?`).run(...vals, req.params.id);
  res.json(db.prepare('SELECT * FROM fraud_rules WHERE id=?').get(req.params.id));
});

router.delete('/rules/:id', (req, res) => {
  const db   = getDb();
  const rule = db.prepare('SELECT * FROM fraud_rules WHERE id=?').get(req.params.id);
  if (!rule) return apiError(res, 404, 'Rule not found');
  if (!rule.merchant_id || rule.merchant_id !== req.merchantId)
    return apiError(res, 403, 'Forbidden — cannot delete global rules');
  db.prepare('DELETE FROM fraud_rules WHERE id=?').run(req.params.id);
  res.json({ deleted: true });
});

// ── Fraud Events ──────────────────────────────────────────────────────────────

router.get('/events', (req, res) => {
  const db    = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const off   = parseInt(req.query.offset) || 0;
  const { action, from, to } = req.query;

  let where = 'WHERE merchant_id=?';
  const params = [req.merchantId];
  if (action) { where += ' AND action=?';      params.push(action); }
  if (from)   { where += ' AND created_at>=?'; params.push(parseInt(from)); }
  if (to)     { where += ' AND created_at<=?'; params.push(parseInt(to)); }

  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM fraud_events ${where}`).get(...params);
  const items = db.prepare(
    `SELECT * FROM fraud_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, off).map(r => ({
    ...r,
    signals: r.signals ? _tryParse(r.signals) : [],
  }));

  res.json({ count, items });
});

// ── Fraud Stats ───────────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN action='block'  THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN action='review' THEN 1 ELSE 0 END) AS reviewed,
      SUM(CASE WHEN action='flag'   THEN 1 ELSE 0 END) AS flagged,
      SUM(CASE WHEN action='allow'  THEN 1 ELSE 0 END) AS allowed,
      CAST(AVG(risk_score) AS INTEGER)                 AS avg_risk_score
    FROM fraud_events WHERE merchant_id=? AND created_at >= ?
  `).get(req.merchantId, now - 86400 * 7);

  const topSignals = db.prepare(`
    SELECT signals FROM fraud_events WHERE merchant_id=? AND action!='allow' AND created_at >= ?
    ORDER BY created_at DESC LIMIT 100
  `).all(req.merchantId, now - 86400 * 7)
    .flatMap(r => _tryParse(r.signals) ?? [])
    .reduce((acc, s) => { acc[s.rule ?? s.type] = (acc[s.rule ?? s.type] ?? 0) + 1; return acc; }, {});

  res.json({
    period: '7d',
    ...stats,
    block_rate_pct: stats.total > 0 ? +((stats.blocked / stats.total) * 100).toFixed(2) : 0,
    top_signals: Object.entries(topSignals).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([rule, count]) => ({ rule, count })),
  });
});

function _tryParse(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = router;
