'use strict';
const { randomUUID } = require('crypto');
const { getDb }      = require('../db/database');

const VALID_OPERATORS = ['gt', 'lt', 'gte', 'lte', 'eq', 'neq', 'in', 'not_in', 'contains', 'regex'];
const VALID_ACTIONS   = ['block', 'review', 'flag'];

// Compiled regex cache — avoids rebuilding on every transaction
const _regexCache = new Map();

// Detects catastrophically-backtracking patterns:
//   nested quantifiers:         (a+)+, (.*)*
//   alternation + outer quant:  (a|aa)+  — multiple paths, outer repetition
const DANGEROUS_REGEX_RE = /\([^)]*(?:[+*{]|[|])[^)]*\)[+*{]/;

/**
 * Validates a user-supplied regex pattern for safety before storing.
 * Throws a descriptive Error on invalid/dangerous input.
 */
function validateRegexPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200)
    throw new Error('regex pattern must be a string of 200 characters or fewer');
  if (DANGEROUS_REGEX_RE.test(pattern))
    throw new Error('regex pattern contains a potentially catastrophic backtracking construct');
  try { new RegExp(pattern, 'i'); } catch (e) {
    throw new Error(`Invalid regex: ${e.message}`);
  }
}

function _getRegex(pattern) {
  if (!_regexCache.has(pattern)) _regexCache.set(pattern, new RegExp(pattern, 'i'));
  return _regexCache.get(pattern);
}

function evaluate(value, operator, ruleValue) {
  switch (operator) {
    case 'gt':       return Number(value) >  Number(ruleValue);
    case 'lt':       return Number(value) <  Number(ruleValue);
    case 'gte':      return Number(value) >= Number(ruleValue);
    case 'lte':      return Number(value) <= Number(ruleValue);
    case 'eq':       return String(value) === ruleValue;
    case 'neq':      return String(value) !== ruleValue;
    case 'in':       return JSON.parse(ruleValue).includes(String(value));
    case 'not_in':   return !JSON.parse(ruleValue).includes(String(value));
    case 'contains': return String(value).toLowerCase().includes(ruleValue.toLowerCase());
    case 'regex':    return _getRegex(ruleValue).test(String(value));
    default:         return false;
  }
}

function runRulesEngine(context, merchantId) {
  const db = getDb();
  // Load global rules + merchant-specific rules, highest score first
  const rules = db.prepare(`
    SELECT * FROM fraud_rules
    WHERE is_active=1 AND (merchant_id IS NULL OR merchant_id=?)
    ORDER BY score DESC
  `).all(merchantId ?? null);

  const triggered = [];
  let totalScore  = 0;
  let decision    = 'allow';

  for (const rule of rules) {
    const contextValue = context[rule.field];
    if (contextValue === undefined || contextValue === null) continue;
    let hit = false;
    try { hit = evaluate(contextValue, rule.operator, rule.value); } catch {}
    if (!hit) continue;

    triggered.push({ rule_id: rule.id, name: rule.name, action: rule.action, score: rule.score });
    totalScore += rule.score;

    if (rule.action === 'block')                                    decision = 'block';
    else if (rule.action === 'review' && decision !== 'block')      decision = 'review';
    else if (rule.action === 'flag'   && decision === 'allow')      decision = 'flag';
  }

  return { triggered, score: Math.min(totalScore, 100), decision };
}

// Seed built-in global rules on first boot
function seedDefaultRules() {
  const db = getDb();
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM fraud_rules WHERE merchant_id IS NULL").get();
  if (count > 0) return;

  const now  = Math.floor(Date.now() / 1000);
  const seed = db.prepare(`
    INSERT OR IGNORE INTO fraud_rules
      (id, merchant_id, name, description, field, operator, value, action, score, is_active, created_at)
    VALUES (?,NULL,?,?,?,?,?,?,?,1,?)
  `);

  const defaults = [
    ['block_very_large_txn',    'Block single transactions above ₹10,00,000',       'amount',          'gt',  '10000000', 'block',  100],
    ['review_large_txn',        'Review transactions above ₹1,00,000',               'amount',          'gt',  '1000000',  'review',  50],
    ['flag_near_reporting_limit','Flag amounts 85–99% of ₹10L AML threshold',        'amount',          'gte', '850000',   'flag',    30],
    ['flag_round_amount',       'Flag suspiciously round amounts (AML structuring)', 'is_round_amount', 'eq',  '1',        'flag',    15],
    ['flag_night_txn',          'Flag large transactions between 2–4 AM',            'hour',            'in',  '["2","3","4"]', 'flag', 20],
  ];

  for (const [name, description, field, operator, value, action, score] of defaults) {
    seed.run('frule_' + randomUUID().replace(/-/g, '').slice(0, 12), name, description, field, operator, value, action, score, now);
  }
}

module.exports = { runRulesEngine, seedDefaultRules, validateRegexPattern, VALID_OPERATORS, VALID_ACTIONS };
