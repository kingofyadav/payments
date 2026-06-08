const express = require('express');
const { createContact, getContact, listContacts, updateContact } = require('../payouts/contacts');

const router = express.Router();

router.post('/', (req, res) => {
  try { res.status(201).json(createContact(req.merchantId, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/', (req, res) => {
  const { type, limit, offset } = req.query;
  res.json(listContacts(req.merchantId, {
    type, limit: parseInt(limit) || 20, offset: parseInt(offset) || 0,
  }));
});

router.get('/:id', (req, res) => {
  const c = getContact(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  if (c.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  res.json(c);
});

router.patch('/:id', (req, res) => {
  try {
    const c = updateContact(req.params.id, req.merchantId, req.body);
    if (!c) return res.status(404).json({ error: 'Contact not found' });
    res.json(c);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
