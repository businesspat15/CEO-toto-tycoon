// index.js
// Simple Express backend for CEO TOTO Tycoon
// - Handles user fetch/create
// - Mining endpoint with cooldown and passive income
// - Basic Telegram webhook for /start referrals
// - Uses Supabase server key for DB writes

import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

app.set("trust proxy", 1);

// Normalize FRONTEND_ORIGIN to avoid trailing slash mismatches
const RAW_FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const FRONTEND_ORIGIN = RAW_FRONTEND_ORIGIN.replace(/\/$/, ''); // e.g. "https://...vercel.app"

// EARLY OPTIONS / PRE-FLIGHT SHORT-CIRCUIT
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    // Allowed origins: frontend + localhost (dev)
    const allowed = [FRONTEND_ORIGIN, 'http://localhost:5173'].filter(Boolean);
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (!origin) {
      // requests without Origin (curl, server-to-server)
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      // origin not allowed — still respond to preflight but without allowing CORS
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

app.options("*", cors());

app.use(express.json());

// Environment variables (from .env)
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // server secret
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_SECRET_PATH = process.env.TELEGRAM_SECRET_PATH || ''; // optional for webhook path security

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing Supabase env vars. Fill SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

// Create Supabase server client with service role key (server-only)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// Game constants (match your frontend)
const BUSINESSES = [
  { id: 'DAPP', name: 'DAPP', cost: 1000, income: 1 },
  { id: 'TOTO_VAULT', name: 'TOTO VAULT', cost: 1000, income: 1 },
  { id: 'CIFCI_STABLE', name: 'CIFCI STABLE COIN', cost: 1000, income: 1 },
  { id: 'TYPOGRAM', name: 'TYPOGRAM', cost: 1000, income: 1 },
  { id: 'APPLE', name: 'APPLE', cost: 1000, income: 1 },
  { id: 'BITCOIN', name: 'BITCOIN', cost: 1000, income: 1 },
];

const MINE_COOLDOWN_MS = 60_000; // 1 minute

function calculatePassiveIncome(businesses = {}) {
  let total = 0;
  for (const [id, qty] of Object.entries(businesses || {})) {
    const b = BUSINESSES.find(x => x.id === id);
    if (b) total += (b.income || 0) * (qty || 0);
  }
  return total;
}

// Helper: map DB snake_case to API shape
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
app.post('/api/user-debug', (req, res) => {
  console.log('DEBUG /api/user-debug body:', req.body);
  res.json({ body: req.body });
});

/**
 * Helper: applyReferralBonus(referrerId)
 * - tries RPC increment_referral_bonus first
 * - falls back to a safe JS update if RPC missing/blocked
 */
async function applyReferralBonus(referrerId) {
  if (!referrerId) return { ok: false, reason: 'no-referrer' };

  try {
    // Ensure referrer exists and fetch current counts
    const { data: refRow, error: selErr } = await supabase
      .from('users')
      .select('id, referrals_count, coins')
      .eq('id', referrerId)
      .maybeSingle();

    if (selErr) {
      console.warn('applyReferralBonus: select error', selErr);
      return { ok: false, reason: 'select-error', error: selErr };
    }
    if (!refRow) {
      return { ok: false, reason: 'referrer-not-found' };
    }

    // Try RPC first (preferred)
    try {
      await supabase.rpc('increment_referral_bonus', { ref_id: referrerId });
      return { ok: true, method: 'rpc' };
    } catch (rpcErr) {
      // RPC failed -> fallback to update
      console.warn('applyReferralBonus: rpc failed, falling back to update', rpcErr?.message || rpcErr);

      // Parse coins safely (supabase may return string for bigint)
      const currentCoins = Number(refRow.coins || 0);
      const currentCount = Number(refRow.referrals_count || 0);
      const newCoins = currentCoins + 100;
      const newCount = currentCount + 1;

      const { error: updErr } = await supabase
        .from('users')
        .update({
          referrals_count: newCount,
          coins: newCoins
        })
        .eq('id', referrerId);

      if (updErr) {
        console.error('applyReferralBonus: fallback update failed', updErr);
        return { ok: false, reason: 'fallback-update-failed', error: updErr };
      }
      return { ok: true, method: 'fallback-update' };
    }
  } catch (err) {
    console.error('applyReferralBonus: unexpected error', err);
    return { ok: false, reason: 'unexpected', error: err };
  }
}

/**
 * POST /api/user
 * Body: { id, username, referredBy? }
 * Fetch existing user or create a new one. If referredBy provided, credit referrer.
 */
app.post('/api/user', async (req, res) => {
  try {
    const { id, username, referredBy } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    // 1) See if user already exists (do NOT overwrite referred_by on existing users)
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
      // user exists — return mapped user (no changes)
      return res.json({ user: mapRowToUser(existing) });
    }

    // Prevent self-referral
    let safeReferredBy = referredBy && referredBy.toString() !== id.toString() ? referredBy.toString() : null;
    if (referredBy && !safeReferredBy) {
      console.warn('/api/user: attempted self-referral or invalid referredBy; ignoring referredBy');
    }

    // Insert new user (do not use upsert to avoid accidentally overwriting older fields)
    const insertPayload = {
      id,
      username: username || `user_${id}`,
      coins: 100,
      businesses: {},
      level: 1,
      last_mine: 0,
      referrals_count: 0,
      referred_by: safeReferredBy,
      subscribed: false,
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

    // If referredBy was provided (and wasn't self-referral), try to credit the referrer
    if (safeReferredBy) {
      const applied = await applyReferralBonus(safeReferredBy);
      if (!applied.ok) {
        // log but don't fail creation
        console.warn('/api/user: failed to apply referral bonus', applied);
      }
    }

    return res.json({ user: mapRowToUser(created) });
  } catch (err) {
    console.error('/api/user error', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * GET /api/user/:id
 * Fetch a user by id
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
 * Body: { id, coins?, businesses?, lastMine?, level?, subscribed? }
 * Server-side update — uses Supabase service key
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
 * Body: { id }
 * Enforce cooldown, calculate earned + passive, update DB
 */
app.post('/api/mine', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    // fetch user
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
      // set Retry-After in seconds for clients
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      return res.status(429).json({ error: 'cooldown', retryAfterMs });
    }

    // Earn 2 or 3 coins + passive income
    const earned = Math.floor(Math.random() * 2) + 2;
    const passive = calculatePassiveIncome(data.businesses || {});
    const newCoins = (data.coins || 0) + earned + passive;

    // Update DB
    const { error: updErr } = await supabase
      .from('users')
      .update({
        coins: newCoins,
        last_mine: now
      })
      .eq('id', id);

    if (updErr) throw updErr;

    return res.json({
      earned,
      passive,
      coins: newCoins,
      lastMine: now
    });

  } catch (err) {
    console.error('/api/mine', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * Telegram webhook (optional) - handle /start referrals
 * Set webhook to: https://<your-backend>/telegram/webhook or with TELEGRAM_SECRET_PATH
 */
app.post(`/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.sendStatus(204);

    // Basic update handling
    const msg = body.message || body.edited_message;
    if (!msg) return res.sendStatus(204);

    const text = (msg.text || '').trim();
    const from = msg.from || {};
    const tgId = from.id ? from.id.toString() : null;
    if (!tgId) return res.sendStatus(204);

    // If user started with referral
    if (text && text.startsWith('/start')) {
      const parts = text.split(' ').filter(Boolean);
      let referrerId = null;
      if (parts[1] && parts[1].startsWith('ref_')) {
        referrerId = parts[1].replace('ref_', '').trim();
      }

      // create the new user if not exists and increment referrer count
      const { data: existing, error: selErr } = await supabase
        .from('users')
        .select('id')
        .eq('id', tgId)
        .maybeSingle();

      if (selErr) {
        console.error('telegram webhook: select error', selErr);
        // return 200 so Telegram doesn't retry too aggressively
        return res.status(200).json({ ok: false, error: selErr.message || 'db error' });
      }

      if (!existing) {
        // Prevent self-referral
        if (referrerId && referrerId === tgId) {
          console.warn('telegram webhook: self-referral attempt; ignoring referred id');
          referrerId = null;
        }

        const username = from.username || `${from.first_name || 'tg'}_${tgId}`;
        const insertPayload = {
          id: tgId,
          username,
          coins: 100,
          businesses: {},
          level: 1,
          last_mine: 0,
          referrals_count: 0,
          referred_by: referrerId || null,
          subscribed: false
        };

        try {
          await supabase.from('users').insert([insertPayload]);
        } catch (insertErr) {
          console.error('telegram webhook: insert failed', insertErr);
          return res.status(200).json({ ok: false, error: insertErr.message || 'insert error' });
        }

        // Try to credit the referrer (best-effort)
        if (referrerId) {
          const applied = await applyReferralBonus(referrerId);
          if (!applied.ok) {
            console.warn('telegram webhook: failed to apply referral bonus', applied);
          }
        }
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('telegram webhook', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

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

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
