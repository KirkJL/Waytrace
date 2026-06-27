/**
 * GPS Challenge Platform – Cloudflare Worker
 * Handles auth, activity submission, stats, PBs, XP, achievements,
 * leaderboards, friends, clubs, and daily challenges.
 */

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function uuid() {
  return crypto.randomUUID();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const h = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
  };
  if (allowed.includes(origin) || allowed.includes("*")) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

// ─────────────────────────────────────────────────────────────────
// JWT verification (Microsoft Entra External ID + Google)
// ─────────────────────────────────────────────────────────────────

const JWKS_CACHE_KEY = "jwks_cache";

async function fetchJwks(jwksUri, kv) {
  const cached = await kv.get(JWKS_CACHE_KEY, "json");
  if (cached) return cached;
  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error("JWKS fetch failed");
  const data = await res.json();
  await kv.put(JWKS_CACHE_KEY, JSON.stringify(data), { expirationTtl: 3600 });
  return data;
}

async function importPublicKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

function base64urlToBuffer(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded2 = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "=");
  const bin = atob(padded2);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function verifyJwt(token, env, kv) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")));
  const payload = JSON.parse(
    new TextDecoder().decode(base64urlToBuffer(payloadB64))
  );

  // Allow local dev bypass
  if (env.DEV_MODE === "true" && payload.dev === true) {
    return payload;
  }

  const jwksUri = env.JWKS_URI;
  const jwks = await fetchJwks(jwksUri, kv);
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Key not found");

  const key = await importPublicKey(jwk);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = base64urlToBuffer(sigB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  if (!valid) throw new Error("Invalid signature");

  const now = nowSec();
  if (payload.exp && payload.exp < now) throw new Error("Token expired");
  if (payload.iss !== env.JWT_ISSUER) throw new Error("Wrong issuer");

  return payload;
}

async function authenticate(req, env, kv) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) throw new Error("Missing token");
  const token = auth.slice(7);
  const payload = await verifyJwt(token, env, kv);
  const userId = payload.oid || payload.sub;
  if (!userId) throw new Error("No user id in token");
  return { userId, email: payload.email || payload.preferred_username || "", name: payload.name || "Unknown" };
}

async function ensureUser(db, userId, email, name) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO users(id,email,display_name,join_date) VALUES(?,?,?,?)`
    )
    .bind(userId, email, name, nowSec())
    .run();
  await db
    .prepare(`UPDATE users SET last_active=? WHERE id=?`)
    .bind(nowSec(), userId)
    .run();
  await db
    .prepare(`INSERT OR IGNORE INTO user_stats(user_id) VALUES(?)`)
    .bind(userId)
    .run();
  await db
    .prepare(`INSERT OR IGNORE INTO personal_bests(user_id) VALUES(?)`)
    .bind(userId)
    .run();
}

// ─────────────────────────────────────────────────────────────────
// XP & Levelling
// ─────────────────────────────────────────────────────────────────

function xpForLevel(level) {
  return level * 250;
}

function computeLevel(totalXp) {
  let level = 1;
  while (totalXp >= xpForLevel(level)) {
    totalXp -= xpForLevel(level);
    level++;
  }
  return level;
}

async function awardXp(db, userId, amount, reason, activityId = null) {
  if (amount <= 0) return;
  await db
    .prepare(`INSERT INTO xp_events(id,user_id,amount,reason,activity_id,created_at) VALUES(?,?,?,?,?,?)`)
    .bind(uuid(), userId, amount, reason, activityId, nowSec())
    .run();
  const stats = await db
    .prepare(`SELECT current_xp, lifetime_xp FROM user_stats WHERE user_id=?`)
    .bind(userId)
    .first();
  const newLifetime = (stats?.lifetime_xp || 0) + amount;
  const newLevel = computeLevel(newLifetime);
  await db
    .prepare(
      `UPDATE user_stats SET current_xp=current_xp+?, lifetime_xp=?, current_level=? WHERE user_id=?`
    )
    .bind(amount, newLifetime, newLevel, userId)
    .run();
}

// ─────────────────────────────────────────────────────────────────
// GPS / Activity Validation
// ─────────────────────────────────────────────────────────────────

const MAX_SPEED_WALK_MPS = 3.5;  // ~12.6 km/h – brisk walk ceiling (per-segment)
const MAX_SPEED_RUN_MPS  = 12;   // ~43 km/h – sprinting ceiling (per-segment)
const MAX_SPEED_GPS_MPS  = 15;   // absolute sanity ceiling (GPS glitch protection)

// Anti-cheat: SUSTAINED average speed ceilings, distinct from the per-segment
// ones above. A single fast segment (downhill, GPS jitter) is normal and the
// per-segment checks already tolerate it; a high speed held for the whole
// activity is the actual signature of cycling (or other wheeled transport)
// rather than the selected walk/run type.
const MAX_AVG_SPEED_WALK_MPS = MAX_SPEED_WALK_MPS; // ~12.6 km/h sustained
const MAX_AVG_SPEED_RUN_MPS  = 6.0;                // ~21.6 km/h sustained – above elite 10K race pace
const MIN_DURATION_FOR_AVG_SPEED_CHECK_SEC = 180;  // don't penalise short sprints/intervals

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function validateAndComputeActivity(points, type, startTime, endTime) {
  if (!Array.isArray(points) || points.length < 2)
    return { error: "Need at least 2 GPS points" };

  const durationSec = Math.round((endTime - startTime) / 1000);
  if (durationSec < 10) return { error: "Activity too short" };
  if (durationSec > 86400) return { error: "Activity too long" };

  let totalDist = 0;
  let elevGain = 0;
  let prevAlt = null;
  const speedLimit = type === "walk" ? MAX_SPEED_WALK_MPS : MAX_SPEED_RUN_MPS;
  let suspiciousSegments = 0;

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];

    if (
      typeof p.lat !== "number" ||
      typeof p.lng !== "number" ||
      typeof p.t !== "number"
    )
      return { error: `Invalid point at index ${i}` };

    if (p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180)
      return { error: `Out-of-range coordinates at index ${i}` };

    const dist = haversineMeters(prev.lat, prev.lng, p.lat, p.lng);
    const dt = (p.t - prev.t) / 1000;
    if (dt < 0) return { error: "Non-monotonic timestamps" };

    if (dt > 0) {
      const speed = dist / dt;
      if (speed > MAX_SPEED_GPS_MPS) {
        suspiciousSegments++;
        continue; // skip GPS glitch
      }
      if (speed > speedLimit) suspiciousSegments++;
    }

    totalDist += dist;

    if (p.alt != null && prevAlt != null && p.alt > prevAlt) {
      elevGain += p.alt - prevAlt;
    }
    prevAlt = p.alt ?? prevAlt;
  }

  // Reject if more than 20% of segments are suspicious
  if (suspiciousSegments / points.length > 0.2)
    return { error: "Too many suspicious speed segments – activity rejected" };

  const avgSpeedMps = durationSec > 0 ? totalDist / durationSec : 0;

  // Anti-cheat: a sustained average above what's realistically achievable on
  // foot for the whole activity means it's very likely a bike (or similar).
  const avgSpeedLimit = type === "walk" ? MAX_AVG_SPEED_WALK_MPS : MAX_AVG_SPEED_RUN_MPS;
  if (durationSec >= MIN_DURATION_FOR_AVG_SPEED_CHECK_SEC && avgSpeedMps > avgSpeedLimit) {
    return {
      error: `Average speed too high for a ${type} (${(avgSpeedMps * 3.6).toFixed(1)} km/h sustained) – this looks like cycling, not a ${type}. Activity rejected.`,
    };
  }

  const avgSpeedKmh = avgSpeedMps * 3.6;
  const avgPaceSecPerKm = avgSpeedMps > 0 ? 1000 / avgSpeedMps : null;
  const calories = Math.round(
    (type === "run" ? 0.9 : 0.6) * (totalDist / 1000) * 70
  ); // rough estimate, 70kg default

  return {
    distance: totalDist,
    duration: durationSec,
    avgSpeedKmh,
    avgPaceSecPerKm,
    elevationGain: elevGain,
    calories,
    pointCount: points.length,
  };
}

// ─────────────────────────────────────────────────────────────────
// Personal Bests
// ─────────────────────────────────────────────────────────────────

async function updatePersonalBests(db, userId, activity, points) {
  const pb = await db
    .prepare(`SELECT * FROM personal_bests WHERE user_id=?`)
    .bind(userId)
    .first();
  if (!pb) return [];

  const newPbs = [];
  const dist = activity.distance;
  const dur = activity.duration;
  const speed = activity.avgSpeedKmh;

  // Helper to check split time
  function splitTime(targetMeters) {
    let cum = 0;
    for (let i = 1; i < points.length; i++) {
      const d = haversineMeters(
        points[i - 1].lat, points[i - 1].lng,
        points[i].lat, points[i].lng
      );
      const dt = (points[i].t - points[i - 1].t) / 1000;
      cum += d;
      if (cum >= targetMeters) {
        // interpolate
        const excess = cum - targetMeters;
        const frac = excess / d;
        const elapsed = (points[i].t - points[0].t) / 1000 - frac * dt;
        return elapsed;
      }
    }
    return null;
  }

  const updates = {};

  // Speed split checks (runs only for pace, both for speed)
  const t1k = splitTime(1000);
  const t1mi = splitTime(1609.34);
  const t5k = splitTime(5000);
  const t10k = splitTime(10000);

  if (t1k && (!pb.fastest_1k || t1k < pb.fastest_1k)) {
    updates.fastest_1k = t1k; newPbs.push("fastest_1k");
  }
  if (t1mi && (!pb.fastest_mile || t1mi < pb.fastest_mile)) {
    updates.fastest_mile = t1mi; newPbs.push("fastest_mile");
  }
  if (t5k && (!pb.fastest_5k || t5k < pb.fastest_5k)) {
    updates.fastest_5k = t5k; newPbs.push("fastest_5k");
  }
  if (t10k && (!pb.fastest_10k || t10k < pb.fastest_10k)) {
    updates.fastest_10k = t10k; newPbs.push("fastest_10k");
  }

  if (activity.type === "walk" && (!pb.longest_walk || dist > pb.longest_walk)) {
    updates.longest_walk = dist; newPbs.push("longest_walk");
  }
  if (activity.type === "run" && (!pb.longest_run || dist > pb.longest_run)) {
    updates.longest_run = dist; newPbs.push("longest_run");
  }
  if (!pb.longest_duration || dur > pb.longest_duration) {
    updates.longest_duration = dur; newPbs.push("longest_duration");
  }
  if (!pb.best_avg_speed || speed > pb.best_avg_speed) {
    updates.best_avg_speed = speed; newPbs.push("best_avg_speed");
  }
  if (!pb.best_elevation || activity.elevationGain > pb.best_elevation) {
    updates.best_elevation = activity.elevationGain; newPbs.push("best_elevation");
  }

  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map((k) => `${k}=?`).join(",");
    const vals = Object.values(updates);
    await db
      .prepare(`UPDATE personal_bests SET ${sets} WHERE user_id=?`)
      .bind(...vals, userId)
      .run();
  }

  return newPbs;
}

// ─────────────────────────────────────────────────────────────────
// Achievements
// ─────────────────────────────────────────────────────────────────

async function checkAchievements(db, userId, stats, activity) {
  const existing = await db
    .prepare(`SELECT achievement_id FROM user_achievements WHERE user_id=?`)
    .bind(userId)
    .all();
  const have = new Set(existing.results.map((r) => r.achievement_id));
  const toGrant = [];

  const distKm = stats.lifetime_distance / 1000;
  const hour = new Date(activity.start_time).getUTCHours();

  function check(id, cond) {
    if (!have.has(id) && cond) toGrant.push(id);
  }

  check("first_walk", activity.type === "walk");
  check("first_run", activity.type === "run");
  check("first_5k", activity.distance >= 5000);
  check("first_10k", activity.distance >= 10000);
  check("dist_50k", distKm >= 50);
  check("dist_100k", distKm >= 100);
  check("dist_250k", distKm >= 250);
  check("dist_500k", distKm >= 500);
  check("dist_1000k", distKm >= 1000);
  check("streak_7", stats.current_streak >= 7);
  check("streak_30", stats.current_streak >= 30);
  check("acts_100", stats.total_activities >= 100);
  check("early_bird", hour < 7);
  check("night_owl", hour >= 21);

  // Weekend warrior: count weekend activities
  if (!have.has("weekend_warrior")) {
    const wd = await db
      .prepare(
        `SELECT COUNT(*) as n FROM activities WHERE user_id=? AND (strftime('%w',datetime(start_time/1000,'unixepoch')) IN ('0','6'))`
      )
      .bind(userId)
      .first();
    if ((wd?.n || 0) >= 4) toGrant.push("weekend_warrior");
  }

  for (const id of toGrant) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO user_achievements(user_id,achievement_id,earned_at) VALUES(?,?,?)`
      )
      .bind(userId, id, nowSec())
      .run();
    const ach = await db
      .prepare(`SELECT xp_reward FROM achievements WHERE id=?`)
      .bind(id)
      .first();
    if (ach?.xp_reward) await awardXp(db, userId, ach.xp_reward, `achievement:${id}`);
  }

  return toGrant;
}

// ─────────────────────────────────────────────────────────────────
// Leaderboard Caching via KV
// ─────────────────────────────────────────────────────────────────

async function rebuildLeaderboard(db, kv, period, category) {
  const now = Math.floor(Date.now() / 1000);
  let since;
  if (period === "daily") since = now - 86400;
  else if (period === "weekly") since = now - 604800;
  else if (period === "monthly") since = now - 2592000;
  else since = 0;

  let query;
  if (category === "distance") {
    query = `SELECT u.id, u.display_name, u.avatar_url, SUM(a.distance)/1000 AS value
             FROM activities a JOIN users u ON a.user_id=u.id
             WHERE a.created_at>=? GROUP BY u.id ORDER BY value DESC LIMIT 100`;
  } else if (category === "xp") {
    query = `SELECT u.id, u.display_name, u.avatar_url, SUM(x.amount) AS value
             FROM xp_events x JOIN users u ON x.user_id=u.id
             WHERE x.created_at>=? GROUP BY u.id ORDER BY value DESC LIMIT 100`;
  } else if (category === "activities") {
    query = `SELECT u.id, u.display_name, u.avatar_url, COUNT(*) AS value
             FROM activities a JOIN users u ON a.user_id=u.id
             WHERE a.created_at>=? GROUP BY u.id ORDER BY value DESC LIMIT 100`;
  } else { // duration
    query = `SELECT u.id, u.display_name, u.avatar_url, SUM(a.duration)/60 AS value
             FROM activities a JOIN users u ON a.user_id=u.id
             WHERE a.created_at>=? GROUP BY u.id ORDER BY value DESC LIMIT 100`;
  }

  const rows = await db.prepare(query).bind(since).all();
  const key = `lb:${period}:${category}`;
  await kv.put(key, JSON.stringify({ updated: now, rows: rows.results }), {
    expirationTtl: 300,
  });
  return rows.results;
}

// ─────────────────────────────────────────────────────────────────
// Daily Challenge Generation
// ─────────────────────────────────────────────────────────────────

const CHALLENGE_TEMPLATES = [
  { type: "walk_distance", targets: [3, 5], label: (t) => `Walk ${t} km` },
  { type: "run_distance", targets: [2, 5], label: (t) => `Run ${t} km` },
  { type: "duration", targets: [30, 45, 60], label: (t) => `Exercise for ${t} minutes` },
  { type: "beat_yesterday", targets: [1], label: () => "Beat yesterday's distance" },
];

async function ensureDailyChallenge(db, today) {
  const existing = await db
    .prepare(`SELECT id FROM daily_challenges WHERE date=?`)
    .bind(today)
    .first();
  if (existing) return;

  // Pick 3 random challenges
  const picked = [];
  const shuffled = [...CHALLENGE_TEMPLATES].sort(() => Math.random() - 0.5);
  for (const tpl of shuffled) {
    if (picked.length >= 3) break;
    const target = tpl.targets[Math.floor(Math.random() * tpl.targets.length)];
    picked.push({
      id: uuid(),
      date: today,
      type: tpl.type,
      target,
      label: tpl.label(target),
      xp_reward: 50,
    });
  }

  for (const c of picked) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO daily_challenges(id,date,type,target,label,xp_reward) VALUES(?,?,?,?,?,?)`
      )
      .bind(c.id, c.date, c.type, c.target, c.label, c.xp_reward)
      .run();
  }
}

async function checkDailyChallenges(db, userId, activity) {
  const today = todayStr();
  await ensureDailyChallenge(db, today);
  const challenges = await db
    .prepare(`SELECT * FROM daily_challenges WHERE date=?`)
    .bind(today)
    .all();

  const distKm = activity.distance / 1000;
  const durMin = activity.duration / 60;
  const granted = [];

  for (const c of challenges.results) {
    const done = await db
      .prepare(
        `SELECT completed_at FROM user_daily_challenges WHERE user_id=? AND challenge_id=?`
      )
      .bind(userId, c.id)
      .first();
    if (done?.completed_at) continue;

    let met = false;
    if (c.type === "walk_distance" && activity.type === "walk" && distKm >= c.target) met = true;
    if (c.type === "run_distance" && activity.type === "run" && distKm >= c.target) met = true;
    if (c.type === "duration" && durMin >= c.target) met = true;
    if (c.type === "beat_yesterday") {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const prev = await db
        .prepare(
          `SELECT COALESCE(SUM(distance),0) as d FROM activities WHERE user_id=? AND date(datetime(start_time/1000,'unixepoch'))=?`
        )
        .bind(userId, yesterday)
        .first();
      met = distKm > (prev?.d || 0) / 1000;
    }

    if (met) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO user_daily_challenges(user_id,challenge_id,completed_at,activity_id) VALUES(?,?,?,?)`
        )
        .bind(userId, c.id, nowSec(), activity.id)
        .run();
      await awardXp(db, userId, c.xp_reward, `challenge:${c.id}`, activity.id);
      granted.push(c);
    }
  }

  return granted;
}

// ─────────────────────────────────────────────────────────────────
// Streak Update
// ─────────────────────────────────────────────────────────────────

async function updateStreak(db, userId) {
  const today = todayStr();
  const stats = await db
    .prepare(`SELECT current_streak, best_streak, last_activity_date FROM user_stats WHERE user_id=?`)
    .bind(userId)
    .first();

  if (!stats) return 0;

  const last = stats.last_activity_date;
  let streak = stats.current_streak || 0;

  if (last === today) return streak; // already counted today

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (last === yesterday) {
    streak++;
  } else if (!last) {
    streak = 1;
  } else {
    streak = 1; // broken
  }

  const best = Math.max(streak, stats.best_streak || 0);

  await db
    .prepare(
      `UPDATE user_stats SET current_streak=?, best_streak=?, last_activity_date=? WHERE user_id=?`
    )
    .bind(streak, best, today, userId)
    .run();

  // Streak milestone XP
  if (streak === 7) await awardXp(db, userId, 150, "streak_milestone:7");
  if (streak === 30) await awardXp(db, userId, 500, "streak_milestone:30");
  if (streak === 100) await awardXp(db, userId, 1000, "streak_milestone:100");

  return streak;
}

// ─────────────────────────────────────────────────────────────────
// Rate Limiting via KV
// ─────────────────────────────────────────────────────────────────

async function rateLimit(kv, key, max, windowSec) {
  const now = nowSec();
  const window = Math.floor(now / windowSec);
  const rlKey = `rl:${key}:${window}`;
  const cur = parseInt((await kv.get(rlKey)) || "0");
  if (cur >= max) return false;
  await kv.put(rlKey, String(cur + 1), { expirationTtl: windowSec * 2 });
  return true;
}

// ─────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const db = env.DB;
    const kv = env.KV;

    function withCors(res) {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }

    try {
      const res = await route(request, url, env, db, kv);
      return withCors(res);
    } catch (e) {
      console.error(e);
      return withCors(err(e.message || "Internal error", 500));
    }
  },

  // Fires on the cron schedule configured in wrangler.toml's [triggers] block.
  // This is the reliable path for resolving expired sponsored challenges –
  // the in-request check in /activities only catches a walker's own expired
  // challenges when they happen to log a new activity, so a walker who stops
  // tracking would otherwise leave the sponsor's money stuck in limbo forever.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processExpiredChallenges(env.DB));
  },
};

async function route(request, url, env, db, kv) {
  const path = url.pathname.replace(/\/$/, "");
  const method = request.method;

  // ── Public ────────────────────────────────────────────────────

  if (path === "/health" && method === "GET") {
    return json({ ok: true, ts: Date.now() });
  }

  // Beta access request – unauthenticated by design (the whole point is
  // people who don't have an account yet). Rate-limited by IP since there's
  // no userId to key off.
  if (path === "/account-requests" && method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ok = await rateLimit(kv, `acct_req:${ip}`, 5, 3600);
    if (!ok) return err("Too many requests – try again later", 429);

    const body = await request.json();
    const name = (body.name || "").trim();
    const email = (body.email || "").trim();
    const message = (body.message || "").trim();

    if (!name || name.length > 100) return err("Valid name required");
    if (!email || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return err("Valid email required");
    if (message.length > 500) return err("Message too long");

    await db.prepare(
      `INSERT INTO account_requests(id,name,email,message,created_at) VALUES(?,?,?,?,?)`
    ).bind(uuid(), name, email, message || null, nowSec()).run();

    return json({ ok: true }, 201);
  }

  // Auth: exchange MSAL token for profile
  if (path === "/auth/me" && method === "GET") {
    const { userId, email, name } = await authenticate(request, env, kv);
    await ensureUser(db, userId, email, name);
    const user = await db.prepare(`SELECT * FROM users WHERE id=?`).bind(userId).first();
    const stats = await db.prepare(`SELECT * FROM user_stats WHERE user_id=?`).bind(userId).first();
    const pbs = await db.prepare(`SELECT * FROM personal_bests WHERE user_id=?`).bind(userId).first();
    return json({ user, stats, pbs });
  }

  // Avatar: stored directly as a data: URL in users.avatar_url – no R2/blob
  // storage is provisioned for this project, so this keeps it self-contained.
  if (path === "/profile/avatar" && method === "POST") {
    const { userId, email, name } = await authenticate(request, env, kv);
    await ensureUser(db, userId, email, name);

    const { avatarDataUrl } = await request.json();
    if (typeof avatarDataUrl !== "string") return err("avatarDataUrl required");

    const match = avatarDataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return err("Avatar must be a base64 PNG/JPEG/WebP data URL");

    // Cap at ~250KB decoded to keep D1 rows small (client already downsizes
    // before upload, this is just a server-side backstop).
    const decodedBytes = Math.ceil((match[2].length * 3) / 4);
    if (decodedBytes > 250_000) return err("Avatar image too large (max 250KB)");

    await db.prepare(`UPDATE users SET avatar_url=? WHERE id=?`).bind(avatarDataUrl, userId).run();
    return json({ avatarUrl: avatarDataUrl });
  }

  // ── Activities ────────────────────────────────────────────────

  if (path === "/activities" && method === "POST") {
    const { userId, email, name } = await authenticate(request, env, kv);

    const ok = await rateLimit(kv, `act:${userId}`, 20, 3600);
    if (!ok) return err("Rate limit exceeded", 429);

    await ensureUser(db, userId, email, name);

    const body = await request.json();
    const { type, startTime, endTime, points: rawPoints } = body;

    if (!["walk", "run"].includes(type)) return err("Invalid type");
    if (!startTime || !endTime || !rawPoints) return err("Missing fields");

    const result = validateAndComputeActivity(rawPoints, type, startTime, endTime);
    if (result.error) return err(result.error);

    const actId = uuid();
    const polyline = JSON.stringify(
      rawPoints.map((p) => [parseFloat(p.lat.toFixed(6)), parseFloat(p.lng.toFixed(6))])
    );

    // Check for duplicate
    const dup = await db
      .prepare(`SELECT id FROM activities WHERE user_id=? AND start_time=?`)
      .bind(userId, startTime)
      .first();
    if (dup) return err("Duplicate activity", 409);

    // Base XP
    const distKm = result.distance / 1000;
    const xpPerKm = type === "run" ? 15 : 10;
    let xpTotal = Math.round(distKm * xpPerKm) + 25; // +25 completion bonus

    await db
      .prepare(
        `INSERT INTO activities(id,user_id,type,start_time,end_time,duration,distance,avg_pace,avg_speed,elevation_gain,calories,polyline,gps_point_count,xp_awarded,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        actId, userId, type, startTime, endTime,
        result.duration, result.distance,
        result.avgPaceSecPerKm, result.avgSpeedKmh,
        result.elevationGain, result.calories,
        polyline, result.pointCount,
        xpTotal, nowSec()
      )
      .run();

    // Update stats
    await db
      .prepare(
        `UPDATE user_stats SET
           lifetime_distance=lifetime_distance+?,
           lifetime_duration=lifetime_duration+?,
           total_activities=total_activities+1,
           walk_count=walk_count+CASE WHEN ?='walk' THEN 1 ELSE 0 END,
           run_count=run_count+CASE WHEN ?='run' THEN 1 ELSE 0 END
         WHERE user_id=?`
      )
      .bind(result.distance, result.duration, type, type, userId)
      .run();

    const streak = await updateStreak(db, userId);

    const stats = await db
      .prepare(`SELECT * FROM user_stats WHERE user_id=?`)
      .bind(userId)
      .first();

    const actObj = { id: actId, type, start_time: startTime, distance: result.distance };

    // PBs
    const newPbs = await updatePersonalBests(db, userId, { ...result, type, start_time: startTime }, rawPoints);
    if (newPbs.length) {
      xpTotal += newPbs.length * 100;
      await db.prepare(`UPDATE activities SET xp_awarded=? WHERE id=?`).bind(xpTotal, actId).run();
    }

    await awardXp(db, userId, xpTotal, `activity:${type}`, actId);

    // Achievements
    const newAchs = await checkAchievements(db, userId, stats, actObj);

    // Daily challenges
    const completedChallenges = await checkDailyChallenges(db, userId, {
      ...result, type, id: actId,
    });

    // ── Update lifetime steps (1 km ≈ 1312 steps) ────────────────
    const stepsFromActivity = Math.round((result.distance / 1000) * 1312);
    await db
      .prepare(`UPDATE user_stats SET lifetime_steps=lifetime_steps+? WHERE user_id=?`)
      .bind(stepsFromActivity, userId)
      .run();

    // ── Check active sponsored step challenges ────────────────────
    const updatedStats = await db
      .prepare(`SELECT lifetime_steps FROM user_stats WHERE user_id=?`)
      .bind(userId)
      .first();
    const currentSteps = updatedStats?.lifetime_steps || 0;
    await checkSponsoredChallenges(db, userId, currentSteps);

    return json({
      activity: { id: actId, xpAwarded: xpTotal },
      newPersonalBests: newPbs,
      newAchievements: newAchs,
      completedChallenges,
      streak,
      stepsAdded: stepsFromActivity,
      totalSteps: currentSteps,
    });
  }

  if (path === "/activities" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const rows = await db
      .prepare(
        `SELECT id,type,start_time,end_time,duration,distance,avg_pace,avg_speed,elevation_gain,calories,xp_awarded
         FROM activities WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(userId, limit, offset)
      .all();
    return json(rows.results);
  }

  if (path.startsWith("/activities/") && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const actId = path.split("/")[2];
    const row = await db
      .prepare(`SELECT * FROM activities WHERE id=? AND user_id=?`)
      .bind(actId, userId)
      .first();
    if (!row) return err("Not found", 404);
    return json(row);
  }

  // ── Stats & PBs ───────────────────────────────────────────────

  if (path === "/stats" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const stats = await db.prepare(`SELECT * FROM user_stats WHERE user_id=?`).bind(userId).first();
    const pbs = await db.prepare(`SELECT * FROM personal_bests WHERE user_id=?`).bind(userId).first();
    return json({ stats, pbs });
  }

  // ── Achievements ─────────────────────────────────────────────

  if (path === "/achievements" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const rows = await db
      .prepare(
        `SELECT a.*, ua.earned_at FROM achievements a
         LEFT JOIN user_achievements ua ON a.id=ua.achievement_id AND ua.user_id=?
         ORDER BY ua.earned_at DESC NULLS LAST`
      )
      .bind(userId)
      .all();
    return json(rows.results);
  }

  // ── Daily Challenges ─────────────────────────────────────────

  if (path === "/challenges" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const today = todayStr();
    await ensureDailyChallenge(db, today);
    const rows = await db
      .prepare(
        `SELECT c.*, udc.completed_at FROM daily_challenges c
         LEFT JOIN user_daily_challenges udc ON c.id=udc.challenge_id AND udc.user_id=?
         WHERE c.date=?`
      )
      .bind(userId, today)
      .all();
    return json(rows.results);
  }

  // ── Leaderboards ─────────────────────────────────────────────

  if (path === "/leaderboard" && method === "GET") {
    const period = url.searchParams.get("period") || "weekly";
    const category = url.searchParams.get("category") || "distance";
    const validPeriods = ["daily", "weekly", "monthly", "lifetime"];
    const validCategories = ["distance", "xp", "activities", "duration"];
    if (!validPeriods.includes(period)) return err("Invalid period");
    if (!validCategories.includes(category)) return err("Invalid category");

    const cacheKey = `lb:${period}:${category}`;
    const cached = await kv.get(cacheKey, "json");
    if (cached && (nowSec() - cached.updated) < 300) return json(cached.rows);

    const rows = await rebuildLeaderboard(db, kv, period, category);
    return json(rows);
  }

  // ── Friends ───────────────────────────────────────────────────

  if (path === "/users/search" && method === "GET") {
    await authenticate(request, env, kv);
    const q = url.searchParams.get("q") || "";
    if (q.length < 2) return err("Query too short");
    const rows = await db
      .prepare(
        `SELECT id, display_name, avatar_url FROM users WHERE display_name LIKE ? OR email LIKE ? LIMIT 20`
      )
      .bind(`%${q}%`, `%${q}%`)
      .all();
    return json(rows.results);
  }

  if (path === "/friends/request" && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    const { toUserId } = await request.json();
    if (!toUserId || toUserId === userId) return err("Invalid target");
    const existing = await db
      .prepare(`SELECT id FROM friendships WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)`)
      .bind(userId, toUserId, toUserId, userId)
      .first();
    if (existing) return err("Already friends");
    await db
      .prepare(`INSERT OR IGNORE INTO friend_requests(id,from_user,to_user) VALUES(?,?,?)`)
      .bind(uuid(), userId, toUserId)
      .run();
    return json({ ok: true });
  }

  if (path === "/friends/accept" && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    const { fromUserId } = await request.json();
    const req = await db
      .prepare(`SELECT id FROM friend_requests WHERE from_user=? AND to_user=?`)
      .bind(fromUserId, userId)
      .first();
    if (!req) return err("Request not found");
    await db.prepare(`DELETE FROM friend_requests WHERE id=?`).bind(req.id).run();
    const [a, b] = [userId, fromUserId].sort();
    await db
      .prepare(`INSERT OR IGNORE INTO friendships(user_a,user_b) VALUES(?,?)`)
      .bind(a, b)
      .run();
    return json({ ok: true });
  }

  if (path === "/friends/reject" && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    const { fromUserId } = await request.json();
    await db
      .prepare(`DELETE FROM friend_requests WHERE from_user=? AND to_user=?`)
      .bind(fromUserId, userId)
      .run();
    return json({ ok: true });
  }

  if (path === "/friends/remove" && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    const { friendId } = await request.json();
    const [a, b] = [userId, friendId].sort();
    await db.prepare(`DELETE FROM friendships WHERE user_a=? AND user_b=?`).bind(a, b).run();
    return json({ ok: true });
  }

  if (path === "/friends" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const rows = await db
      .prepare(
        `SELECT u.id, u.display_name, u.avatar_url, s.current_level, s.lifetime_distance, s.total_activities
         FROM friendships f
         JOIN users u ON (CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END)=u.id
         LEFT JOIN user_stats s ON s.user_id=u.id
         WHERE f.user_a=? OR f.user_b=?`
      )
      .bind(userId, userId, userId)
      .all();
    const requests = await db
      .prepare(
        `SELECT u.id, u.display_name, u.avatar_url, r.created_at
         FROM friend_requests r JOIN users u ON r.from_user=u.id
         WHERE r.to_user=?`
      )
      .bind(userId)
      .all();
    return json({ friends: rows.results, pendingRequests: requests.results });
  }

  // ── Clubs ─────────────────────────────────────────────────────

  if (path === "/clubs" && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    const { name, description } = await request.json();
    if (!name?.trim()) return err("Name required");
    const clubId = uuid();
    const inviteCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    await db
      .prepare(`INSERT INTO clubs(id,name,description,invite_code,owner_id) VALUES(?,?,?,?,?)`)
      .bind(clubId, name.trim(), description || "", inviteCode, userId)
      .run();
    await db
      .prepare(`INSERT INTO club_members(club_id,user_id,role) VALUES(?,?,?)`)
      .bind(clubId, userId, "owner")
      .run();
    return json({ id: clubId, inviteCode });
  }

  if (path === "/clubs/join" && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    const { inviteCode } = await request.json();
    const club = await db.prepare(`SELECT * FROM clubs WHERE invite_code=?`).bind(inviteCode?.toUpperCase()).first();
    if (!club) return err("Invalid invite code");
    await db
      .prepare(`INSERT OR IGNORE INTO club_members(club_id,user_id,role) VALUES(?,?,?)`)
      .bind(club.id, userId, "member")
      .run();
    return json({ club });
  }

  if (path === "/clubs/leave" && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    const { clubId } = await request.json();
    const member = await db
      .prepare(`SELECT role FROM club_members WHERE club_id=? AND user_id=?`)
      .bind(clubId, userId)
      .first();
    if (!member) return err("Not a member");
    if (member.role === "owner") return err("Owner cannot leave – transfer ownership first");
    await db.prepare(`DELETE FROM club_members WHERE club_id=? AND user_id=?`).bind(clubId, userId).run();
    return json({ ok: true });
  }

  if (path.match(/^\/clubs\/[^/]+\/transfer-ownership$/) && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    const clubId = path.split("/")[2];
    const { newOwnerId } = await request.json();
    if (!newOwnerId) return err("newOwnerId required");
    if (newOwnerId === userId) return err("Already the owner");

    const club = await db.prepare(`SELECT owner_id FROM clubs WHERE id=?`).bind(clubId).first();
    if (!club) return err("Club not found", 404);
    if (club.owner_id !== userId) return err("Only the owner can transfer ownership", 403);

    const target = await db
      .prepare(`SELECT role FROM club_members WHERE club_id=? AND user_id=?`)
      .bind(clubId, newOwnerId)
      .first();
    if (!target) return err("New owner must already be a club member");

    await db.prepare(`UPDATE clubs SET owner_id=? WHERE id=?`).bind(newOwnerId, clubId).run();
    await db.prepare(`UPDATE club_members SET role='owner' WHERE club_id=? AND user_id=?`).bind(clubId, newOwnerId).run();
    await db.prepare(`UPDATE club_members SET role='admin' WHERE club_id=? AND user_id=?`).bind(clubId, userId).run();

    return json({ ok: true, newOwnerId });
  }

  if (path.match(/^\/clubs\/[^/]+\/delete$/) && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    const clubId = path.split("/")[2];

    const club = await db.prepare(`SELECT owner_id FROM clubs WHERE id=?`).bind(clubId).first();
    if (!club) return err("Club not found", 404);
    if (club.owner_id !== userId) return err("Only the owner can delete the club", 403);

    // Delete members explicitly rather than relying on ON DELETE CASCADE,
    // since D1 doesn't guarantee foreign_keys pragma is on for every request.
    await db.prepare(`DELETE FROM club_members WHERE club_id=?`).bind(clubId).run();
    await db.prepare(`DELETE FROM clubs WHERE id=?`).bind(clubId).run();

    return json({ ok: true });
  }

  if (path === "/clubs" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const rows = await db
      .prepare(
        `SELECT c.*, cm.role, (SELECT COUNT(*) FROM club_members WHERE club_id=c.id) AS member_count
         FROM clubs c JOIN club_members cm ON c.id=cm.club_id WHERE cm.user_id=?`
      )
      .bind(userId)
      .all();
    return json(rows.results);
  }

  if (path.startsWith("/clubs/") && path.endsWith("/leaderboard") && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const clubId = path.split("/")[2];
    const membership = await db
      .prepare(`SELECT 1 FROM club_members WHERE club_id=? AND user_id=?`)
      .bind(clubId, userId)
      .first();
    if (!membership) return err("Not a member of this club", 403);
    const rows = await db
      .prepare(
        `SELECT u.id, u.display_name, u.avatar_url, s.lifetime_distance, s.lifetime_xp, s.total_activities, s.current_level
         FROM club_members cm JOIN users u ON cm.user_id=u.id LEFT JOIN user_stats s ON s.user_id=u.id
         WHERE cm.club_id=? ORDER BY s.lifetime_xp DESC`
      )
      .bind(clubId)
      .all();
    return json(rows.results);
  }

  // ── Profile (public) ──────────────────────────────────────────

  if (path.startsWith("/profile/") && method === "GET") {
    await authenticate(request, env, kv);
    const targetId = path.split("/")[2];
    const user = await db.prepare(`SELECT id, display_name, avatar_url, join_date FROM users WHERE id=?`).bind(targetId).first();
    if (!user) return err("Not found", 404);
    const stats = await db.prepare(`SELECT * FROM user_stats WHERE user_id=?`).bind(targetId).first();
    const pbs = await db.prepare(`SELECT * FROM personal_bests WHERE user_id=?`).bind(targetId).first();
    return json({ user, stats, pbs });
  }

  // ── Sponsorship: Charities ────────────────────────────────────

  if (path === "/charities" && method === "GET") {
    await authenticate(request, env, kv);
    const rows = await db
      .prepare(`SELECT * FROM charities WHERE active=1 ORDER BY name`)
      .all();
    return json(rows.results);
  }

  // ── Sponsorship: Create challenge (sponsor) ───────────────────

  if (path === "/sponsored-challenges" && method === "POST") {
    const { userId: sponsorId } = await authenticate(request, env, kv);

    const ok = await rateLimit(kv, `sc_create:${sponsorId}`, 10, 3600);
    if (!ok) return err("Rate limit exceeded", 429);

    const body = await request.json();
    const { walkerId, grossAmountPence, stepsRequired, failureAction, charityId, message } = body;

    // Validate inputs
    if (!walkerId) return err("Walker required");
    if (walkerId === sponsorId) return err("Cannot sponsor yourself");
    if (!Number.isInteger(grossAmountPence) || grossAmountPence < 100)
      return err("Minimum challenge amount is £1.00");
    if (grossAmountPence > 1000000) return err("Maximum challenge amount is £10,000");
    if (!Number.isInteger(stepsRequired) || stepsRequired < 100)
      return err("Minimum steps required is 100");
    if (stepsRequired > 1000000) return err("Maximum steps is 1,000,000");
    if (!["refund", "charity"].includes(failureAction))
      return err("Invalid failure action");
    if (failureAction === "charity") {
      if (!charityId) return err("Charity required when failure action is donate");
      const charity = await db.prepare(`SELECT id FROM charities WHERE id=? AND active=1`).bind(charityId).first();
      if (!charity) return err("Invalid or inactive charity");
    }

    // Verify walker exists
    const walker = await db.prepare(`SELECT id FROM users WHERE id=?`).bind(walkerId).first();
    if (!walker) return err("Walker not found");

    // Calculate fees
    const minProcessingFee = parseInt(env.MIN_PROCESSING_FEE_PENCE || "100"); // £1 default
    const processingFeePence = Math.max(minProcessingFee, Math.round(grossAmountPence * 0.02));
    const durationHours = stepsRequired / 500;
    const challengeId = uuid();

    // Create challenge
    await db.prepare(
      `INSERT INTO sponsored_challenges(id,sponsor_id,walker_id,steps_required,gross_amount_pence,
       processing_fee_pence,failure_action,charity_id,duration_hours,status,message,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`
    ).bind(challengeId, sponsorId, walkerId, stepsRequired, grossAmountPence,
      processingFeePence, failureAction, charityId || null, durationHours,
      message || null, nowSec()).run();

    // Log payment: sponsor charged gross + processing fee
    const totalChargePence = grossAmountPence + processingFeePence;
    await db.prepare(
      `INSERT INTO challenge_payments(id,challenge_id,type,amount_pence,status,created_at)
       VALUES(?,?,'charge',?,'completed',?)`
    ).bind(uuid(), challengeId, totalChargePence, nowSec()).run();

    // Log processing fee separately
    await db.prepare(
      `INSERT INTO challenge_payments(id,challenge_id,type,amount_pence,status,created_at)
       VALUES(?,?,'processing_fee',?,'completed',?)`
    ).bind(uuid(), challengeId, processingFeePence, nowSec()).run();

    // Audit event
    await logChallengeEvent(db, challengeId, "created", sponsorId,
      { walkerId, grossAmountPence, processingFeePence, stepsRequired, failureAction });

    // Notify walker
    await createNotification(db, walkerId, "challenge_received",
      "New Sponsorship Challenge!",
      `You've received a £${pence2str(grossAmountPence)} challenge for ${stepsRequired.toLocaleString()} steps`,
      { challengeId });

    // Update sponsor stats
    await db.prepare(
      `INSERT INTO sponsor_stats(user_id,challenges_created,total_sponsored_pence,walkers_supported)
       VALUES(?,1,?,1)
       ON CONFLICT(user_id) DO UPDATE SET
         challenges_created=challenges_created+1,
         total_sponsored_pence=total_sponsored_pence+?,
         walkers_supported=walkers_supported+1`
    ).bind(sponsorId, grossAmountPence, grossAmountPence).run();

    // Receipt for sponsor
    await createReceipt(db, challengeId, sponsorId, "sponsor_charge", totalChargePence, {
      type: "sponsor_charge", challengeId, walkerId, grossAmountPence,
      processingFeePence, totalChargePence, stepsRequired, durationHours,
    });

    return json({ challengeId, processingFeePence, totalChargePence, durationHours }, 201);
  }

  // ── Sponsorship: Accept challenge (walker) ────────────────────

  if (path.match(/^\/sponsored-challenges\/[^/]+\/accept$/) && method === "POST") {
    const { userId: walkerId } = await authenticate(request, env, kv);
    const challengeId = path.split("/")[2];

    const ch = await db.prepare(`SELECT * FROM sponsored_challenges WHERE id=?`).bind(challengeId).first();
    if (!ch) return err("Challenge not found", 404);
    if (ch.walker_id !== walkerId) return err("Not your challenge", 403);
    if (ch.status !== "pending") return err(`Challenge is already ${ch.status}`);
    if (ch.locked) return err("Challenge is locked");

    // Snapshot walker's current steps
    const stats = await db.prepare(`SELECT lifetime_steps FROM user_stats WHERE user_id=?`).bind(walkerId).first();
    await db.prepare(`INSERT OR IGNORE INTO user_stats(user_id) VALUES(?)`).bind(walkerId).run();
    const startSteps = stats?.lifetime_steps || 0;
    const targetSteps = startSteps + ch.steps_required;
    const now = nowSec();
    const deadlineSec = now + Math.round(ch.duration_hours * 3600);

    await db.prepare(
      `UPDATE sponsored_challenges SET
         status='active', start_steps=?, target_steps=?, accepted_at=?, deadline=?
       WHERE id=? AND status='pending' AND locked=0`
    ).bind(startSteps, targetSteps, now, deadlineSec, challengeId).run();

    // Ensure the update actually happened (race-condition guard)
    const updated = await db.prepare(`SELECT status FROM sponsored_challenges WHERE id=?`).bind(challengeId).first();
    if (updated?.status !== "active") return err("Challenge already actioned by another request", 409);

    // Update walker stats
    await db.prepare(
      `INSERT INTO walker_sponsor_stats(user_id,active_challenge_count,current_pot_pence)
       VALUES(?,1,?)
       ON CONFLICT(user_id) DO UPDATE SET
         active_challenge_count=active_challenge_count+1,
         current_pot_pence=current_pot_pence+?`
    ).bind(walkerId, ch.gross_amount_pence, ch.gross_amount_pence).run();

    await logChallengeEvent(db, challengeId, "accepted", walkerId, { startSteps, targetSteps, deadline: deadlineSec });

    await createNotification(db, ch.sponsor_id, "challenge_accepted",
      "Challenge Accepted!",
      `Your challenge has been accepted. The clock is now running.`,
      { challengeId });

    return json({ startSteps, targetSteps, deadline: deadlineSec, durationHours: ch.duration_hours });
  }

  // ── Sponsorship: Cancel (sponsor, only if pending) ────────────

  if (path.match(/^\/sponsored-challenges\/[^/]+\/cancel$/) && method === "POST") {
    const { userId: sponsorId } = await authenticate(request, env, kv);
    const challengeId = path.split("/")[2];

    const ch = await db.prepare(`SELECT * FROM sponsored_challenges WHERE id=?`).bind(challengeId).first();
    if (!ch) return err("Not found", 404);
    if (ch.sponsor_id !== sponsorId) return err("Not your challenge", 403);
    if (ch.status !== "pending") return err("Can only cancel pending challenges");

    // Refund gross amount (processing fee retained)
    await db.prepare(
      `UPDATE sponsored_challenges SET status='cancelled', cancelled_at=?, locked=1 WHERE id=?`
    ).bind(nowSec(), challengeId).run();

    await db.prepare(
      `INSERT INTO challenge_payments(id,challenge_id,type,amount_pence,status,created_at)
       VALUES(?,?,'refund',?,'completed',?)`
    ).bind(uuid(), challengeId, ch.gross_amount_pence, nowSec()).run();

    await logChallengeEvent(db, challengeId, "cancelled", sponsorId, {});
    await createNotification(db, ch.walker_id, "challenge_received",
      "Challenge Cancelled", "A pending challenge was cancelled by the sponsor.", { challengeId });

    return json({ refundedPence: ch.gross_amount_pence });
  }

  // ── Sponsorship: Get my challenges (walker or sponsor view) ───

  if (path === "/sponsored-challenges" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const role = url.searchParams.get("role") || "walker"; // 'walker' or 'sponsor'
    const status = url.searchParams.get("status") || null;

    const col = role === "sponsor" ? "sponsor_id" : "walker_id";
    const statusClause = status ? `AND sc.status=?` : "";
    const bindings = status ? [userId, status] : [userId];

    const rows = await db.prepare(
      `SELECT sc.*,
         sponsor.display_name AS sponsor_name,
         walker.display_name  AS walker_name,
         c.name               AS charity_name
       FROM sponsored_challenges sc
       JOIN users sponsor ON sc.sponsor_id=sponsor.id
       JOIN users walker  ON sc.walker_id=walker.id
       LEFT JOIN charities c ON sc.charity_id=c.id
       WHERE sc.${col}=? ${statusClause}
       ORDER BY sc.created_at DESC LIMIT 50`
    ).bind(...bindings).all();

    // Attach current step progress for active challenges
    const withProgress = await Promise.all(rows.results.map(async ch => {
      if (ch.status !== "active") return ch;
      const walkerStats = await db.prepare(`SELECT lifetime_steps FROM user_stats WHERE user_id=?`)
        .bind(ch.walker_id).first();
      const currentSteps = walkerStats?.lifetime_steps || 0;
      const progressSteps = Math.max(0, currentSteps - (ch.start_steps || 0));
      const pct = ch.steps_required > 0 ? Math.min(100, (progressSteps / ch.steps_required) * 100) : 0;
      const nowTs = nowSec();
      const secsLeft = Math.max(0, (ch.deadline || 0) - nowTs);
      return { ...ch, currentSteps, progressSteps, progressPct: pct, secondsLeft: secsLeft };
    }));

    return json(withProgress);
  }

  // ── Sponsorship: Single challenge detail ──────────────────────

  if (path.match(/^\/sponsored-challenges\/[^/]+$/) && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const challengeId = path.split("/")[2];

    const ch = await db.prepare(
      `SELECT sc.*, sponsor.display_name AS sponsor_name, walker.display_name AS walker_name,
              c.name AS charity_name
       FROM sponsored_challenges sc
       JOIN users sponsor ON sc.sponsor_id=sponsor.id
       JOIN users walker  ON sc.walker_id=walker.id
       LEFT JOIN charities c ON sc.charity_id=c.id
       WHERE sc.id=?`
    ).bind(challengeId).first();

    if (!ch) return err("Not found", 404);
    // Only sponsor or walker can view
    if (ch.sponsor_id !== userId && ch.walker_id !== userId) return err("Forbidden", 403);

    if (ch.status === "active") {
      const walkerStats = await db.prepare(`SELECT lifetime_steps FROM user_stats WHERE user_id=?`)
        .bind(ch.walker_id).first();
      const currentSteps = walkerStats?.lifetime_steps || 0;
      const progressSteps = Math.max(0, currentSteps - (ch.start_steps || 0));
      const pct = Math.min(100, (progressSteps / ch.steps_required) * 100);
      const secsLeft = Math.max(0, (ch.deadline || 0) - nowSec());
      return json({ ...ch, currentSteps, progressSteps, progressPct: pct, secondsLeft: secsLeft });
    }

    return json(ch);
  }

  // ── Sponsorship: Receipts ─────────────────────────────────────

  if (path === "/receipts" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const rows = await db.prepare(
      `SELECT r.*, sc.steps_required, sc.gross_amount_pence
       FROM receipts r
       JOIN sponsored_challenges sc ON r.challenge_id=sc.id
       WHERE r.recipient_id=? ORDER BY r.created_at DESC LIMIT 50`
    ).bind(userId).all();
    return json(rows.results);
  }

  // ── Sponsorship: Notifications ────────────────────────────────

  if (path === "/notifications" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const rows = await db.prepare(
      `SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50`
    ).bind(userId).all();
    return json(rows.results);
  }

  if (path === "/notifications/read-all" && method === "POST") {
    const { userId } = await authenticate(request, env, kv);
    await db.prepare(`UPDATE notifications SET read=1 WHERE user_id=?`).bind(userId).run();
    return json({ ok: true });
  }

  // ── Sponsorship: Walker stats ─────────────────────────────────

  if (path === "/sponsor-stats/me" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const walkerStats = await db.prepare(`SELECT * FROM walker_sponsor_stats WHERE user_id=?`).bind(userId).first();
    const sponsorStats = await db.prepare(`SELECT * FROM sponsor_stats WHERE user_id=?`).bind(userId).first();
    const userStats = await db.prepare(`SELECT lifetime_steps FROM user_stats WHERE user_id=?`).bind(userId).first();
    const charityImpact = await db.prepare(
      `SELECT c.name, c.logo_url, SUM(cp.amount_pence) AS donated_pence, COUNT(*) AS challenges
       FROM challenge_payments cp
       JOIN sponsored_challenges sc ON cp.challenge_id=sc.id
       JOIN charities c ON sc.charity_id=c.id
       WHERE cp.type='charity_donation' AND cp.status='completed'
         AND (sc.walker_id=? OR sc.sponsor_id=?)
       GROUP BY c.id ORDER BY donated_pence DESC`
    ).bind(userId, userId).all();
    return json({
      walkerStats: walkerStats || {},
      sponsorStats: sponsorStats || {},
      charityImpact: charityImpact.results,
      steps: userStats?.lifetime_steps || 0,
    });
  }

  // ── Sponsorship: Leaderboards ─────────────────────────────────

  if (path === "/sponsored-leaderboard" && method === "GET") {
    const { userId } = await authenticate(request, env, kv);
    const category = url.searchParams.get("category") || "earnings";
    const validCategories = ["earnings", "steps", "challenges", "completion_rate", "charity", "largest", "top_sponsors"];
    if (!validCategories.includes(category)) return err("Invalid category");

    let query;
    if (category === "earnings") {
      query = `SELECT u.id,u.display_name,wss.lifetime_earnings_pence AS value
               FROM walker_sponsor_stats wss JOIN users u ON wss.user_id=u.id
               WHERE wss.lifetime_earnings_pence>0 ORDER BY value DESC LIMIT 50`;
    } else if (category === "steps") {
      query = `SELECT u.id,u.display_name,us.lifetime_steps AS value
               FROM user_stats us JOIN users u ON us.user_id=u.id
               WHERE us.lifetime_steps>0 ORDER BY value DESC LIMIT 50`;
    } else if (category === "challenges") {
      query = `SELECT u.id,u.display_name,(wss.completed_challenge_count+wss.failed_challenge_count) AS value
               FROM walker_sponsor_stats wss JOIN users u ON wss.user_id=u.id
               ORDER BY value DESC LIMIT 50`;
    } else if (category === "completion_rate") {
      query = `SELECT u.id,u.display_name,
               CASE WHEN (wss.completed_challenge_count+wss.failed_challenge_count)=0 THEN 0
               ELSE ROUND(100.0*wss.completed_challenge_count/(wss.completed_challenge_count+wss.failed_challenge_count),1) END AS value
               FROM walker_sponsor_stats wss JOIN users u ON wss.user_id=u.id
               WHERE (wss.completed_challenge_count+wss.failed_challenge_count)>=3
               ORDER BY value DESC LIMIT 50`;
    } else if (category === "charity") {
      query = `SELECT u.id,u.display_name,wss.charity_raised_pence AS value
               FROM walker_sponsor_stats wss JOIN users u ON wss.user_id=u.id
               WHERE wss.charity_raised_pence>0 ORDER BY value DESC LIMIT 50`;
    } else if (category === "largest") {
      query = `SELECT u.id,u.display_name,wss.largest_challenge_pence AS value
               FROM walker_sponsor_stats wss JOIN users u ON wss.user_id=u.id
               WHERE wss.largest_challenge_pence>0 ORDER BY value DESC LIMIT 50`;
    } else { // top_sponsors
      query = `SELECT u.id,u.display_name,ss.total_sponsored_pence AS value
               FROM sponsor_stats ss JOIN users u ON ss.user_id=u.id
               WHERE ss.total_sponsored_pence>0 ORDER BY value DESC LIMIT 50`;
    }

    const rows = await db.prepare(query).all();
    return json(rows.results);
  }

  // ── Sponsorship: Admin – expire overdue challenges (cron-style) ──
  // Call this endpoint with a secret header to process expired challenges.
  // In production wire to a Cloudflare Cron Trigger instead.

  if (path === "/admin/process-expired" && method === "POST") {
    const secret = request.headers.get("X-Admin-Secret");
    if (!secret || secret !== env.ADMIN_SECRET) return err("Forbidden", 403);

    const processed = await processExpiredChallenges(db);
    return json({ processed, ts: nowSec() });
  }

  // ── Admin – review beta access requests ───────────────────────

  if (path === "/admin/account-requests" && method === "GET") {
    const secret = request.headers.get("X-Admin-Secret");
    if (!secret || secret !== env.ADMIN_SECRET) return err("Forbidden", 403);

    const rows = await db.prepare(
      `SELECT * FROM account_requests ORDER BY created_at DESC LIMIT 200`
    ).all();
    return json(rows.results);
  }

  return err("Not found", 404);
}

// ─────────────────────────────────────────────────────────────────
// Sponsorship Helpers
// ─────────────────────────────────────────────────────────────────

function pence2str(pence) {
  return (pence / 100).toFixed(2);
}

async function logChallengeEvent(db, challengeId, eventType, actorId, metadata) {
  await db.prepare(
    `INSERT INTO challenge_events(id,challenge_id,event_type,actor_id,metadata,created_at)
     VALUES(?,?,?,?,?,?)`
  ).bind(uuid(), challengeId, eventType, actorId || null,
    JSON.stringify(metadata), nowSec()).run();
}

async function createNotification(db, userId, type, title, body, data = {}) {
  await db.prepare(
    `INSERT INTO notifications(id,user_id,type,title,body,data,created_at)
     VALUES(?,?,?,?,?,?,?)`
  ).bind(uuid(), userId, type, title, body, JSON.stringify(data), nowSec()).run();
}

async function createReceipt(db, challengeId, recipientId, type, amountPence, data) {
  await db.prepare(
    `INSERT INTO receipts(id,challenge_id,recipient_id,type,amount_pence,receipt_data,created_at)
     VALUES(?,?,?,?,?,?,?)`
  ).bind(uuid(), challengeId, recipientId, type, amountPence,
    JSON.stringify({ ...data, generatedAt: new Date().toISOString() }), nowSec()).run();
}

async function processExpiredChallenges(db) {
  const now = nowSec();
  const expired = await db.prepare(
    `SELECT * FROM sponsored_challenges WHERE status='active' AND deadline<=? AND locked=0`
  ).bind(now).all();

  let processed = 0;
  for (const ch of expired.results) {
    await expireChallenge(db, ch);
    processed++;
  }
  return processed;
}

async function checkSponsoredChallenges(db, walkerId, currentSteps) {
  // Find active challenges where walker has now met or exceeded target
  const active = await db.prepare(
    `SELECT * FROM sponsored_challenges
     WHERE walker_id=? AND status='active' AND locked=0 AND target_steps<=?`
  ).bind(walkerId, currentSteps).all();

  for (const ch of active.results) {
    await completeChallenge(db, ch, currentSteps);
  }

  // Also check for expired ones (belt-and-braces alongside cron)
  const now = nowSec();
  const overdue = await db.prepare(
    `SELECT * FROM sponsored_challenges
     WHERE walker_id=? AND status='active' AND deadline<=? AND locked=0`
  ).bind(walkerId, now).all();

  for (const ch of overdue.results) {
    await expireChallenge(db, ch);
  }
}

async function completeChallenge(db, ch, currentSteps) {
  // Lock immediately to prevent double-completion race condition
  const lockResult = await db.prepare(
    `UPDATE sponsored_challenges SET locked=1
     WHERE id=? AND status='active' AND locked=0`
  ).bind(ch.id).run();

  if (!lockResult.meta?.changes) return; // another worker beat us

  const now = nowSec();
  const minSuccessFeeRate = 0.10;
  const minSuccessFeePence = parseInt("100"); // £1 minimum
  const successFeePence = Math.max(
    Math.round(ch.gross_amount_pence * minSuccessFeeRate),
    minSuccessFeePence
  );
  const walkerPayoutPence = ch.gross_amount_pence - successFeePence;
  const completionSec = now - (ch.accepted_at || now);

  await db.prepare(
    `UPDATE sponsored_challenges SET
       status='completed', completed_at=?, success_fee_pence=?, walker_payout_pence=?
     WHERE id=?`
  ).bind(now, successFeePence, walkerPayoutPence, ch.id).run();

  // Create payout record
  await db.prepare(
    `INSERT INTO payouts(id,challenge_id,walker_id,amount_pence,status,created_at)
     VALUES(?,?,?,?,'pending',?)`
  ).bind(uuid(), ch.id, ch.walker_id, walkerPayoutPence, now).run();

  // Payment audit
  await db.prepare(
    `INSERT INTO challenge_payments(id,challenge_id,type,amount_pence,status,created_at)
     VALUES(?,?,'payout',?,'completed',?)`
  ).bind(uuid(), ch.id, walkerPayoutPence, now).run();

  // Walker stats
  await db.prepare(
    `INSERT INTO walker_sponsor_stats(user_id,completed_challenge_count,lifetime_earnings_pence,
       current_earnings_pence,active_challenge_count,current_pot_pence,
       fastest_completion_sec,largest_challenge_pence,longest_challenge_steps)
     VALUES(?,1,?,?,CASE WHEN active_challenge_count>0 THEN -1 ELSE 0 END,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       completed_challenge_count=completed_challenge_count+1,
       lifetime_earnings_pence=lifetime_earnings_pence+?,
       current_earnings_pence=current_earnings_pence+?,
       active_challenge_count=MAX(0,active_challenge_count-1),
       current_pot_pence=MAX(0,current_pot_pence-?),
       fastest_completion_sec=CASE
         WHEN fastest_completion_sec IS NULL OR ?<fastest_completion_sec THEN ?
         ELSE fastest_completion_sec END,
       largest_challenge_pence=CASE
         WHEN largest_challenge_pence IS NULL OR ?>largest_challenge_pence THEN ?
         ELSE largest_challenge_pence END,
       longest_challenge_steps=CASE
         WHEN longest_challenge_steps IS NULL OR ?>longest_challenge_steps THEN ?
         ELSE longest_challenge_steps END`
  ).bind(
    ch.walker_id,
    walkerPayoutPence, walkerPayoutPence, ch.gross_amount_pence,
    completionSec, ch.gross_amount_pence, ch.steps_required,
    walkerPayoutPence, walkerPayoutPence, ch.gross_amount_pence,
    completionSec, completionSec,
    ch.gross_amount_pence, ch.gross_amount_pence,
    ch.steps_required, ch.steps_required
  ).run();

  // Sponsor stats
  await db.prepare(
    `INSERT INTO sponsor_stats(user_id,completions) VALUES(?,1)
     ON CONFLICT(user_id) DO UPDATE SET completions=completions+1`
  ).bind(ch.sponsor_id).run();

  // Receipts
  await createReceipt(db, ch.id, ch.walker_id, "walker_payout", walkerPayoutPence, {
    challengeId: ch.id, walkerPayoutPence, successFeePence,
    grossAmountPence: ch.gross_amount_pence, completedAt: new Date(now * 1000).toISOString(),
  });
  await createReceipt(db, ch.id, ch.sponsor_id, "sponsor_charge", ch.gross_amount_pence, {
    challengeId: ch.id, outcome: "completed", walkerPayoutPence, successFeePence,
    completedAt: new Date(now * 1000).toISOString(),
  });

  // Events and notifications
  await logChallengeEvent(db, ch.id, "completed", ch.walker_id,
    { currentSteps, successFeePence, walkerPayoutPence });

  await createNotification(db, ch.walker_id, "challenge_completed",
    "🎉 Challenge Complete!",
    `You've earned £${pence2str(walkerPayoutPence)}!`,
    { challengeId: ch.id });

  await createNotification(db, ch.sponsor_id, "challenge_completed",
    "Challenge Completed!",
    `Your walker completed the challenge. £${pence2str(walkerPayoutPence)} paid out.`,
    { challengeId: ch.id });
}

async function expireChallenge(db, ch) {
  const lockResult = await db.prepare(
    `UPDATE sponsored_challenges SET locked=1
     WHERE id=? AND status='active' AND locked=0`
  ).bind(ch.id).run();

  if (!lockResult.meta?.changes) return;

  const now = nowSec();
  const newStatus = ch.failure_action === "charity" ? "donated_to_charity" : "refunded";

  await db.prepare(
    `UPDATE sponsored_challenges SET status=?, expired_at=? WHERE id=?`
  ).bind(newStatus, now, ch.id).run();

  if (ch.failure_action === "charity" && ch.charity_id) {
    await db.prepare(
      `INSERT INTO challenge_payments(id,challenge_id,type,amount_pence,status,created_at)
       VALUES(?,?,'charity_donation',?,'completed',?)`
    ).bind(uuid(), ch.id, ch.gross_amount_pence, now).run();

    await db.prepare(
      `UPDATE charities SET total_donated_pence=total_donated_pence+?, challenge_count=challenge_count+1
       WHERE id=?`
    ).bind(ch.gross_amount_pence, ch.charity_id).run();

    await db.prepare(
      `INSERT INTO walker_sponsor_stats(user_id,charity_raised_pence,failed_challenge_count,
         active_challenge_count,current_pot_pence)
       VALUES(?,?,1,0,0)
       ON CONFLICT(user_id) DO UPDATE SET
         charity_raised_pence=charity_raised_pence+?,
         failed_challenge_count=failed_challenge_count+1,
         active_challenge_count=MAX(0,active_challenge_count-1),
         current_pot_pence=MAX(0,current_pot_pence-?)`
    ).bind(ch.walker_id, ch.gross_amount_pence, ch.gross_amount_pence, ch.gross_amount_pence).run();

    await db.prepare(
      `INSERT INTO sponsor_stats(user_id,total_donated_pence,failures) VALUES(?,?,1)
       ON CONFLICT(user_id) DO UPDATE SET
         total_donated_pence=total_donated_pence+?,failures=failures+1`
    ).bind(ch.sponsor_id, ch.gross_amount_pence, ch.gross_amount_pence).run();

    await createReceipt(db, ch.id, ch.sponsor_id, "charity_donation", ch.gross_amount_pence, {
      challengeId: ch.id, charityId: ch.charity_id, donatedPence: ch.gross_amount_pence,
    });

    await createNotification(db, ch.walker_id, "challenge_failed",
      "Challenge Expired",
      `Your challenge expired. £${pence2str(ch.gross_amount_pence)} has been donated to charity.`,
      { challengeId: ch.id });

    await createNotification(db, ch.sponsor_id, "challenge_failed",
      "Challenge Expired – Donated",
      `Walker didn't complete in time. £${pence2str(ch.gross_amount_pence)} donated to charity.`,
      { challengeId: ch.id });

  } else {
    // Refund gross amount
    await db.prepare(
      `INSERT INTO challenge_payments(id,challenge_id,type,amount_pence,status,created_at)
       VALUES(?,?,'refund',?,'completed',?)`
    ).bind(uuid(), ch.id, ch.gross_amount_pence, now).run();

    await db.prepare(
      `INSERT INTO walker_sponsor_stats(user_id,failed_challenge_count,active_challenge_count,current_pot_pence)
       VALUES(?,1,0,0)
       ON CONFLICT(user_id) DO UPDATE SET
         failed_challenge_count=failed_challenge_count+1,
         active_challenge_count=MAX(0,active_challenge_count-1),
         current_pot_pence=MAX(0,current_pot_pence-?)`
    ).bind(ch.walker_id, ch.gross_amount_pence).run();

    await db.prepare(
      `INSERT INTO sponsor_stats(user_id,total_refunded_pence,failures) VALUES(?,?,1)
       ON CONFLICT(user_id) DO UPDATE SET
         total_refunded_pence=total_refunded_pence+?,failures=failures+1`
    ).bind(ch.sponsor_id, ch.gross_amount_pence, ch.gross_amount_pence).run();

    await createReceipt(db, ch.id, ch.sponsor_id, "refund", ch.gross_amount_pence, {
      challengeId: ch.id, refundedPence: ch.gross_amount_pence,
    });

    await createNotification(db, ch.walker_id, "challenge_failed",
      "Challenge Expired", "Your challenge expired. The sponsor has been refunded.",
      { challengeId: ch.id });

    await createNotification(db, ch.sponsor_id, "challenge_failed",
      "Challenge Expired – Refunded",
      `Walker didn't complete in time. £${pence2str(ch.gross_amount_pence)} refunded.`,
      { challengeId: ch.id });
  }

  await logChallengeEvent(db, ch.id, "expired", null,
    { failureAction: ch.failure_action, grossAmountPence: ch.gross_amount_pence });
}
