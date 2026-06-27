-- GPS Challenge Platform - D1 Schema
-- Run: wrangler d1 execute gps-challenge-db --file=server/schema.sql

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ────────────────────────────────────────────────────────────────
-- Users
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- Entra OID or sub
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  join_date     INTEGER NOT NULL DEFAULT (unixepoch()),
  last_active   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ────────────────────────────────────────────────────────────────
-- User Statistics (one row per user)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_stats (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lifetime_distance REAL    NOT NULL DEFAULT 0,   -- metres
  lifetime_duration INTEGER NOT NULL DEFAULT 0,   -- seconds
  total_activities  INTEGER NOT NULL DEFAULT 0,
  walk_count        INTEGER NOT NULL DEFAULT 0,
  run_count         INTEGER NOT NULL DEFAULT 0,
  current_streak    INTEGER NOT NULL DEFAULT 0,
  best_streak       INTEGER NOT NULL DEFAULT 0,
  current_xp        INTEGER NOT NULL DEFAULT 0,
  lifetime_xp       INTEGER NOT NULL DEFAULT 0,
  current_level     INTEGER NOT NULL DEFAULT 1,
  last_activity_date TEXT                          -- YYYY-MM-DD
);

-- ────────────────────────────────────────────────────────────────
-- Activities
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK(type IN ('walk','run')),
  start_time      INTEGER NOT NULL,   -- unix ms
  end_time        INTEGER NOT NULL,
  duration        INTEGER NOT NULL,   -- seconds
  distance        REAL    NOT NULL,   -- metres
  avg_pace        REAL,               -- seconds per km
  avg_speed       REAL,               -- km/h
  elevation_gain  REAL    NOT NULL DEFAULT 0,
  calories        INTEGER NOT NULL DEFAULT 0,
  polyline        TEXT    NOT NULL,   -- encoded JSON array
  gps_point_count INTEGER NOT NULL DEFAULT 0,
  xp_awarded      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, start_time)         -- prevent duplicate uploads
);
CREATE INDEX IF NOT EXISTS idx_activities_user    ON activities(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_type    ON activities(type);

-- ────────────────────────────────────────────────────────────────
-- Personal Bests
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS personal_bests (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  fastest_1k        REAL,   -- seconds
  fastest_mile      REAL,
  fastest_5k        REAL,
  fastest_10k       REAL,
  longest_walk      REAL,   -- metres
  longest_run       REAL,
  longest_duration  INTEGER, -- seconds
  best_avg_speed    REAL,   -- km/h
  best_daily_dist   REAL,
  best_weekly_dist  REAL,
  best_elevation    REAL,
  best_streak       INTEGER
);

-- ────────────────────────────────────────────────────────────────
-- Achievement Definitions (seeded)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS achievements (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  icon        TEXT NOT NULL,
  xp_reward   INTEGER NOT NULL DEFAULT 0
);

-- ────────────────────────────────────────────────────────────────
-- User Achievements
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL REFERENCES achievements(id),
  earned_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS idx_ua_user ON user_achievements(user_id);

-- ────────────────────────────────────────────────────────────────
-- Friendships
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friend_requests (
  id          TEXT PRIMARY KEY,
  from_user   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(from_user, to_user)
);

CREATE TABLE IF NOT EXISTS friendships (
  user_a     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_a, user_b),
  CHECK(user_a < user_b)
);
CREATE INDEX IF NOT EXISTS idx_friends_a ON friendships(user_a);
CREATE INDEX IF NOT EXISTS idx_friends_b ON friendships(user_b);

-- ────────────────────────────────────────────────────────────────
-- Clubs
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clubs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  invite_code TEXT NOT NULL UNIQUE,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS club_members (
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
  joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (club_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_club_members ON club_members(user_id);

-- ────────────────────────────────────────────────────────────────
-- Daily Challenges
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_challenges (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,             -- YYYY-MM-DD
  type        TEXT NOT NULL,             -- 'walk_distance','run_distance','duration','beat_yesterday'
  target      REAL NOT NULL,             -- km or minutes
  label       TEXT NOT NULL,
  xp_reward   INTEGER NOT NULL DEFAULT 50
);
CREATE INDEX IF NOT EXISTS idx_challenges_date ON daily_challenges(date);

CREATE TABLE IF NOT EXISTS user_daily_challenges (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_id TEXT NOT NULL REFERENCES daily_challenges(id),
  completed_at INTEGER,
  activity_id  TEXT REFERENCES activities(id),
  PRIMARY KEY (user_id, challenge_id)
);

-- ────────────────────────────────────────────────────────────────
-- XP Events (audit log)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xp_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  activity_id TEXT REFERENCES activities(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_xp_user ON xp_events(user_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────
-- Seed achievements
-- ────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO achievements VALUES
  ('first_walk',     'First Steps',       'Complete your first walk',          '🚶', 50),
  ('first_run',      'Runner''s High',     'Complete your first run',           '🏃', 50),
  ('first_5k',       'First 5K',          'Complete a 5 km activity',          '🎽', 100),
  ('first_10k',      'First 10K',         'Complete a 10 km activity',         '🏅', 200),
  ('dist_50k',       '50 km Club',        'Travel 50 km lifetime',             '🌟', 150),
  ('dist_100k',      'Century',           'Travel 100 km lifetime',            '💯', 300),
  ('dist_250k',      'Iron Legs',         'Travel 250 km lifetime',            '🦾', 500),
  ('dist_500k',      'Half-Millennium',   'Travel 500 km lifetime',            '🥇', 750),
  ('dist_1000k',     'Legend',            'Travel 1 000 km lifetime',          '👑', 1000),
  ('streak_7',       'Week Warrior',      'Maintain a 7-day activity streak',  '🔥', 200),
  ('streak_30',      'Month of Motion',   'Maintain a 30-day streak',          '🌋', 500),
  ('acts_100',       'Centurion',         'Complete 100 activities',           '💎', 400),
  ('early_bird',     'Early Bird',        'Start an activity before 7 AM',     '🌅', 75),
  ('night_owl',      'Night Owl',         'Start an activity after 9 PM',      '🦉', 75),
  ('weekend_warrior','Weekend Warrior',   'Complete 4 weekend activities',     '🏖️', 100);
