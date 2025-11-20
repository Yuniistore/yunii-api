const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// Config env
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL;
const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

const pool = new Pool({ connectionString: DB_URL });
// Test de connexion PostgreSQL au démarrage
pool
  .query('SELECT NOW()')
  .then(() => {
    console.log('Connexion PostgreSQL OK');
  })
  .catch((err) => {
    console.error('Erreur de connexion PostgreSQL :', err.message);
  });
// Rate limit sur /spin
const limiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
app.use('/spin', limiter);

// Probabilités
const PRIZE_CONFIG = [
  { value: 'nothing', weight: 45 },
  { value: 'coupon10', weight: 28 },
  { value: 'coupon20', weight: 15 },
  { value: 'gift_bubblerush', weight: 3 },
  { value: 'gift_pokemon', weight: 3 },
  { value: 'gift_brosse', weight: 3 },
  { value: 'gift_bip', weight: 3 },
];

function weightedRandom(list) {
  const total = list.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of list) {
    if (r < p.weight) return p;
    r -= p.weight;
  }
  return list[list.length - 1];
}

// Vérifier si user peut jouer aujourd'hui
async function userCanPlayToday(userId) {
  const { rows } = await pool.query(
    'SELECT spin_date FROM spins WHERE user_id = $1 ORDER BY spin_date DESC LIMIT 1',
    [userId]
  );
  if (rows.length === 0) return true;
  const last = new Date(rows[0].spin_date);
  const today = new Date();
  return last.toDateString() !== today.toDateString();
}

// Lister les lots
app.get('/prizes', async (req, res) => {
  const { rows } = await pool.query('SELECT id, value, name, stock FROM prizes ORDER BY id');
  res.json(rows);
});

// Spin
app.post('/spin', async (req, res) => {
  const userId = req.body.userId;
  if (!userId) {
    return res.status(400).json({ ok: false, message: 'Il faut être connecté pour jouer.' });
  }

  try {
    const canPlay = await userCanPlayToday(userId);
    if (!canPlay) {
      return res.status(400).json({ ok: false, message: "Tu as déjà joué aujourd'hui !" });
    }

    const { rows: dbPrizes } = await pool.query('SELECT value, name, stock FROM prizes');
    const prizeMap = new Map(dbPrizes.map(p => [p.value, p]));

    let chosen;
    let tries = 0;

    do {
      const conf = weightedRandom(PRIZE_CONFIG);
      const dbPrize = prizeMap.get(conf.value);
      if (!dbPrize) {
        chosen = { value: 'nothing', name: 'Rien' };
        break;
      }
      if (conf.value.startsWith('gift_') && dbPrize.stock !== null && dbPrize.stock <= 0) {
        tries++;
        if (tries > 10) {
          chosen = { value: 'nothing', name: 'Rien' };
          break;
        }
        continue;
      }
      chosen = { value: conf.value, name: dbPrize.name };
      break;
    } while (!chosen);


    let couponCode = null;

    if (
      chosen.value === 'coupon10' ||
      chosen.value === 'coupon20' ||
      chosen.value.startsWith('gift_')
    ) {
      const code = `${chosen.value.toUpperCase()}-${uuidv4()
        .slice(0, 8)
        .toUpperCase()}`;

      const priceRulePayload = {
        price_rule: {
          title: `Jeu-Noel-${code}`,
          target_type: 'line_item',
          target_selection: 'all',
          allocation_method: 'across',
          value_type: 'percentage',
          value:
            chosen.value === 'coupon20'
              ? '-20.0'
              : chosen.value === 'coupon10'
              ? '-10.0'
              : '-100.0',
          once_per_customer: true,
          usage_limit: 1,
          starts_at: new Date().toISOString(),
        },
      };

      const prRes = await fetch(
        `https://${SHOP_DOMAIN}/admin/api/2025-01/price_rules.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': SHOP_TOKEN,
          },
          body: JSON.stringify(priceRulePayload),
        }
      );

      const prJson = await prRes.json();
      const priceRuleId = prJson.price_rule && prJson.price_rule.id;

      if (priceRuleId) {
        const dcRes = await fetch(
          `https://${SHOP_DOMAIN}/admin/api/2025-01/price_rules/${priceRuleId}/discount_codes.json`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': SHOP_TOKEN,
            },
            body: JSON.stringify({ discount_code: { code } }),
          }
        );

        const dcJson = await dcRes.json();
        if (dcJson.discount_code && dcJson.discount_code.code) {
          couponCode = dcJson.discount_code.code;
        }
      }
    }

    await pool.query(
      'INSERT INTO spins(user_id, prize_value, spin_date) VALUES($1, $2, NOW())',
      [userId, chosen.value]
    );

    if (chosen.value.startsWith('gift_')) {
      await pool.query(
        'UPDATE prizes SET stock = GREATEST(stock - 1, 0) WHERE value = $1',
        [chosen.value]
      );
    }

    res.json({
      ok: true,
      prizeValue: chosen.value,
      prizeName: chosen.name,
      couponCode,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Erreur serveur' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend Yunii lancé sur port : ${PORT}`);
});
