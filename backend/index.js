// index.js - Full server
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

// ---- Config & env ----
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_SECRET_PATH = process.env.TELEGRAM_SECRET_PATH || '';
const ADMIN_ID = process.env.ADMIN_ID || null;
const BROADCAST_DELAY_MS = parseInt(process.env.BROADCAST_DELAY_MS || '200', 10);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || null;
const RAW_FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const FRONTEND_ORIGIN = RAW_FRONTEND_ORIGIN.replace(/\/$/, '');
const BOT_USERNAME_FALLBACK = process.env.BOT_USERNAME || null; // optional env fallback

// sanity check env
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing Supabase env vars. Fill SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

// ---- Supabase server client ----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// ---- App init ----
const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin: ["http://localhost:5173", FRONTEND_ORIGIN].filter(Boolean),
  methods: "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
  credentials: true
}));
app.use(express.json());

// ---- Game constants ----
const BUSINESSES = [
  { id: 'DAPP', name: 'CIFCI Tech & AI', cost: 1000, income: 1 },
  { id: 'TOTO_VAULT', name: 'CIFCI Crypto & Blockchain', cost: 1000, income: 1 },
  { id: 'CIFCI_STABLE', name: 'CIFCI Real Estate', cost: 1000, income: 1 },
  { id: 'TYPOGRAM', name: 'CIFCI Energy', cost: 1000, income: 1 },
  { id: 'APPLE', name: 'CIFCI Infrastructure', cost: 1000, income: 1 },
  { id: 'BITCOIN', name: 'CIFCI Space & Exploration', cost: 1000, income: 1 },
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

function mapRowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    coins: (row.coins === null || row.coins === undefined) ? 0 : Number(row.coins),
    businesses: row.businesses ?? {},
    level: row.level ?? 1,
    lastMine: row.last_mine ?? 0,
    referralsCount: row.referrals_count ?? 0,
    referredBy: row.referred_by ?? null,
    subscribed: row.subscribed === null || row.subscribed === undefined ? true : !!row.subscribed,
    createdAt: row.created_at ?? null
  };
}

// ---- Helpers ----
function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Send a message via Bot API (simple, uses fetch)
async function sendTelegram(chat, textMsg, opts = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN missing, cannot send message');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chat, text: textMsg, ...opts };
    if (payload.reply_markup && typeof payload.reply_markup !== 'string') {
      payload.reply_markup = JSON.stringify(payload.reply_markup);
    }
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn('Failed to send telegram message', e?.message || e);
  }
}

// get bot username (cached)
let _cachedBotUsername = null;
async function getBotUsername() {
  if (_cachedBotUsername) return _cachedBotUsername;
  if (BOT_USERNAME_FALLBACK) {
    _cachedBotUsername = BOT_USERNAME_FALLBACK;
    return _cachedBotUsername;
  }
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
    const json = await resp.json();
    if (json?.ok && json.result?.username) {
      _cachedBotUsername = json.result.username;
      return _cachedBotUsername;
    }
  } catch (e) {
    console.warn('getBotUsername failed', e?.message || e);
  }
  return null;
}

// ---- RPC helper: manual_refer_by_id with defensive logging + id normalization ----
async function callManualRefer(referrerId, referredId, referredUsername) {
  try {
    const normReferrerId = (typeof referrerId === 'string' && /^\d+$/.test(referrerId)) ? Number(referrerId) : referrerId;
    const normReferredId = (typeof referredId === 'string' && /^\d+$/.test(referredId)) ? Number(referredId) : referredId;

    const { data, error } = await supabase.rpc('manual_refer_by_id', {
      referrer_id: normReferrerId,
      referred_id: normReferredId,
      referred_username: referredUsername
    });

    if (error) {
      console.error('manual_refer_by_id rpc error object:', error);
      return { ok: false, error };
    }

    const rpcResult = Array.isArray(data) ? data[0] : data;
    if (!rpcResult || typeof rpcResult.success === 'undefined') {
      console.error('manual_refer_by_id unexpected rpc result:', { data });
      return { ok: false, error: new Error('invalid_rpc_result'), data };
    }

    return { ok: true, result: rpcResult };
  } catch (e) {
    console.error('manual_refer_by_id call failed:', e);
    return { ok: false, error: e };
  }
}

// robust finding of a user by username or id (case-insensitive on username)
async function findUserByUsernameOrId(target) {
  if (!target) return null;
  const cleaned = target.replace(/^@/, '').trim();

  // 1) exact match
  try {
    const { data: exactRows, error: exactErr } = await supabase
      .from('users')
      .select('id, username')
      .eq('username', cleaned)
      .limit(1);
    if (exactErr) throw exactErr;
    if (exactRows && exactRows.length > 0) return exactRows[0];
  } catch (e) {
    console.warn('findUser exact match failed', e?.message || e);
  }

  // 2) ilike
  try {
    const { data: ilikeRows, error: ilikeErr } = await supabase
      .from('users')
      .select('id, username')
      .ilike('username', cleaned)
      .limit(1);
    if (ilikeErr) throw ilikeErr;
    if (ilikeRows && ilikeRows.length > 0) return ilikeRows[0];
  } catch (e) {
    console.warn('findUser ilike match failed', e?.message || e);
  }

  // 3) id match if numeric
  if (/^\d+$/.test(cleaned)) {
    try {
      const { data: idRows, error: idErr } = await supabase
        .from('users')
        .select('id, username')
        .eq('id', cleaned)
        .limit(1);
      if (idErr) throw idErr;
      if (idRows && idRows.length > 0) return idRows[0];
    } catch (e) {
      console.warn('findUser id match failed', e?.message || e);
    }
  }

  return null;
}

// ---- API routes (user, mine, update, leaderboard, buy) ----
app.post('/api/user-debug', (req, res) => {
  console.log('DEBUG /api/user-debug body:', req.body);
  res.json({ body: req.body });
});

/**
 * POST /api/user
 * Body: { id, username }
 */
app.post('/api/user', async (req, res) => {
  try {
    const { id, username } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { data: existing, error: selectErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (selectErr) throw selectErr;

    if (existing) return res.json({ user: mapRowToUser(existing) });

    const newUser = {
      id,
      username: username || `user_${id}`,
      coins: 100,
      businesses: {},
      level: 1,
      last_mine: 0,
      referrals_count: 0,
      referred_by: null,
      subscribed: true, // default to true
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

    const earned = Math.floor(Math.random() * 3) + 1; // 1-3 coins (adjust)
    const passive = calculatePassiveIncome(data.businesses || {});
    const newCoins = (Number(data.coins) || 0) + earned + passive;

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
 * POST /api/buy
 * Body: { id, business, qty, unitCost }
 */
app.post('/api/buy', async (req, res) => {
  try {
    const { id, business, qty, unitCost } = req.body;
    if (!id || !business || !qty) return res.status(400).json({ error: 'id, business and qty required' });

    const qtyInt = parseInt(qty, 10);
    if (isNaN(qtyInt) || qtyInt <= 0) return res.status(400).json({ error: 'invalid qty' });

    const unitCostNum = unitCost !== undefined ? Number(unitCost) : null;
    if (unitCostNum === null || isNaN(unitCostNum) || unitCostNum < 0) {
      return res.status(400).json({ error: 'unitCost required and must be non-negative' });
    }

    const { data, error } = await supabase.rpc('purchase_business', {
      p_business: business,
      p_user_id: id,
      p_qty: qtyInt,
      p_unit_cost: unitCostNum
    });

    if (error) {
      console.error('purchase_business rpc error', error);
      return res.status(500).json({ error: error.message || 'purchase failed' });
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (!result || result.success !== true) {
      return res.status(400).json({ ok: false, result });
    }

    return res.json({ ok: true, result });
  } catch (err) {
    console.error('/api/buy', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * GET /api/leaderboard
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

/**
 * GET /api/network-stats
 * Returns total coins, coins 24h ago, active miners
 */
app.get('/api/network-stats', async (req, res) => {
  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 1. Total coins now
    const { data: allUsers, error: errNow } = await supabase
      .from('users')
      .select('id, coins');
    if (errNow) throw errNow;

    const totalCoins = allUsers.reduce((sum, u) => sum + (u.coins || 0), 0);
    const activeMiners = allUsers.length;

    // 2. Coins 24h ago
    // Supabase doesn't store historical coins, so we calculate using created_at + last_mine
    // We'll estimate coins 24h ago as sum of users whose createdAt <= yesterday
    const { data: oldUsers, error: errOld } = await supabase
      .from('users')
      .select('id, coins, created_at')
      .lte('created_at', yesterday.toISOString());
    if (errOld) throw errOld;

    // naive approximation: subtract coins mined in last 24h (optional: depends on your DB schema)
    const coins24hAgo = oldUsers.reduce((sum, u) => sum + (u.coins || 0), 0);

    return res.json({
      totalCoins,
      coins24hAgo,
      activeMiners
    });
  } catch (err) {
    console.error('/api/network-stats', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});


// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Telegram webhook handler ----
app.post(`/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.sendStatus(204);

    console.log('telegram webhook body:', JSON.stringify(body));

    const msg = body.message || body.edited_message || body.callback_query?.message;
    if (!msg) return res.sendStatus(204);

    const callbackQuery = body.callback_query;
    const callbackData = callbackQuery?.data;
    const text = (msg.text || '').trim();
    const from = msg.from || callbackQuery?.from || {};
    const tgId = from.id?.toString();
    const username = from.username || `${from.first_name || 'tg'}_${tgId}`;
    const chatId = msg.chat?.id?.toString() || tgId;

    // ---------- Broadcast preview & callbacks ----------
    if (text && text.startsWith('/broadcast_preview ')) {
      if (!ADMIN_ID || String(chatId) !== String(ADMIN_ID)) {
        await sendTelegram(chatId, '⛔ Not authorized.');
        return res.json({ ok: false });
      }
      const messageText = text.replace('/broadcast_preview ', '').trim();
      if (!messageText) {
        await sendTelegram(chatId, 'Usage: /broadcast_preview <message>');
        return res.json({ ok: false });
      }
      const payload = Buffer.from(messageText, 'utf8').toString('base64');
      await sendTelegram(chatId, `🔎 Broadcast Preview:\n\n${messageText}`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: 'Send ✅', callback_data: `bcast_send:${payload}` },
            { text: 'Cancel ❌', callback_data: 'bcast_cancel' }
          ]]
        }
      });
      return res.json({ ok: true });
    }

    // callback_query processing (Send/Cancel)
    if (callbackQuery && callbackData) {
      // Only admin may trigger send
      if (!ADMIN_ID || String(callbackQuery.from?.id) !== String(ADMIN_ID)) {
        try {
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQuery.id, text: 'Not authorized.' })
          });
        } catch (e) {}
        return res.json({ ok: false });
      }

      if (callbackData === 'bcast_cancel') {
        try {
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQuery.id, text: 'Broadcast cancelled.' })
          });
        } catch (e) {}
        return res.json({ ok: true });
      }

      if (callbackData.startsWith('bcast_send:')) {
        const b64 = callbackData.split(':')[1] || '';
        let messageText = '';
        try { messageText = Buffer.from(b64, 'base64').toString('utf8'); } catch(e) { messageText = ''; }

        if (!messageText) {
          try {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: callbackQuery.id, text: 'Empty message, cancelled.' })
            });
          } catch(e) {}
          return res.json({ ok: false });
        }

        // ack
        try {
          await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQuery.id, text: 'Broadcasting to subscribers...' })
          });
        } catch (e){}

        // Fetch subscribers and broadcast
        try {
          const { data: users, error: usersErr } = await supabase
            .from('users')
            .select('id')
            .eq('subscribed', true);

          if (usersErr) throw usersErr;

          let sent = 0;
          for (const u of users || []) {
            try {
              await sendTelegram(u.id, escapeHtml(messageText), { parse_mode: 'HTML' });
              sent++;
            } catch (e) {}
            await sleep(BROADCAST_DELAY_MS);
          }

          if (CHANNEL_USERNAME) {
            try { await sendTelegram(CHANNEL_USERNAME, escapeHtml(messageText), { parse_mode: 'HTML' }); } catch(e){}
          }

          await sendTelegram(callbackQuery.from.id, `✅ Broadcast done. Sent to ${sent}/${users.length} subscribed users.`);
          return res.json({ ok: true });
        } catch (err) {
          console.error('broadcast (callback) error:', err);
          try { await sendTelegram(callbackQuery.from.id, '❌ Broadcast failed. Check logs.'); } catch(e){}
          return res.json({ ok: false, error: err?.message || err });
        }
      }
    }

    // /broadcast direct (no preview)
    if (text && text.startsWith('/broadcast ')) {
      if (!ADMIN_ID || String(chatId) !== String(ADMIN_ID)) {
        await sendTelegram(chatId, '⛔ Not authorized.');
        return res.json({ ok: false });
      }
      const messageText = text.replace('/broadcast ', '').trim();
      if (!messageText) {
        await sendTelegram(chatId, 'Usage: /broadcast <message>');
        return res.json({ ok: false });
      }

      try {
        const { data: users, error: usersErr } = await supabase
          .from('users')
          .select('id')
          .eq('subscribed', true);

        if (usersErr) throw usersErr;

        await sendTelegram(chatId, `📢 Broadcasting to ${users.length} subscribed users...`);

        let sent = 0;
        for (const u of users || []) {
          try {
            await sendTelegram(u.id, escapeHtml(messageText), { parse_mode: 'HTML' });
            sent++;
          } catch (err) {}
          await sleep(BROADCAST_DELAY_MS);
        }

        if (CHANNEL_USERNAME) {
          try { await sendTelegram(CHANNEL_USERNAME, escapeHtml(messageText), { parse_mode: 'HTML' }); } catch(e) {}
        }

        await sendTelegram(chatId, `✅ Broadcast done. Sent to ${sent}/${users.length} subscribed users.`);
        return res.json({ ok: true });
      } catch (err) {
        console.error('broadcast error:', err);
        await sendTelegram(chatId, '❌ Broadcast failed. Check logs.');
        return res.json({ ok: false, error: err?.message || err });
      }
    }

    // ---------- Refer / start flows ----------
    // /refer or "Refer 🎁"
    if (text && (text.startsWith('/refer') || text === 'Refer 🎁')) {
      // /refer (no args) -> return referral link
      if (!(text.startsWith('/refer ') || /^\/refer@/i.test(text))) {
        let botUsername = await getBotUsername();
        const referralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${chatId}` : `https://t.me/${BOT_USERNAME_FALLBACK || 'your_bot_username'}?start=ref_${chatId}`;
        await sendTelegram(chatId, `🎁 <b>Your Referral Link</b>\nInvite your friends and earn <b>100 coins</b> per referral!\n\n🔗 ${referralLink}`, { parse_mode: 'HTML' });
        return res.json({ ok: true });
      }

      // /refer <username> -> find inviter by username then call manual_refer_by_id
      const parts = text.split(/\s+/);
      const targetUsername = parts[1]?.replace('@', '')?.trim();
      if (!targetUsername) {
        await sendTelegram(chatId, '❌ Please provide the inviter username. Example: /refer SomeUser');
        return res.json({ ok: true });
      }

      try {
        // If the clicking user already exists -> inform and stop (do NOT call RPC)
        try {
          const { data: existingUser, error: existingErr } = await supabase
            .from('users')
            .select('id')
            .eq('id', tgId)
            .maybeSingle();

          if (existingErr) {
            console.warn('Error checking existing user before referral:', existingErr);
          } else if (existingUser) {
            await sendTelegram(chatId, '👋 You are already registered. Referrals apply only to new users.');
            return res.json({ ok: true });
          }
        } catch (e) {
          console.warn('Check user existence failed (refer cmd):', e?.message || e);
        }

        // find inviter by username or id
        const inviter = await findUserByUsernameOrId(targetUsername);

        if (!inviter) {
          await sendTelegram(chatId, '❌ Inviter not found in database.');
          return res.json({ ok: false });
        }

        // Call RPC (function handles creation and idempotency)
        const { ok, result, error } = await callManualRefer(inviter.id, tgId, username);
        if (!ok) {
          console.error('callManualRefer failed', error);
          await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          return res.json({ ok: false, error });
        }

        if (result.success === true) {
          await sendTelegram(chatId, `🎁 You were successfully referred by <b>${result.inviter_username || inviter.username || targetUsername}</b>!`, { parse_mode: 'HTML' });
          try { if (result.inviter_id && result.awarded) await sendTelegram(result.inviter_id, `🎉 <b>${escapeHtml(username)}</b> joined using your referral!\nYou received +100 💰 coins.`, { parse_mode: 'HTML' }); } catch(e){}
          return res.json({ ok: true, result });
        } else {
          const errCode = result.error || 'unknown';
          if (errCode === 'inviter_not_found') await sendTelegram(chatId, '❌ Inviter not found in database.');
          else if (errCode === 'self_referral') await sendTelegram(chatId, '😅 You can’t refer yourself!');
          else if (errCode === 'already_referred') await sendTelegram(chatId, "⚠️ You have already been referred or referral couldn't be recorded.");
          else if (errCode === 'already_user') await sendTelegram(chatId, '👋 You already joined earlier.');
          else await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          return res.json({ ok: false, error: errCode });
        }
      } catch (err) {
        console.error('Referral error (refer command):', err);
        await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
        return res.json({ ok: false, error: err?.message || err });
      }
    }

    // /start ref_<id> handling - critical path
    if (text && text.startsWith('/start')) {
      const parts = text.split(/\s+/);
      if (parts[1] && parts[1].startsWith('ref_')) {
        const referrerIdRaw = parts[1].replace('ref_', '').trim();

        if (!tgId) {
          return res.json({ ok: false, error: 'no tg id' });
        }

        // Check if clicking user already exists -> send friendly welcome and stop (do NOT call RPC)
        try {
          const { data: existingUser, error: existingErr } = await supabase
            .from('users')
            .select('id')
            .eq('id', tgId)
            .maybeSingle();

          if (existingErr) {
            console.warn('Error checking existing user before referral (start):', existingErr);
          } else if (existingUser) {
            await sendTelegram(chatId, '👋 Welcome back! You are already registered.');
            return res.json({ ok: true });
          }
        } catch (e) {
          console.warn('Check user existence failed (start ref):', e?.message || e);
        }

        try {
          // Call RPC (function handles creation and idempotency)
          const { ok, result, error } = await callManualRefer(referrerIdRaw, tgId, username);
          if (!ok) {
            console.error('callManualRefer failed', error);
            await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
            return res.json({ ok: false, error });
          }

          if (result.success === true) {
            await sendTelegram(chatId, `🎁 You were successfully referred by <b>${result.inviter_username || referrerIdRaw}</b>!`, { parse_mode: 'HTML' });
            try { if (result.inviter_id && result.awarded) await sendTelegram(result.inviter_id, `🎉 <b>${escapeHtml(username)}</b> joined using your referral!\nYou received +100 💰 coins.`, { parse_mode: 'HTML' }); } catch (e) {}
            return res.json({ ok: true, result });
          } else {
            const errCode = result.error || 'unknown';
            if (errCode === 'inviter_not_found') await sendTelegram(chatId, '❌ Inviter not found in database.');
            else if (errCode === 'self_referral') await sendTelegram(chatId, '😅 You can’t refer yourself!');
            else if (errCode === 'already_referred') await sendTelegram(chatId, "⚠️ You have already been referred or referral couldn't be recorded.");
            else if (errCode === 'already_user') await sendTelegram(chatId, '👋 You already joined earlier.');
            else await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
            return res.json({ ok: false, error: errCode });
          }
        } catch (err) {
          console.error('manual_refer_by_id call failed (start):', err);
          await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          return res.json({ ok: false, error: err?.message || err });
        }
      } else {
        // plain /start -> ensure user exists (safe insert-if-not-exists)
        if (tgId) {
          try {
            // check first
            const { data: existingUser } = await supabase
              .from('users')
              .select('id')
              .eq('id', tgId)
              .maybeSingle();

            if (!existingUser) {
              try {
                await supabase.from('users').insert([{
                  id: tgId,
                  username,
                  coins: 100,
                  businesses: {},
                  level: 1,
                  last_mine: 0,
                  referrals_count: 0,
                  referred_by: null,
                  subscribed: true
                }]);
              } catch (e) {
                // Insert might fail if another process created the user concurrently — that's okay
                console.warn('create user on plain /start failed (insert)', e?.message || e);
              }
            } else {
              // existing user — do nothing
            }
          } catch (e) {
            console.warn('create user on plain /start failed (check/insert)', e?.message || e);
          }
        }
        // Always respond OK for /start plain
        return res.json({ ok: true });
      }
    }

    // nothing else handled
    return res.json({ ok: true });
  } catch (err) {
    console.error('telegram webhook error', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
