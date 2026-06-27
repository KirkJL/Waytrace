-- ════════════════════════════════════════════════════════════════
-- GPS Challenge Platform – Sponsorship Migration
-- Canonical sponsorship migration (supersedes server/schema_sponsorship.sql).
-- Run: wrangler d1 execute gps-challenge-db --file=server/sponsorship-migration.sql
-- (after running server/schema.sql)
-- ════════════════════════════════════════════════════════════════

PRAGMA foreign_keys=ON;

-- ── Add lifetime_steps to user_stats ─────────────────────────────
-- (ALTER TABLE ADD COLUMN is safe in SQLite / D1)
ALTER TABLE user_stats ADD COLUMN lifetime_steps INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_user_stats_steps ON user_stats(lifetime_steps DESC);

-- ── Charities ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS charities (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  logo_url            TEXT,
  website_url         TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  total_donated_pence INTEGER NOT NULL DEFAULT 0,
  challenge_count     INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Seed some charities
INSERT OR IGNORE INTO charities(id,name,description,logo_url,website_url) VALUES
  ('charity_bhf',  'British Heart Foundation', 'Fighting heart disease and stroke', null, 'https://www.bhf.org.uk'),
  ('charity_cr',   'Cancer Research UK',       'Beating cancer sooner',            null, 'https://www.cancerresearchuk.org'),
  ('charity_mind', 'Mind',                     'Better mental health for all',     null, 'https://www.mind.org.uk'),
  ('charity_rspca','RSPCA',                    'Preventing cruelty to animals',    null, 'https://www.rspca.org.uk'),
  ('charity_oxfam','Oxfam',                    'Ending global poverty',            null, 'https://www.oxfam.org.uk');

-- ── Sponsored Challenges ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sponsored_challenges (
  id                  TEXT PRIMARY KEY,
  sponsor_id          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  walker_id           TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Challenge definition
  steps_required      INTEGER NOT NULL,
  gross_amount_pence  INTEGER NOT NULL,         -- pot amount (sponsor pays this + fee)
  processing_fee_pence INTEGER NOT NULL DEFAULT 0,
  failure_action      TEXT NOT NULL CHECK(failure_action IN ('refund','charity')),
  charity_id          TEXT REFERENCES charities(id),
  message             TEXT,
  -- Timer
  duration_hours      REAL NOT NULL,            -- calculated from steps / 500
  -- Snapshot on accept (NEVER recalculated)
  start_steps         INTEGER,                  -- walker lifetime steps at accept time
  target_steps        INTEGER,                  -- start_steps + steps_required
  -- Timestamps
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  accepted_at         INTEGER,
  deadline            INTEGER,                  -- unix seconds
  completed_at        INTEGER,
  expired_at          INTEGER,
  -- Financials (set on completion)
  success_fee_pence   INTEGER,
  walker_payout_pence INTEGER,
  -- State machine
  -- No 'disputed' state: a challenge either hit its step target or it
  -- didn't. Outcome is purely server-verified step count vs. deadline.
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','active','completed','expired',
                                       'refunded','donated_to_charity','cancelled')),
  locked              INTEGER NOT NULL DEFAULT 0  -- optimistic lock for race-condition prevention
);

CREATE INDEX IF NOT EXISTS idx_sc_walker   ON sponsored_challenges(walker_id, status);
CREATE INDEX IF NOT EXISTS idx_sc_sponsor  ON sponsored_challenges(sponsor_id, status);
CREATE INDEX IF NOT EXISTS idx_sc_status   ON sponsored_challenges(status, deadline);
CREATE INDEX IF NOT EXISTS idx_sc_deadline ON sponsored_challenges(deadline) WHERE status='active';

-- ── Challenge Payments (audit trail) ─────────────────────────────
CREATE TABLE IF NOT EXISTS challenge_payments (
  id           TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES sponsored_challenges(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK(type IN ('charge','processing_fee','payout',
                                            'refund','charity_donation','success_fee')),
  amount_pence INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_cp_challenge ON challenge_payments(challenge_id);
CREATE INDEX IF NOT EXISTS idx_cp_type      ON challenge_payments(type, status);

-- ── Challenge Events (full audit log) ────────────────────────────
CREATE TABLE IF NOT EXISTS challenge_events (
  id           TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES sponsored_challenges(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,   -- created, accepted, completed, expired, disputed, etc.
  actor_id     TEXT REFERENCES users(id),
  metadata     TEXT,            -- JSON blob
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ce_challenge ON challenge_events(challenge_id, created_at DESC);

-- ── Payouts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payouts (
  id           TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES sponsored_challenges(id),
  walker_id    TEXT NOT NULL REFERENCES users(id),
  amount_pence INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','paid','failed')),
  paid_at      INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_payouts_walker ON payouts(walker_id, status);

-- ── Notifications ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  data       TEXT,             -- JSON
  read       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at DESC);

-- ── Receipts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipts (
  id           TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES sponsored_challenges(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK(type IN ('sponsor_charge','walker_payout',
                                            'refund','charity_donation')),
  amount_pence INTEGER NOT NULL,
  receipt_data TEXT,           -- JSON with full breakdown
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_receipts_recipient ON receipts(recipient_id, created_at DESC);

-- ── Walker Sponsorship Stats (denormalised for speed) ─────────────
CREATE TABLE IF NOT EXISTS walker_sponsor_stats (
  user_id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_challenge_count   INTEGER NOT NULL DEFAULT 0,
  completed_challenge_count INTEGER NOT NULL DEFAULT 0,
  failed_challenge_count   INTEGER NOT NULL DEFAULT 0,
  lifetime_earnings_pence  INTEGER NOT NULL DEFAULT 0,
  current_earnings_pence   INTEGER NOT NULL DEFAULT 0,
  pending_earnings_pence   INTEGER NOT NULL DEFAULT 0,
  charity_raised_pence     INTEGER NOT NULL DEFAULT 0,
  current_pot_pence        INTEGER NOT NULL DEFAULT 0,
  fastest_completion_sec   INTEGER,
  largest_challenge_pence  INTEGER,
  longest_challenge_steps  INTEGER,
  avg_completion_sec       INTEGER
);

-- ── Sponsor Stats ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sponsor_stats (
  user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  challenges_created    INTEGER NOT NULL DEFAULT 0,
  total_sponsored_pence INTEGER NOT NULL DEFAULT 0,
  total_refunded_pence  INTEGER NOT NULL DEFAULT 0,
  total_donated_pence   INTEGER NOT NULL DEFAULT 0,
  walkers_supported     INTEGER NOT NULL DEFAULT 0,
  completions           INTEGER NOT NULL DEFAULT 0,
  failures              INTEGER NOT NULL DEFAULT 0
);
