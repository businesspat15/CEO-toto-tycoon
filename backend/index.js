// index.js - Full server with referral, broadcast, purchase, mining, leaderboard
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

// CORS + preflight
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
    subscribed: row.subscribed ?? false,
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
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Send a message via Bot API (simple, uses fetch)
async function sendTelegram(chat, textMsg, opts = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN missing, cannot send message');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chat, text: textMsg, ...opts };
    // Telegram expects reply_markup as JSON string if provided
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

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Telegram webhook handler (referral, refer, broadcast preview/send, broadcast) ----
app.post(`/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.sendStatus(204);

    console.log('telegram webhook body:', JSON.stringify(body));

    // Support message or edited_message or callback_query
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
        } catch(e){}

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
    // /refer or /refer <username>
    if (text && (text.startsWith('/refer') || text === 'Refer 🎁')) {
      // /refer (no args) -> return referral link
      if (!(text.startsWith('/refer ') || /^\/refer@/i.test(text))) {
        // get bot username
        let botUsername = null;
        try {
          const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
          const json = await resp.json();
          if (json?.ok) botUsername = json.result.username;
        } catch (e) {}
        const referralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${chatId}` : `https://t.me/${chatId}?start=ref_${chatId}`;
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
        // find inviter id by username (case-insensitive)
        const { data: rows, error: findErr } = await supabase
          .from('users')
          .select('id, username')
          .ilike('username', targetUsername)
          .limit(1);

        if (findErr) throw findErr;
        if (!rows || rows.length === 0) {
          await sendTelegram(chatId, '❌ Inviter not found in database.');
          return res.json({ ok: false });
        }
        const inviter = rows[0];

        // call RPC by id
        const { data: rpcData, error: rpcErr } = await supabase.rpc('manual_refer_by_id', {
          referrer_id: inviter.id,
          referred_id: tgId,
          referred_username: username
        });

        if (rpcErr) {
          console.error('manual_refer_by_id rpc error (refer by username):', rpcErr);
          await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          return res.json({ ok: false, error: rpcErr.message || rpcErr });
        }

        const rpcResult = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        if (!rpcResult) {
          await sendTelegram(chatId, '⚠️ Referral error. Try again later.');
          return res.json({ ok: false });
        }

        if (rpcResult.success === true) {
          await sendTelegram(chatId, `🎁 You were successfully referred by <b>${rpcResult.inviter_username || targetUsername}</b>!`, { parse_mode: 'HTML' });
          try { if (rpcResult.inviter_id) await sendTelegram(rpcResult.inviter_id, `🎉 <b>${escapeHtml(username)}</b> joined using your referral!\nYou received +100 💰 coins.`, { parse_mode: 'HTML' }); } catch(e){}
          return res.json({ ok: true });
        } else {
          const errCode = rpcResult.error || 'unknown';
          if (errCode === 'inviter_not_found') await sendTelegram(chatId, '❌ Inviter not found in database.');
          else if (errCode === 'self_referral') await sendTelegram(chatId, '😅 You can’t refer yourself!');
          else if (errCode === 'already_referred') await sendTelegram(chatId, "⚠️ You have already been referred or referral couldn't be recorded.");
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
        const referrerId = parts[1].replace('ref_', '').trim();

        if (!tgId) {
          return res.json({ ok: false, error: 'no tg id' });
        }

        try {
          const { data: rpcData, error: rpcErr } = await supabase.rpc('manual_refer_by_id', {
            referrer_id: referrerId,
            referred_id: tgId,
            referred_username: username
          });

          if (rpcErr) {
            console.error('manual_refer_by_id rpc error (start flow):', rpcErr);
            // fallback: ensure user exists to avoid repeating join problems
            try {
              const { data: existing } = await supabase
                .from('users')
                .select('id')
                .eq('id', tgId)
                .maybeSingle();
              if (!existing) {
                await supabase.from('users').insert([{
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
              }
            } catch (e) {
              console.warn('create fallback user failed', e?.message || e);
            }

            await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
            return res.json({ ok: false, error: rpcErr.message || rpcErr });
          }

          const rpcResult = Array.isArray(rpcData) ? rpcData[0] : rpcData;
          if (!rpcResult) {
            await sendTelegram(chatId, '⚠️ Referral error. Try again later.');
            return res.json({ ok: false });
          }

          if (rpcResult.success === true) {
            await sendTelegram(chatId, `🎁 You were successfully referred by <b>${rpcResult.inviter_username || referrerId}</b>!`, { parse_mode: 'HTML' });
            try {
              if (rpcResult.inviter_id) await sendTelegram(rpcResult.inviter_id, `🎉 <b>${escapeHtml(username)}</b> joined using your referral!\nYou received +100 💰 coins.`, { parse_mode: 'HTML' });
            } catch (e) {}
            return res.json({ ok: true });
          } else {
            const errCode = rpcResult.error || 'unknown';
            if (errCode === 'inviter_not_found') {
              await sendTelegram(chatId, '❌ Inviter not found in database.');
            } else if (errCode === 'self_referral') {
              await sendTelegram(chatId, '😅 You can’t refer yourself!');
            } else if (errCode === 'already_referred') {
              await sendTelegram(chatId, "⚠️ You have already been referred or referral couldn't be recorded.");
            } else {
              await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
            }
            return res.json({ ok: false, error: errCode });
          }
        } catch (err) {
          console.error('manual_refer_by_id call failed (start):', err);
          await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          return res.json({ ok: false, error: err?.message || err });
        }
      } else {
        // plain /start -> ensure user exists
        if (tgId) {
          try {
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
          } catch (e) {
            console.warn('create user on plain /start failed', e?.message || e);
          }
        }
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
