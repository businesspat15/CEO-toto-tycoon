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
 * POST /api/user
 * Body: { id, username }
 * Fetch existing user or create a new one.
 */
app.post('/api/user', async (req, res) => {
  try {
    const { id, username } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    // Try fetch
    const { data: existing, error: selectErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (selectErr) throw selectErr;

    if (existing) {
      return res.json({ user: mapRowToUser(existing) });
    }

    // Create new user
    const newUser = {
      id,
      username: username || `user_${id}`,
      coins: 100,
      businesses: {},
      level: 1,
      last_mine: 0,
      referrals_count: 0,
      referred_by: null,
      subscribed: false,
    };

    const { data: created, error: upsertErr } = await supabase
      .from('users')
      .upsert(newUser, { onConflict: 'id' })
      .select()
      .single();

    if (upsertErr) throw upsertErr;
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


app.post(
  `/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`,
  async (req, res) => {
    try {
      // Optional: verify Telegram secret token header if you set one during setWebhook
      if (process.env.TELEGRAM_SECRET_TOKEN) {
        const header = req.header('x-telegram-bot-api-secret-token');
        if (header !== process.env.TELEGRAM_SECRET_TOKEN) {
          console.warn('[telegram webhook] invalid secret token header');
          return res.sendStatus(401);
        }
      }

      console.log('[telegram webhook] headers:', req.headers);
      const rawBodyPreview = (() => {
        try {
          return typeof req.body === 'object'
            ? JSON.stringify(req.body).slice(0, 2000)
            : String(req.body).slice(0, 2000);
        } catch (e) {
          return '[unserializable body]';
        }
      })();
      console.log('[telegram webhook] raw body (preview):', rawBodyPreview);

      const body = req.body;
      if (!body) {
        console.log('[telegram webhook] empty body => 204');
        return res.sendStatus(204);
      }

      const msg = body.message || body.edited_message || body.callback_query?.message;
      if (!msg) {
        console.log('[telegram webhook] no message-like payload => 204');
        return res.sendStatus(204);
      }

      const from = msg.from || {};
      if (from.is_bot) {
        console.log('[telegram webhook] from is bot => ignore');
        return res.json({ ok: true });
      }

      const text = String(msg.text || '').trim();
      const tgId = from.id ? String(from.id) : null;

      console.log('[telegram webhook] text:', text, 'from:', tgId, 'username:', from.username);

      // handle /start with optional ref_
      if (text && text.startsWith('/start')) {
        const parts = text.split(/\s+/);
        const maybeRef = parts[1] || null;
        const referrerId = maybeRef && maybeRef.startsWith('ref_') ? maybeRef.replace(/^ref_/, '') : null;

        if (!tgId) {
          console.warn('[telegram webhook] missing tgId, cannot create user');
          return res.json({ ok: true });
        }

        const username = from.username || `${from.first_name || 'tg'}_${tgId}`;

        // CREATE user if not exists (non-fatal)
        try {
          const { data: existing, error: selectErr } = await supabase
            .from('users')
            .select('id')
            .eq('id', tgId)
            .maybeSingle();
          if (selectErr) {
            console.warn('[telegram webhook] select user error', selectErr);
          }

          if (!existing) {
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
            const { data: inserted, error: insertErr } = await supabase
              .from('users')
              .insert([insertPayload])
              .select()
              .single();

            if (insertErr) {
              console.warn('[telegram webhook] insert user error (may be duplicate)', insertErr?.message || insertErr);
            } else {
              console.log('[telegram webhook] user created:', inserted?.id);
            }
          } else {
            console.log('[telegram webhook] user exists', existing.id);
          }
        } catch (e) {
          console.warn('[telegram webhook] create user threw', e?.message || e);
        }

        // If we have a referrerId, call the new atomic RPC reward_referrer(referrer, referred)
        if (referrerId) {
          try {
            // Call RPC with both referrer and referred user ids (tgId)
            const { data: rpcData, error: rpcErr } = await supabase.rpc('reward_referrer', {
              p_referrer_id: referrerId,
              p_referred_user_id: tgId,
              p_coin_bonus: 100 // optional override
            });

            if (rpcErr) {
              console.warn('[telegram webhook] reward_referrer rpc error', rpcErr);
            } else if (!rpcData || rpcData.length === 0) {
              // No row returned: odd but handle gracefully
              console.warn('[telegram webhook] reward_referrer returned no rows', rpcData);
            } else {
              // Supabase returns an array of rows; take the first
              const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
              const rewarded = row.rewarded === true || row.rewarded === 't' || row.rewarded === 1;
              console.log(
                '[telegram webhook] reward_referrer result',
                { referrer: row.referrer_id, referrals_count: row.referrals_count, coins: row.coins, rewarded }
              );
              if (rewarded) {
                console.log('[telegram webhook] referrer rewarded for referred user', tgId);
              } else {
                console.log('[telegram webhook] referrer already had a reward record for', tgId);
              }
            }
          } catch (incErr) {
            console.warn('[telegram webhook] final error calling reward_referrer', incErr);
          }
        }

        return res.json({ ok: true });
      }

      // Not a /start or not referral — ignore
      return res.json({ ok: true });
    } catch (err) {
      console.error('[telegram webhook] handler error', err);
      return res.status(500).json({ error: err?.message || 'server error' });
    }
  }
);

/**
 * GET /api/leaderboard
 * Returns top players ordered by coins (desc).
 * Query params:
 *   ?limit=20   -> number of rows to return (default 20)
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



// Health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
