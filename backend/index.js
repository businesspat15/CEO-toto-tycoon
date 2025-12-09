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
// --- Replace existing telegram webhook handler with this block ---
app.post(`/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.sendStatus(204);

    const msg = body.message || body.edited_message;
    if (!msg) return res.sendStatus(204);

    const text = (msg.text || '').trim();
    const from = msg.from || {};
    const tgId = from.id?.toString();
    const username = from.username || `${from.first_name || 'tg'}_${tgId}`;
    const chatId = msg.chat?.id?.toString() || tgId;

    // helper to send Telegram messages via Bot API
    async function sendTelegram(chat, textMsg, opts = {}) {
      if (!TELEGRAM_BOT_TOKEN) return;
      try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const payload = {
          chat_id: chat,
          text: textMsg,
          ...opts
        };
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (e) {
        console.warn('Failed to send telegram message', e?.message || e);
      }
    }

    // Manual /refer flow (like your reference)
    if (text && (text.startsWith('/refer') || text === 'Refer 🎁')) {
      // case: "/refer" or "Refer 🎁" -> return referral link
      if (!(text.startsWith('/refer ') || /^\/refer@/i.test(text))) {
        // build referral link
        if (!TELEGRAM_BOT_TOKEN) {
          await sendTelegram(chatId, '🎁 Your referral link is temporarily unavailable (bot token missing).');
          return res.json({ ok: true });
        }
        // get bot username (quick call)
        let botUsername = null;
        try {
          const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
          const json = await resp.json();
          if (json?.ok) botUsername = json.result.username;
        } catch (e) { /* ignore */ }

        const referralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${chatId}` : `https://t.me/${chatId}?start=ref_${chatId}`;
        await sendTelegram(chatId,
          `🎁 <b>Your Referral Link</b>\nInvite your friends and earn <b>100 coins</b> per referral!\n\n🔗 ${referralLink}`,
          { parse_mode: 'HTML' }
        );
        return res.json({ ok: true });
      }

      // case: "/refer <username>"
      const parts = text.split(/\s+/);
      const targetUsername = parts[1]?.replace('@', '')?.trim();
      if (!targetUsername) {
        await sendTelegram(chatId, '❌ Please provide the inviter username. Example: /refer SomeUser');
        return res.json({ ok: true });
      }

      // call the atomic RPC we created in SQL: manual_refer(referrer_username, referred_id, referred_username)
      try {
        const { data: rpcData, error: rpcErr } = await supabase.rpc('manual_refer', {
          referrer_username: targetUsername,
          referred_id: tgId,
          referred_username: username
        });

        if (rpcErr) {
          console.error('manual_refer rpc error', rpcErr);
          await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          return res.json({ ok: false, error: rpcErr.message || rpcErr });
        }

        // rpcData may be an array or object depending on Supabase; normalize
        const rpcResult = Array.isArray(rpcData) ? rpcData[0] : rpcData;

        if (!rpcResult) {
          await sendTelegram(chatId, '⚠️ Referral result unknown. Try again later.');
          return res.json({ ok: false });
        }

        if (rpcResult.success === true || rpcResult.success === 't' || rpcResult.success === 'true') {
          // success - inform referred user
          await sendTelegram(chatId, `🎁 You were successfully referred by <b>${rpcResult.inviter_username || targetUsername}</b>!`, { parse_mode: 'HTML' });

          // Try to notify inviter (if inviter_id looks like a telegram chat id)
          try {
            if (rpcResult.inviter_id) {
              await sendTelegram(rpcResult.inviter_id, `🎉 <b>${username}</b> joined using your referral!\nYou received +100 💰 coins.`, { parse_mode: 'HTML' });
            }
          } catch (e) {
            // ignore if bot cannot message the inviter
          }

          return res.json({ ok: true });
        } else {
          // examine rpcResult.error codes to pick message
          const errCode = rpcResult.error || 'unknown';
          if (errCode === 'inviter_not_found') {
            await sendTelegram(chatId, '❌ Inviter not found in database.');
          } else if (errCode === 'self_referral') {
            await sendTelegram(chatId, '😅 You can’t refer yourself!');
          } else if (errCode === 'already_referred') {
            await sendTelegram(chatId, '⚠️ You have already been referred or the referral couldn\'t be recorded.');
          } else {
            await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          }
          return res.json({ ok: false, error: errCode });
        }
      } catch (err) {
        console.error('Referral error:', err);
        await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
        return res.json({ ok: false, error: err?.message || err });
      }
    } // end /refer flow

    // --- existing /start referral handler (keeps previous behavior) ---
    if (text && text.startsWith('/start')) {
      const parts = text.split(' ');
      if (parts[1] && parts[1].startsWith('ref_')) {
        const referrerId = parts[1].replace('ref_', '');
        if (tgId) {
          const usernameSafe = username;
          // create the new user if not exists and increment referrer count via RPC (optional)
          const { data: existing } = await supabase
            .from('users')
            .select('id')
            .eq('id', tgId)
            .maybeSingle();

          if (!existing) {
            await supabase.from('users').insert([{
              id: tgId,
              username: usernameSafe,
              coins: 100,
              businesses: {},
              level: 1,
              last_mine: 0,
              referrals_count: 0,
              referred_by: referrerId,
              subscribed: false
            }]);
          }

          // Try to increment referrer using your RPC if present (keeps previous behavior)
          try {
            await supabase.rpc('increment_referral_bonus', { ref_id: referrerId });
          } catch (rpcErr) {
            console.warn('increment_referral_bonus RPC failed', rpcErr?.message || rpcErr);
          }
        }
      } else {
        // normal start without referral: create user if not exists
        if (tgId) {
          const usernameSafe = username;
          const { data: existing } = await supabase
            .from('users')
            .select('id')
            .eq('id', tgId)
            .maybeSingle();

          if (!existing) {
            await supabase.from('users').insert([{
              id: tgId,
              username: usernameSafe,
              coins: 100,
              businesses: {},
              level: 1,
              last_mine: 0,
              referrals_count: 0,
              referred_by: null,
              subscribed: false
            }]);
          }
        }
      }

      return res.json({ ok: true });
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
