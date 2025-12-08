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

/**
 * Telegram webhook (optional) - handle /start referrals
 * Set webhook to: https://<your-backend>/telegram/webhook or with TELEGRAM_SECRET_PATH
 */
// replace your existing telegram webhook handler with this block
app.post(`/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.sendStatus(204);

    const msg = body.message || body.edited_message;
    if (!msg) return res.sendStatus(204);

    const text = (msg.text || '').trim();
    const from = msg.from || {};
    const tgId = from.id?.toString();

    // Safety: log the incoming update minimally for debugging (remove or reduce in prod)
    console.log('telegram webhook update:', { text: text?.slice(0,80), fromId: tgId, username: from.username });

    if (text && text.startsWith('/start')) {
      const parts = text.split(' ');
      const param = parts[1] || null;

      // If start has a ref param like "ref_123"
      if (param && param.startsWith('ref_')) {
        const referrerId = param.replace('ref_', '');
        if (!tgId) {
          console.warn('telegram webhook: new user has no tg id, ignoring referral logic');
          return res.json({ ok: true });
        }

        const username = from.username || `${from.first_name || 'tg'}_${tgId}`;

        // 1) Check if this telegram user already exists
        const { data: existing, error: checkErr } = await supabase
          .from('users')
          .select('id')
          .eq('id', tgId)
          .maybeSingle();

        if (checkErr) {
          console.error('telegram webhook: error checking existing user', checkErr);
          return res.status(500).json({ error: 'db check failed' });
        }

        // If user doesn't exist, create + increment referrer
        if (!existing) {
          console.log(`telegram webhook: creating new user ${tgId}, referred by ${referrerId}`);
          const insertResp = await supabase.from('users').insert([{
            id: tgId,
            username,
            coins: 100,
            businesses: {},
            level: 1,
            last_mine: 0,
            referrals_count: 0,
            referred_by: referrerId,
            subscribed: false
          }]);

          if (insertResp.error) {
            console.error('telegram webhook: error inserting new user', insertResp.error);
            // allow continuing so caller sees we attempted insert
          } else {
            console.log('telegram webhook: inserted new user', insertResp.data?.[0]?.id);
          }

          // 2) Try RPC that returns new referral count
          try {
            const { data: rpcData, error: rpcErr } = await supabase.rpc('increment_referral_bonus', { ref_id: referrerId });

            if (rpcErr) {
              console.warn('telegram webhook: increment_referral_bonus RPC failed', rpcErr);
              // fallback to client-side update attempt (non-RPC) below
            } else {
              // rpcData should be an integer new count (or -1)
              console.log('telegram webhook: rpc increment result', rpcData);
              if (rpcData === -1) {
                console.warn('telegram webhook: rpc returned -1 -> referrer not found', { referrerId });
              }
              return res.json({ ok: true, rpcResult: rpcData });
            }
          } catch (rpcCatchErr) {
            console.warn('telegram webhook: rpc threw', rpcCatchErr);
          }

          // 3) Fallback: try to directly update the referrer's row using server key client
          try {
            const { data: uData, error: uErr } = await supabase
              .from('users')
              .update({
                referrals_count: supabase.raw || undefined, // placeholder for clarity
              })
              .eq('id', referrerId)
              .select('referrals_count, coins')
              .single();

            // Note: supabase-js doesn't have a direct "referrals_count = referrals_count + 1" helper.
            // If the RPC failed, we do a simple safe read+update (not perfectly atomic) as last resort:
            if (uErr) {
              // Fallback read + update (we try to be explicit and log errors)
              console.log('telegram webhook: fallback read & update for referrer', referrerId);
              const { data: refRow, error: refErr } = await supabase
                .from('users')
                .select('referrals_count, coins')
                .eq('id', referrerId)
                .maybeSingle();

              if (refErr) {
                console.error('telegram webhook: fallback read error', refErr);
              } else if (!refRow) {
                console.warn('telegram webhook: fallback read found no referrer row', referrerId);
              } else {
                const newCount = (refRow.referrals_count || 0) + 1;
                const newCoins = (refRow.coins || 0) + 100;
                const { error: finalUpdErr } = await supabase
                  .from('users')
                  .update({ referrals_count: newCount, coins: newCoins })
                  .eq('id', referrerId);
                if (finalUpdErr) {
                  console.error('telegram webhook: fallback final update failed', finalUpdErr);
                } else {
                  console.log('telegram webhook: fallback final update succeeded', { referrerId, newCount });
                }
              }
            } else {
              // if uData exists (rare), log it
              console.log('telegram webhook: direct update returned', uData);
            }
          } catch (fallbackErr) {
            console.error('telegram webhook: fallback update error', fallbackErr);
          }

        } else {
          console.log('telegram webhook: user already existed, ignoring creation+referral increment', { tgId });
        }
      } else {
        // normal /start without referral
        if (tgId) {
          const username = from.username || `${from.first_name || 'tg'}_${tgId}`;
          const { data: existing, error: checkErr } = await supabase
            .from('users')
            .select('id')
            .eq('id', tgId)
            .maybeSingle();

          if (checkErr) {
            console.error('telegram webhook: error checking existing user (no-ref)', checkErr);
            return res.status(500).json({ error: 'db check failed' });
          }
          if (!existing) {
            console.log('telegram webhook: creating user without ref', tgId);
            const { error: insErr } = await supabase.from('users').insert([{
              id: tgId,
              username,
              coins: 100,
              businesses: {},
              level: 1,
              last_mine: 0,
              referrals_count: 0,
              referred_by: null,
              subscribed: false
            }]);
            if (insErr) console.error('telegram webhook: insert (no-ref) failed', insErr);
          }
        }
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('telegram webhook error', err);
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

// POST /api/referral/test
// Body: { referrerId }
app.post('/api/referral/test', async (req, res) => {
  try {
    const { referrerId } = req.body;
    if (!referrerId) return res.status(400).json({ error: 'referrerId required' });

    // call RPC
    const { data, error } = await supabase.rpc('increment_referral_bonus', { ref_id: referrerId });
    if (error) {
      console.error('referral test rpc error', error);
      return res.status(500).json({ error: error.message || 'rpc error' });
    }
    return res.json({ newReferralsCount: data });
  } catch (err) {
    console.error('/api/referral/test error', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});


// Health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
