const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_name TEXT NOT NULL DEFAULT '',
    company_address TEXT NOT NULL DEFAULT '',
    company_gstin TEXT NOT NULL DEFAULT '',
    seq_padding INTEGER NOT NULL DEFAULT 2
  );

  CREATE TABLE IF NOT EXISTS challans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_number TEXT UNIQUE NOT NULL,
    location_code TEXT NOT NULL REFERENCES locations(code),
    seq INTEGER NOT NULL,
    challan_date TEXT NOT NULL,
    party_name TEXT NOT NULL,
    party_address TEXT NOT NULL DEFAULT '',
    party_gstin TEXT NOT NULL DEFAULT '',
    vehicle_number TEXT NOT NULL DEFAULT '',
    place_of_supply TEXT NOT NULL DEFAULT '',
    remarks TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS challan_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challan_id INTEGER NOT NULL REFERENCES challans(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    hsn_code TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT '',
    rate REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0
  );
`);

db.prepare(`INSERT OR IGNORE INTO settings (id, seq_padding) VALUES (1, 2)`).run();

const seedLocation = db.prepare('INSERT OR IGNORE INTO locations (code, name) VALUES (?, ?)');
seedLocation.run('BLR', 'Bangalore');
seedLocation.run('MUM', 'Mumbai');
seedLocation.run('DEL', 'Delhi');

function listLocations() {
  return db.prepare('SELECT * FROM locations ORDER BY name').all();
}

function getLocation(code) {
  return db.prepare('SELECT * FROM locations WHERE code = ?').get(code);
}

function getSettings() {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get();
}

function updateSettings({ company_name, company_address, company_gstin, seq_padding }) {
  const current = getSettings();
  db.prepare(
    `UPDATE settings SET
      company_name = @company_name,
      company_address = @company_address,
      company_gstin = @company_gstin,
      seq_padding = @seq_padding
     WHERE id = 1`
  ).run({
    company_name: company_name ?? current.company_name,
    company_address: company_address ?? current.company_address,
    company_gstin: company_gstin ?? current.company_gstin,
    seq_padding: seq_padding ?? current.seq_padding,
  });
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

const nextSeqStmt = db.prepare(
  'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM challans WHERE location_code = ? AND challan_date = ?'
);

// Preview only — does not claim the number. The real sequence number is
// computed again inside the create transaction below, so two challans can
// never collide even if two previews raced.
function previewNextSerial(locationCode, challanDate) {
  const { seq_padding } = getSettings();
  const { next_seq } = nextSeqStmt.get(locationCode, challanDate);
  return formatSerial(challanDate, locationCode, next_seq, seq_padding);
}

function computeItemAmount(item) {
  const qty = Number(item.quantity) || 0;
  const rate = Number(item.rate) || 0;
  return Math.round(qty * rate * 100) / 100;
}

function insertItems(challanId, items) {
  const insertItem = db.prepare(
    `INSERT INTO challan_items (challan_id, description, hsn_code, quantity, unit, rate, amount)
     VALUES (@challan_id, @description, @hsn_code, @quantity, @unit, @rate, @amount)`
  );
  for (const item of items || []) {
    if (!item.description) continue;
    insertItem.run({
      challan_id: challanId,
      description: item.description,
      hsn_code: item.hsn_code || '',
      quantity: Number(item.quantity) || 0,
      unit: item.unit || '',
      rate: Number(item.rate) || 0,
      amount: computeItemAmount(item),
    });
  }
}

// Atomically claims the next per-location, per-day sequence number and
// creates the challan. better-sqlite3 transactions run synchronously against
// a single connection, so this read-then-write is race-free even under
// concurrent requests.
const createChallan = db.transaction((data) => {
  const { seq_padding } = getSettings();
  const { next_seq } = nextSeqStmt.get(data.location_code, data.challan_date);
  const serial_number = formatSerial(data.challan_date, data.location_code, next_seq, seq_padding);

  const info = db
    .prepare(
      `INSERT INTO challans
        (serial_number, location_code, seq, challan_date, party_name, party_address, party_gstin, vehicle_number, place_of_supply, remarks)
       VALUES (@serial_number, @location_code, @seq, @challan_date, @party_name, @party_address, @party_gstin, @vehicle_number, @place_of_supply, @remarks)`
    )
    .run({
      serial_number,
      location_code: data.location_code,
      seq: next_seq,
      challan_date: data.challan_date,
      party_name: data.party_name,
      party_address: data.party_address || '',
      party_gstin: data.party_gstin || '',
      vehicle_number: data.vehicle_number || '',
      place_of_supply: data.place_of_supply || '',
      remarks: data.remarks || '',
    });

  const challanId = info.lastInsertRowid;
  insertItems(challanId, data.items);
  return challanId;
});

// challan_date and location_code are immutable after creation since the
// serial number is derived from them — editing them here would leave the
// serial's embedded date/location wrong.
const updateChallan = db.transaction((id, data) => {
  db.prepare(
    `UPDATE challans SET
      party_name = @party_name,
      party_address = @party_address,
      party_gstin = @party_gstin,
      vehicle_number = @vehicle_number,
      place_of_supply = @place_of_supply,
      remarks = @remarks
     WHERE id = @id`
  ).run({
    id,
    party_name: data.party_name,
    party_address: data.party_address || '',
    party_gstin: data.party_gstin || '',
    vehicle_number: data.vehicle_number || '',
    place_of_supply: data.place_of_supply || '',
    remarks: data.remarks || '',
  });

  db.prepare('DELETE FROM challan_items WHERE challan_id = ?').run(id);
  insertItems(id, data.items);
});

function listChallans({ search } = {}) {
  let rows;
  if (search) {
    rows = db
      .prepare(
        `SELECT c.*, l.name AS location_name, COALESCE(SUM(i.amount), 0) AS total
         FROM challans c
         LEFT JOIN challan_items i ON i.challan_id = c.id
         LEFT JOIN locations l ON l.code = c.location_code
         WHERE c.serial_number LIKE @q OR c.party_name LIKE @q
         GROUP BY c.id
         ORDER BY c.id DESC`
      )
      .all({ q: `%${search}%` });
  } else {
    rows = db
      .prepare(
        `SELECT c.*, l.name AS location_name, COALESCE(SUM(i.amount), 0) AS total
         FROM challans c
         LEFT JOIN challan_items i ON i.challan_id = c.id
         LEFT JOIN locations l ON l.code = c.location_code
         GROUP BY c.id
         ORDER BY c.id DESC`
      )
      .all();
  }
  return rows;
}

function getChallan(id) {
  const challan = db
    .prepare(
      `SELECT c.*, l.name AS location_name FROM challans c
       LEFT JOIN locations l ON l.code = c.location_code
       WHERE c.id = ?`
    )
    .get(id);
  if (!challan) return null;
  const items = db.prepare('SELECT * FROM challan_items WHERE challan_id = ? ORDER BY id').all(id);
  return { ...challan, items };
}

function deleteChallan(id) {
  db.prepare('DELETE FROM challans WHERE id = ?').run(id);
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
