// Routes a payment to the best available processor.
// Phase 1: static config. Phase 2: live success-rate weighting.
const PROCESSORS = {
  upi: [
    { name: 'cashfree_upi',  successRate: 0.94, priority: 1 },
    { name: 'razorpay_upi',  successRate: 0.91, priority: 2 },
  ],
  card: [
    { name: 'axis_acquiring', successRate: 0.89, priority: 1 },
    { name: 'hdfc_acquiring', successRate: 0.87, priority: 2 },
  ],
  netbanking: [
    { name: 'billdesk',      successRate: 0.82, priority: 1 },
  ],
  wallet: [
    { name: 'paytm_wallet',  successRate: 0.95, priority: 1 },
  ],
};

function routePayment({ method }) {
  const options = PROCESSORS[method];
  if (!options || options.length === 0) {
    throw new Error(`No processor configured for method: ${method}`);
  }
  // Pick highest priority (lowest number). Tie-break on successRate.
  const processor = [...options].sort(
    (a, b) => a.priority - b.priority || b.successRate - a.successRate
  )[0];

  return { processor: processor.name, successRate: processor.successRate };
}

module.exports = { routePayment };
