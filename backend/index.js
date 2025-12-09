// index.js
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

// Normalize FRONTEND_ORIGIN
const RAW_FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const FRONTEND_ORIGIN = RAW_FRONTEND_ORIGIN.replace(/\/$/, '');

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    const allowed = [FRONTEND_ORIGIN, 'http://localhost:5173'].filter(Boolean);
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (!origin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      res.setHeader('Access-Control-Allow-Origin', 'null');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    return res.sendStatus(200);
  }
  next();
});

app.use(cors({
  origin: ["http://localhost:5173", FRONTEND_ORIGIN].filter(Boolean),
  methods: "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
  credentials: true
}));
app.options('*', cors());
app.use(express.json());

// env
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // must be service_role key for writes/RPC
const TELEGRAM_SECRET_PATH = process.env.TELEGRAM_SECRET_PATH || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY (service_role).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// Game constants
const BUSINESSES = [
  { id: 'DAPP', name: 'DAPP', cost: 1000, income: 1 },
  { id: 'TOTO_VAULT', name: 'TOTO VAULT', cost: 1000, income: 1 },
  { id: 'CIFCI_STABLE', name: 'CIFCI STABLE COIN', cost: 1000, income: 1 },
  { id: 'TYPOGRAM', name: 'TYPOGRAM', cost: 1000, income: 1 },
  { id: 'APPLE', name: 'APPLE', cost: 1000, income: 1 },
  { id: 'BITCOIN', name: 'BITCOIN', cost: 1000, income: 1 },
];

const MINE_COOLDOWN_MS = 60_000;

function calculatePassiveIncome(businesses = {}) {
  let total = 0;
  for (const [id, qty] of Object.entries(businesses || {})) {
    const b = BUSINESSES.find(x => x.id === id);
    if (b) total += (b.income || 0) * (qty || 0);
  }
  return total;
}

function mapRowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    coins: row.coins ?? 0,
    businesses: row.businesses ?? {},
    level: row.level ?? 1,
    lastMine: row.last_mine ?? 0,
    referralsCount: row.referrals_count ?? 0,
    referredBy: row.referred_by ?? null,
    subscribed: row.subscribed ?? false,
    createdAt: row.created_at ?? null
  };
}

/**
 * applyReferralBonus(referrerId, referredId)
 * - idempotent via public.referrals
 * - prefer RPC increment_referral_bonus, fallback to JS update
 * - returns { ok: boolean, method?: 'rpc'|'fallback-update', debug: {...} }
 */
async function applyReferralBonus(referrerId, referredId) {
  const debug = { startedAt: new Date().toISOString(), referrerId, referredId };

  if (!referrerId) {
    debug.reason = 'no-referrer-provided';
    console.warn('applyReferralBonus:', debug);
    return { ok: false, debug };
  }
  if (!referredId) {
    debug.reason = 'no-referred-id';
    console.warn('applyReferralBonus:', debug);
    return { ok: false, debug };
  }

  try {
    // 1) Insert into referrals table to ensure idempotency (duplicate -> do nothing)
    const { error: insertErr } = await supabase
      .from('referrals')
      .insert([{ referrer_id: referrerId, referred_id: referredId }]);

    if (insertErr) {
      // detect duplicate (code may vary); treat as already-applied
      const isDuplicate = insertErr.code === '23505' ||
                          (insertErr?.message && insertErr.message.toLowerCase().includes('duplicate')) ||
                          (insertErr?.details && insertErr.details.toLowerCase().includes('duplicate'));
      if (isDuplicate) {
        debug.reason = 'already-applied';
        console.log('applyReferralBonus: already applied', debug);
        return { ok: false, debug };
      }
      debug.insertError = insertErr;
      console.error('applyReferralBonus: referrals insert failed', debug);
      return { ok: false, debug };
    }

    // 2) Fetch referrer row
    const { data: refRow, error: selErr } = await supabase
      .from('users')
      .select('id, coins, referrals_count')
      .eq('id', referrerId)
      .maybeSingle();

    debug.fetchedRefRow = refRow ?? null;
    if (selErr || !refRow) {
      debug.reason = selErr ? (selErr.message || selErr) : 'referrer-not-found';
      console.warn('applyReferralBonus: referrer fetch failed', debug);
      return { ok: false, debug };
    }

    // 3) Try RPC first
    try {
      const rpcStart = Date.now();
      const rpcRes = await supabase.rpc('increment_referral_bonus', { ref_id: referrerId });
      debug.rpc = { elapsedMs: Date.now() - rpcStart, result: rpcRes ?? null };
      // supabase RPC may return an object with an `error` property (PostgREST style)
      if (rpcRes && rpcRes.error) {
        debug.rpcError = rpcRes.error;
        console.warn('applyReferralBonus: rpc returned error object, falling back', debug);
      } else {
        console.log('applyReferralBonus: RPC succeeded', debug);
        return { ok: true, method: 'rpc', debug };
      }
    } catch (rpcErr) {
      debug.rpcError = rpcErr?.message || rpcErr;
      console.warn('applyReferralBonus: rpc threw, falling back', debug);
    }

    // 4) Fallback JS update
    const currentCoins = Number(refRow.coins || 0);
    const currentCount = Number(refRow.referrals_count || 0);
    const newCoins = currentCoins + 100;
    const newCount = currentCount + 1;

    const { error: updErr } = await supabase
      .from('users')
      .update({ coins: newCoins, referrals_count: newCount })
      .eq('id', referrerId);

    if (updErr) {
      debug.fallbackError = updErr;
      console.error('applyReferralBonus: fallback update failed', debug);
      return { ok: false, debug };
    }

    debug.fallback = { newCoins, newCount };
    console.log('applyReferralBonus: fallback update succeeded', debug);
    return { ok: true, method: 'fallback-update', debug };

  } catch (err) {
    debug.unexpectedError = err?.message || err;
    console.error('applyReferralBonus: unexpected', debug);
    return { ok: false, debug };
  }
}

/**
 * POST /api/user
 * - body: { id, username, referredBy? }
 * - creates user if missing
 * - if referredBy provided, credits the referrer (idempotent)
 */
app.post('/api/user', async (req, res) => {
  try {
    const { id, username, referredBy } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    // 1) Check existing user
    const { data: existing, error: selectErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (selectErr) {
      console.error('/api/user select err', selectErr);
      return res.status(500).json({ error: selectErr.message || 'db error' });
    }

    if (existing) {
      // Return user; do NOT change referred_by or credit again for existing users
      return res.json({ user: mapRowToUser(existing) });
    }

    // 2) Prevent self-referral
    const safeReferredBy = referredBy && referredBy.toString() !== id.toString() ? referredBy.toString() : null;
    if (referredBy && !safeReferredBy) {
      console.warn('/api/user: attempted self-referral; ignoring referredBy');
    }

    // 3) Create new user (referred_by stored)
    const insertPayload = {
      id,
      username: username || `user_${id}`,
      coins: 100,
      businesses: {},
      level: 1,
      last_mine: 0,
      referrals_count: 0,
      referred_by: safeReferredBy,
      subscribed: false
    };

    const { data: created, error: insertErr } = await supabase
      .from('users')
      .insert([insertPayload])
      .select()
      .single();

    if (insertErr) {
      console.error('/api/user insert error', insertErr);
      return res.status(500).json({ error: insertErr.message || 'insert error' });
    }

    // 4) If referred, apply referral bonus (pass both ids)
    let applyResult = null;
    if (safeReferredBy) {
      applyResult = await applyReferralBonus(safeReferredBy, id);
      if (!applyResult.ok) {
        console.warn('/api/user: applyReferralBonus result', applyResult.debug);
      } else {
        console.log('/api/user: applyReferralBonus success', applyResult.debug);
      }
    }

    return res.json({
      user: mapRowToUser(created),
      debug: { referredBy: safeReferredBy, applyResult }
    });

  } catch (err) {
    console.error('/api/user error', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * GET /api/user/:id
 */
app.get('/api/user/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not found' });
    return res.json({ user: mapRowToUser(data) });
  } catch (err) {
    console.error('/api/user/:id', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * POST /api/user/update
 */
app.post('/api/user/update', async (req, res) => {
  try {
    const { id, coins, businesses, lastMine, level, subscribed } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const updatePayload = {};
    if (coins !== undefined) updatePayload.coins = coins;
    if (businesses !== undefined) updatePayload.businesses = businesses;
    if (lastMine !== undefined) updatePayload.last_mine = lastMine;
    if (level !== undefined) updatePayload.level = level;
    if (subscribed !== undefined) updatePayload.subscribed = subscribed;

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: 'no fields to update' });
    }

    const { error } = await supabase
      .from('users')
      .update(updatePayload)
      .eq('id', id);

    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/user/update', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * POST /api/mine
 */
app.post('/api/mine', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { data, error: selErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (selErr) throw selErr;
    if (!data) return res.status(404).json({ error: 'user not found' });

    const now = Date.now();
    const lastMine = data.last_mine || 0;
    const diff = now - lastMine;
    if (diff < MINE_COOLDOWN_MS) {
      const retryAfterMs = MINE_COOLDOWN_MS - diff;
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      return res.status(429).json({ error: 'cooldown', retryAfterMs });
    }

    const earned = Math.floor(Math.random() * 2) + 2;
    const passive = calculatePassiveIncome(data.businesses || {});
    const newCoins = (data.coins || 0) + earned + passive;

    const { error: updErr } = await supabase
      .from('users')
      .update({ coins: newCoins, last_mine: now })
      .eq('id', id);

    if (updErr) throw updErr;

    return res.json({ earned, passive, coins: newCoins, lastMine: now });
  } catch (err) {
    console.error('/api/mine', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * Telegram webhook: create TG user and apply referral if present
 * Set webhook to https://<your-backend>/telegram/webhook or include secret path via TELEGRAM_SECRET_PATH
 */
app.post(`/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.sendStatus(204);

    const msg = body.message || body.edited_message;
    if (!msg) return res.sendStatus(204);

    const text = (msg.text || '').trim();
    const from = msg.from || {};
    const tgId = from.id ? from.id.toString() : null;
    if (!tgId) return res.sendStatus(204);

    // If user started with referral (e.g., "/start ref_<referrerId>")
    let referrerId = null;
    if (text && text.startsWith('/start')) {
      const parts = text.split(' ').filter(Boolean);
      if (parts[1] && parts[1].startsWith('ref_')) {
        referrerId = parts[1].replace('ref_', '').trim();
      }
    }

    // Check if user exists
    const { data: existing, error: selErr } = await supabase
      .from('users')
      .select('id')
      .eq('id', tgId)
      .maybeSingle();

    if (selErr) {
      console.error('telegram webhook: select error', selErr);
      return res.status(200).json({ ok: false, error: selErr.message || 'db error' });
    }

    if (!existing) {
      // Prevent self-referral
      if (referrerId && referrerId === tgId) {
        console.warn('telegram webhook: self-referral attempt; ignoring referred id');
        referrerId = null;
      }

      const username = from.username || `${from.first_name || 'tg'}_${tgId}`;

      // If referred, you may want to give a small bonus to the new user; adjust as desired.
      const startingCoins = referrerId ? 150 : 100;

      const insertPayload = {
        id: tgId,
        username,
        coins: startingCoins,
        businesses: {},
        level: 1,
        last_mine: 0,
        referrals_count: 0,
        referred_by: referrerId || null,
        subscribed: false
      };

      // Insert new TG user
      try {
        await supabase.from('users').insert([insertPayload]);
      } catch (insertErr) {
        console.error('telegram webhook: insert failed', insertErr);
        return res.status(200).json({ ok: false, error: insertErr.message || 'insert error' });
      }

      // If there is a referrer, call applyReferralBonus(referrerId, tgId)
      if (referrerId) {
        const applied = await applyReferralBonus(referrerId, tgId);
        if (!applied.ok) {
          console.warn('telegram webhook: failed to apply referral bonus', applied.debug || applied);
        } else {
          console.log('telegram webhook: referral bonus applied', applied.debug || applied);
        }
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('telegram webhook', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * Leaderboard
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '20', 10) || 20);
    const { data, error } = await supabase
      .from('users')
      .select('id, username, coins, businesses, level')
      .order('coins', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.json({ users: data || [] });
  } catch (err) {
    console.error('/api/leaderboard', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

// Debug referral endpoint (accepts both query params)
app.get('/debug/referral', async (req, res) => {
  try {
    const referrerId = req.query.referrerId ? String(req.query.referrerId) : null;
    const referredId = req.query.referredId ? String(req.query.referredId) : null;
    const result = await applyReferralBonus(referrerId, referredId);
    return res.json({ ok: result.ok, result });
  } catch (err) {
    console.error('/debug/referral error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'server error' });
  }
});

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
