const { Pool } = require('pg');

// Lazy: resolved on first query rather than at module load, so the rest of
// the app (e.g. a diagnostics route) can still run if this is misconfigured.
let pool = null;
function getPool() {
  if (!pool) {
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('POSTGRES_URL (or DATABASE_URL) environment variable is required');
    }
    // Hosted Postgres (e.g. Neon, used in production) requires SSL; a local
    // Postgres instance for development typically doesn't have it enabled.
    const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
    pool = new Pool({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

// Runs once per process (cached across warm serverless invocations) to create
// the schema and seed fixed reference data if it isn't already there.
let initPromise = null;
function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS locations (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            company_name TEXT NOT NULL DEFAULT '',
            company_address TEXT NOT NULL DEFAULT '',
            company_gstin TEXT NOT NULL DEFAULT '',
            company_logo TEXT NOT NULL DEFAULT '',
            seq_padding INTEGER NOT NULL DEFAULT 2
          );

          -- One row per (location, day); last_seq is atomically bumped via
          -- an UPSERT when a challan is created, so two concurrent requests
          -- for the same location/day can never receive the same number.
          CREATE TABLE IF NOT EXISTS serial_counters (
            location_code TEXT NOT NULL REFERENCES locations(code),
            challan_date TEXT NOT NULL,
            last_seq INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (location_code, challan_date)
          );

          CREATE TABLE IF NOT EXISTS challans (
            id SERIAL PRIMARY KEY,
            serial_number TEXT UNIQUE NOT NULL,
            location_code TEXT NOT NULL REFERENCES locations(code),
            seq INTEGER NOT NULL,
            challan_date TEXT NOT NULL,
            from_contact_name TEXT NOT NULL DEFAULT '',
            from_contact_mobile TEXT NOT NULL DEFAULT '',
            from_address TEXT NOT NULL DEFAULT '',
            to_contact_name TEXT NOT NULL,
            to_email TEXT NOT NULL DEFAULT '',
            to_mobile TEXT NOT NULL DEFAULT '',
            to_address TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE TABLE IF NOT EXISTS challan_items (
            id SERIAL PRIMARY KEY,
            challan_id INTEGER NOT NULL REFERENCES challans(id) ON DELETE CASCADE,
            item_name TEXT NOT NULL,
            quantity REAL NOT NULL DEFAULT 0,
            price REAL NOT NULL DEFAULT 0,
            amount REAL NOT NULL DEFAULT 0
          );
        `);

        await client.query(
          `INSERT INTO settings (id, company_name, company_address, company_gstin, company_logo, seq_padding)
           VALUES (1, '4Brains Technologies Private Limited',
             'Akshar Business Park, T0067, Phase 2, Sector 25, Vashi, Navi Mumbai, Maharashtra 400703',
             '27AABCZ8509M2ZO', '/assets/logo.png', 2)
           ON CONFLICT (id) DO NOTHING`
        );

        for (const [code, name] of [['BLR', 'Bangalore'], ['MUM', 'Mumbai'], ['DEL', 'Delhi']]) {
          await client.query('INSERT INTO locations (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [code, name]);
        }
      } finally {
        client.release();
      }
    })();
  }
  return initPromise;
}

async function listLocations() {
  await ensureInit();
  const { rows } = await getPool().query('SELECT * FROM locations ORDER BY name');
  return rows;
}

async function getLocation(code) {
  await ensureInit();
  const { rows } = await getPool().query('SELECT * FROM locations WHERE code = $1', [code]);
  return rows[0] || null;
}

async function getSettings() {
  await ensureInit();
  const { rows } = await getPool().query('SELECT * FROM settings WHERE id = 1');
  return rows[0];
}

async function updateSettings({ company_name, company_address, company_gstin, company_logo, seq_padding }) {
  await ensureInit();
  const current = await getSettings();
  await getPool().query(
    `UPDATE settings SET
      company_name = $1, company_address = $2, company_gstin = $3, company_logo = $4, seq_padding = $5
     WHERE id = 1`,
    [
      company_name ?? current.company_name,
      company_address ?? current.company_address,
      company_gstin ?? current.company_gstin,
      company_logo ?? current.company_logo,
      seq_padding ?? current.seq_padding,
    ]
  );
  return getSettings();
}

// Serial date part is DDMMYYYY, derived from the challan's own date (an
// <input type=date> value formatted as YYYY-MM-DD), not today's date.
function formatDatePart(challanDate) {
  const [y, m, d] = challanDate.split('-');
  return `${d}${m}${y}`;
}

function formatSerial(challanDate, locationCode, seq, padding) {
  return `${formatDatePart(challanDate)}/${locationCode}/${String(seq).padStart(padding, '0')}`;
}

// Preview only — does not claim the number. The real sequence number is
// claimed atomically inside the create transaction below, so two challans
// can never collide even if two previews raced.
async function previewNextSerial(locationCode, challanDate) {
  await ensureInit();
  const settings = await getSettings();
  const { rows } = await getPool().query(
    'SELECT last_seq FROM serial_counters WHERE location_code = $1 AND challan_date = $2',
    [locationCode, challanDate]
  );
  const nextSeq = (rows[0]?.last_seq || 0) + 1;
  return formatSerial(challanDate, locationCode, nextSeq, settings.seq_padding);
}

function computeItemAmount(item) {
  const qty = Number(item.quantity) || 0;
  const price = Number(item.price) || 0;
  return Math.round(qty * price * 100) / 100;
}

async function insertItems(client, challanId, items) {
  for (const item of items || []) {
    if (!item.item_name) continue;
    await client.query(
      `INSERT INTO challan_items (challan_id, item_name, quantity, price, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [challanId, item.item_name, Number(item.quantity) || 0, Number(item.price) || 0, computeItemAmount(item)]
    );
  }
}

// Atomically claims the next per-location, per-day sequence number (via an
// UPSERT on serial_counters, which Postgres resolves as a single atomic
// operation even under concurrent requests) and creates the challan in the
// same transaction.
async function createChallan(data) {
  await ensureInit();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const settingsRes = await client.query('SELECT seq_padding FROM settings WHERE id = 1');
    const seq_padding = settingsRes.rows[0].seq_padding;

    const counterRes = await client.query(
      `INSERT INTO serial_counters (location_code, challan_date, last_seq)
       VALUES ($1, $2, 1)
       ON CONFLICT (location_code, challan_date)
       DO UPDATE SET last_seq = serial_counters.last_seq + 1
       RETURNING last_seq`,
      [data.location_code, data.challan_date]
    );
    const seq = counterRes.rows[0].last_seq;
    const serial_number = formatSerial(data.challan_date, data.location_code, seq, seq_padding);

    const challanRes = await client.query(
      `INSERT INTO challans
        (serial_number, location_code, seq, challan_date,
         from_contact_name, from_contact_mobile, from_address,
         to_contact_name, to_email, to_mobile, to_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        serial_number,
        data.location_code,
        seq,
        data.challan_date,
        data.from_contact_name || '',
        data.from_contact_mobile || '',
        data.from_address || '',
        data.to_contact_name,
        data.to_email || '',
        data.to_mobile || '',
        data.to_address || '',
      ]
    );
    const challanId = challanRes.rows[0].id;
    await insertItems(client, challanId, data.items);

    await client.query('COMMIT');
    return challanId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// challan_date and location_code are immutable after creation since the
// serial number is derived from them — editing them here would leave the
// serial's embedded date/location wrong.
async function updateChallan(id, data) {
  await ensureInit();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE challans SET
        from_contact_name = $1, from_contact_mobile = $2, from_address = $3,
        to_contact_name = $4, to_email = $5, to_mobile = $6, to_address = $7
       WHERE id = $8`,
      [
        data.from_contact_name || '',
        data.from_contact_mobile || '',
        data.from_address || '',
        data.to_contact_name,
        data.to_email || '',
        data.to_mobile || '',
        data.to_address || '',
        id,
      ]
    );
    await client.query('DELETE FROM challan_items WHERE challan_id = $1', [id]);
    await insertItems(client, id, data.items);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listChallans({ search } = {}) {
  await ensureInit();
  const base = `SELECT c.*, l.name AS location_name, COALESCE(SUM(i.amount), 0) AS total
    FROM challans c
    LEFT JOIN challan_items i ON i.challan_id = c.id
    LEFT JOIN locations l ON l.code = c.location_code`;
  const groupOrder = `GROUP BY c.id, l.name ORDER BY c.id DESC`;

  const { rows } = search
    ? await getPool().query(`${base} WHERE c.serial_number ILIKE $1 OR c.to_contact_name ILIKE $1 ${groupOrder}`, [`%${search}%`])
    : await getPool().query(`${base} ${groupOrder}`);
  return rows;
}

async function getChallan(id) {
  await ensureInit();
  const { rows } = await getPool().query(
    `SELECT c.*, l.name AS location_name FROM challans c
     LEFT JOIN locations l ON l.code = c.location_code
     WHERE c.id = $1`,
    [id]
  );
  const challan = rows[0];
  if (!challan) return null;
  const itemsRes = await getPool().query('SELECT * FROM challan_items WHERE challan_id = $1 ORDER BY id', [id]);
  return { ...challan, items: itemsRes.rows };
}

async function deleteChallan(id) {
  await ensureInit();
  await getPool().query('DELETE FROM challans WHERE id = $1', [id]);
}

module.exports = {
  listLocations,
  getLocation,
  getSettings,
  updateSettings,
  previewNextSerial,
  createChallan,
  updateChallan,
  listChallans,
  getChallan,
  deleteChallan,
};
