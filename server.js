const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/locations', (req, res) => {
  res.json(db.listLocations());
});

app.get('/api/settings', (req, res) => {
  res.json(db.getSettings());
});

app.put('/api/settings', (req, res) => {
  const { company_name, company_address, company_gstin, company_logo, seq_padding } = req.body;
  if (seq_padding !== undefined && (!Number.isInteger(seq_padding) || seq_padding < 1 || seq_padding > 10)) {
    return res.status(400).json({ error: 'seq_padding must be an integer between 1 and 10' });
  }
  const updated = db.updateSettings({ company_name, company_address, company_gstin, company_logo, seq_padding });
  res.json(updated);
});

app.get('/api/next-serial-preview', (req, res) => {
  const { location, date } = req.query;
  if (!location || !db.getLocation(location)) {
    return res.status(400).json({ error: 'a valid location is required' });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'a valid date (YYYY-MM-DD) is required' });
  }
  res.json({ serial: db.previewNextSerial(location, date) });
});

app.get('/api/challans', (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q : undefined;
  res.json(db.listChallans({ search }));
});

app.get('/api/challans/:id', (req, res) => {
  const challan = db.getChallan(req.params.id);
  if (!challan) return res.status(404).json({ error: 'Challan not found' });
  res.json(challan);
});

function validateChallanPayload(body) {
  if (!body.challan_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.challan_date)) {
    return 'a valid challan_date (YYYY-MM-DD) is required';
  }
  if (!body.location_code || !db.getLocation(body.location_code)) {
    return 'a valid location_code is required';
  }
  if (!body.to_contact_name || !body.to_contact_name.trim()) return 'to_contact_name is required';
  if (!Array.isArray(body.items) || body.items.length === 0) return 'at least one item is required';
  for (const item of body.items) {
    if (!item.item_name || !item.item_name.trim()) return 'each item requires a name';
  }
  return null;
}

app.post('/api/challans', (req, res) => {
  const error = validateChallanPayload(req.body);
  if (error) return res.status(400).json({ error });
  const id = db.createChallan(req.body);
  res.status(201).json(db.getChallan(id));
});

app.put('/api/challans/:id', (req, res) => {
  const existing = db.getChallan(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Challan not found' });
  if (!req.body.to_contact_name || !req.body.to_contact_name.trim()) {
    return res.status(400).json({ error: 'to_contact_name is required' });
  }
  if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
    return res.status(400).json({ error: 'at least one item is required' });
  }
  for (const item of req.body.items) {
    if (!item.item_name || !item.item_name.trim()) {
      return res.status(400).json({ error: 'each item requires a name' });
    }
  }
  db.updateChallan(req.params.id, req.body);
  res.json(db.getChallan(req.params.id));
});

app.delete('/api/challans/:id', (req, res) => {
  const existing = db.getChallan(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Challan not found' });
  db.deleteChallan(req.params.id);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Delivery challan app running at http://localhost:${PORT}`);
});
