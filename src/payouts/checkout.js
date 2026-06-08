// Public payout link API — no auth required (beneficiary claims their payout)
const express = require('express');
const { getPayoutLinkByCode, claimPayoutLink } = require('./links');

const router = express.Router();

router.get('/:code', (req, res) => {
  const link = getPayoutLinkByCode(req.params.code);
  if (!link || link.status === 'expired' || link.status === 'cancelled')
    return res.status(404).json({ error: 'Payout link not found or expired' });
  if (link.expires_at && link.expires_at < Math.floor(Date.now() / 1000))
    return res.status(410).json({ error: 'Payout link has expired' });
  // Return only safe public fields
  res.json({
    amount:      link.amount,
    currency:    link.currency,
    purpose:     link.purpose,
    description: link.description,
    status:      link.status,
    expires_at:  link.expires_at,
  });
});

router.post('/:code/claim', async (req, res) => {
  try {
    res.json(await claimPayoutLink(req.params.code, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
