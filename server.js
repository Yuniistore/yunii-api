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

/**
 * CONFIG DES LOTS
 * value doit correspondre EXACTEMENT à la colonne "value" de la table prizes
 *
 * - "nothing"   : pas de gain
 * - "-5%"       : réduction 5%
 * - "-10%"      : réduction 10%
 * - "-20%"      : réduction 20%
 * - "CADEAU1/2" : cadeaux physiques
 *
 * Tu peux ajuster les weight si tu veux plus / moins de chances.
 */
const PRIZE_CONFIG = [
  { value: 'nothing', weight: 15 },   // 15% pas de gain
  { value: '-5%',   weight: 30 },     // 30% -5%
  { value: '-10%',  weight: 25 },     // 25% -10%
  { value: '-20%',  weight: 15 },     // 15% -20%
  { value: 'CADEAU1', weight: 8 },    // 8% Cadeau 1
  { value: 'CADEAU2', weight: 7 },    // 7% Cadeau 2
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
  const { rows } = await pool.query(
    'SELECT id, value, name, stock FROM prizes ORDER BY id'
  );
  res.json(rows);
});

// Spin
app.post('/spin', async (req, res) => {
  const userId = req.body.userId;
  if (!userId) {
    return res
      .status(400)
      .json({ ok: false, message: 'Il faut être connecté pour jouer.' });
  }

  try {
    const canPlay = await userCanPlayToday(userId);
    if (!canPlay) {
      return res
        .status(400)
        .json({ ok: false, message: "Tu as déjà joué aujourd'hui !" });
    }

    // Récupération des lots en base
    const { rows: dbPrizes } = await pool.query(
      'SELECT value, name, stock FROM prizes'
    );
    const prizeMap = new Map(dbPrizes.map((p) => [p.value, p]));

    let chosen;
    let tries = 0;

    do {
      const conf = weightedRandom(PRIZE_CONFIG);
      const dbPrize = prizeMap.get(conf.value);

      // Si le lot n'existe pas en base => on retourne "Rien"
      if (!dbPrize) {
        chosen = { value: 'nothing', name: 'Rien' };
        break;
      }

      // Si c'est un cadeau physique, on vérifie le stock (CADEAU1/2)
      if (
        conf.value.startsWith('CADEAU') &&
        dbPrize.stock !== null &&
        dbPrize.stock <= 0
      ) {
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

    // On NE génère un code QUE pour les réductions %
    if (chosen.value === '-5%' || chosen.value === '-10%' || chosen.value === '-20%') {
      // ex : YUNII-5-ABCD1234
      const percentClean = chosen.value.replace('-', '').replace('%', '');
      const code = `YUNII-${percentClean}-${uuidv4()
        .slice(0, 8)
        .toUpperCase()}`;

      const percentNumber = parseInt(percentClean, 10); // 5 / 10 / 20

      const priceRulePayload = {
        price_rule: {
          title: `Jeu-Noel-${percentNumber}-${code}`,
          target_type: 'line_item',
          target_selection: 'all',
          allocation_method: 'across',
          value_type: 'percentage',
          value: `-${percentNumber}.0`,
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

    // On log le spin
    await pool.query(
      'INSERT INTO spins(user_id, prize_value, spin_date) VALUES($1, $2, NOW())',
      [userId, chosen.value]
    );

    // Si cadeau physique, on décrémente le stock (CADEAU1/2)
    if (chosen.value.startsWith('CADEAU')) {
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
