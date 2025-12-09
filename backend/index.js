// index.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

const RAW_FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const FRONTEND_ORIGIN = RAW_FRONTEND_ORIGIN.replace(/\/$/, '');

app.use(cors({
  origin: ["http://localhost:5173", FRONTEND_ORIGIN].filter(Boolean),
  methods: "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
  credentials: true
}));
app.use(express.json());

// Environment
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_SECRET_PATH = process.env.TELEGRAM_SECRET_PATH || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing Supabase env vars. Fill SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// Game constants (unchanged)
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

// Debug endpoint
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
 * Telegram webhook (handles /start ref_<id> and /refer <username>)
 * Ensure you set your webhook in Telegram to: https://<your-domain>/telegram/webhook
 * or https://<your-domain>/telegram/webhook/<TELEGRAM_SECRET_PATH> if you use that env.
 */
app.post(`/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.sendStatus(204);

    // Logging for debugging (remove or reduce in production)
    console.log('telegram webhook body:', JSON.stringify(body));

    const msg = body.message || body.edited_message;
    if (!msg) return res.sendStatus(204);

    const text = (msg.text || '').trim();
    const from = msg.from || {};
    const tgId = from.id?.toString();
    const username = from.username || `${from.first_name || 'tg'}_${tgId}`;
    const chatId = msg.chat?.id?.toString() || tgId;

    // helper: send message via Bot API
    async function sendTelegram(chat, textMsg, opts = {}) {
      if (!TELEGRAM_BOT_TOKEN) {
        console.warn('TELEGRAM_BOT_TOKEN missing, cannot send message');
        return;
      }
      try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const payload = { chat_id: chat, text: textMsg, ...opts };
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      } catch (e) {
        console.warn('Failed to send telegram message', e?.message || e);
      }
    }

    // --- Manual /refer <username> command (optional)
    if (text && (text.startsWith('/refer') || text === 'Refer 🎁')) {
      // /refer alone -> return referral link
      if (!(text.startsWith('/refer ') || /^\/refer@/i.test(text))) {
        // get bot username (for link)
        let botUsername = null;
        try {
          const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
          const json = await resp.json();
          if (json?.ok) botUsername = json.result.username;
        } catch (e) { /* ignore */ }

        const referralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${chatId}` : `https://t.me/${chatId}?start=ref_${chatId}`;
        await sendTelegram(chatId, `🎁 <b>Your Referral Link</b>\nInvite your friends and earn <b>100 coins</b> per referral!\n\n🔗 ${referralLink}`, { parse_mode: 'HTML' });
        return res.json({ ok: true });
      }

      // /refer <username> case: call RPC by username
      const parts = text.split(/\s+/);
      const targetUsername = parts[1]?.replace('@', '')?.trim();
      if (!targetUsername) {
        await sendTelegram(chatId, '❌ Please provide the inviter username. Example: /refer SomeUser');
        return res.json({ ok: true });
      }

      try {
        const { data: rpcData, error: rpcErr } = await supabase.rpc('manual_refer_by_username', {
          referrer_username: targetUsername,
          referred_id: tgId,
          referred_username: username
        });

        if (rpcErr) {
          console.error('manual_refer_by_username rpc error', rpcErr);
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
          try { if (rpcResult.inviter_id) await sendTelegram(rpcResult.inviter_id, `🎉 <b>${username}</b> joined using your referral!\nYou received +100 💰 coins.`, { parse_mode: 'HTML' }); } catch(e){}
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
        console.error('Referral error:', err);
        await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
        return res.json({ ok: false, error: err?.message || err });
      }
    }

    // --- /start ref_<id> handling (this is the critical flow)
    if (text && text.startsWith('/start')) {
      const parts = text.split(/\s+/);
      if (parts[1] && parts[1].startsWith('ref_')) {
        const referrerId = parts[1].replace('ref_', '').trim();

        if (!tgId) {
          // We require tgId to attach record
          return res.json({ ok: false, error: 'no tg id' });
        }

        try {
          // Call atomic RPC that expects referrer_id, referred_id, referred_username
          const { data: rpcData, error: rpcErr } = await supabase.rpc('manual_refer_by_id', {
            referrer_id: referrerId,
            referred_id: tgId,
            referred_username: username
          });

          if (rpcErr) {
            console.error('manual_refer_by_id rpc error', rpcErr);
            // still create user record if not present to avoid double-join issues
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
            // Success: inform referred and inviter
            await sendTelegram(chatId, `🎁 You were successfully referred by <b>${rpcResult.inviter_username || referrerId}</b>!`, { parse_mode: 'HTML' });
            try {
              if (rpcResult.inviter_id) {
                await sendTelegram(rpcResult.inviter_id, `🎉 <b>${username}</b> joined using your referral!\nYou received +100 💰 coins.`, { parse_mode: 'HTML' });
              }
            } catch (e) { /* ignore send failures */ }

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
          console.error('manual_refer_by_id call failed', err);
          await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          return res.json({ ok: false, error: err?.message || err });
        }
      } else {
        // /start without ref: ensure user exists
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

    // For any non-handled updates
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

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
