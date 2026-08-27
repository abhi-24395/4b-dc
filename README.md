# Delivery Challan

A small delivery challan management app with automatic, location-aware serial numbers.

## Serial number format

```
DDMMYYYY/LOCATION/SEQ
```

e.g. `11082026/BLR/01`, `11082026/MUM/01`, `11082026/DEL/01`.

- The date part comes from the challan's own date, not the creation time.
- Each location (Bangalore/BLR, Mumbai/MUM, Delhi/DEL) has its own sequence.
- The sequence resets to `01` at the start of each day, per location.
- Serials are assigned atomically on save, so two challans can never collide.

## Running

```
npm install
npm start
```

Then open http://localhost:3000.

## Structure

- `server.js` — Express routes
- `db.js` — SQLite schema and all serial-number/challan logic (better-sqlite3)
- `public/` — vanilla JS single-page frontend (list, create/edit form, settings) and a standalone print view
