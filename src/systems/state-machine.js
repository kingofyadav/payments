// Every valid transition is explicit. Anything not listed is illegal.
const ORDER_TRANSITIONS = {
  created:  ['attempted', 'expired'],
  attempted: ['paid', 'failed'],
  paid:     [],
  failed:   [],
  expired:  [],
};

const PAYMENT_TRANSITIONS = {
  created:    ['authorized', 'failed'],
  authorized: ['captured', 'failed'],
  captured:   ['refunded'],
  failed:     [],
  refunded:   [],
};

function assertOrderTransition(from, to) {
  if (!(ORDER_TRANSITIONS[from] || []).includes(to)) {
    throw new Error(`Invalid order transition: ${from} → ${to}`);
  }
}

function assertPaymentTransition(from, to) {
  if (!(PAYMENT_TRANSITIONS[from] || []).includes(to)) {
    throw new Error(`Invalid payment transition: ${from} → ${to}`);
  }
}

module.exports = { assertOrderTransition, assertPaymentTransition };
