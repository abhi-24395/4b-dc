const express = require('express');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// All route handlers are async (Postgres queries), so wrap them to forward
// rejections to Express's error handler instead of leaving requests hanging.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.post('/api/login', wrap(async (req, res) => {
  const { id, password } = req.body || {};
  const role = auth.checkCredentials(id, password);
  if (!role) return res.status(401).json({ error: 'Invalid ID or password' });
  auth.setSessionCookie(res, role);
  res.json({ role });
}));

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/me', (req, res) => {
  const session = auth.getSession(req);
  res.json({ role: session ? session.role : null });
});

app.get('/api/locations', auth.requireAuth, wrap(async (req, res) => {
  res.json(await db.listLocations());
}));

app.get('/api/settings', auth.requireAuth, wrap(async (req, res) => {
  res.json(await db.getSettings());
}));

app.put('/api/settings', auth.requireAdmin, wrap(async (req, res) => {
  const { company_name, company_address, company_gstin, company_logo, seq_padding } = req.body;
  if (seq_padding !== undefined && (!Number.isInteger(seq_padding) || seq_padding < 1 || seq_padding > 10)) {
    return res.status(400).json({ error: 'seq_padding must be an integer between 1 and 10' });
  }
  const updated = await db.updateSettings({ company_name, company_address, company_gstin, company_logo, seq_padding });
  res.json(updated);
}));

app.get('/api/next-serial-preview', auth.requireAuth, wrap(async (req, res) => {
  const { location, date } = req.query;
  if (!location || !(await db.getLocation(location))) {
    return res.status(400).json({ error: 'a valid location is required' });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'a valid date (YYYY-MM-DD) is required' });
  }
  res.json({ serial: await db.previewNextSerial(location, date) });
}));

app.get('/api/challans', auth.requireAuth, wrap(async (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q : undefined;
  res.json(await db.listChallans({ search }));
}));

app.get('/api/challans/:id', auth.requireAuth, wrap(async (req, res) => {
  const challan = await db.getChallan(req.params.id);
  if (!challan) return res.status(404).json({ error: 'Challan not found' });
  res.json(challan);
}));

async function validateChallanPayload(body) {
  if (!body.challan_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.challan_date)) {
    return 'a valid challan_date (YYYY-MM-DD) is required';
  }
  if (!body.location_code || !(await db.getLocation(body.location_code))) {
    return 'a valid location_code is required';
  }
  if (!body.to_contact_name || !body.to_contact_name.trim()) return 'to_contact_name is required';
  if (!Array.isArray(body.items) || body.items.length === 0) return 'at least one item is required';
  for (const item of body.items) {
    if (!item.item_name || !item.item_name.trim()) return 'each item requires a name';
  }
  return null;
}

app.post('/api/challans', auth.requireAuth, wrap(async (req, res) => {
  const error = await validateChallanPayload(req.body);
  if (error) return res.status(400).json({ error });
  const id = await db.createChallan(req.body);
  res.status(201).json(await db.getChallan(id));
}));

app.put('/api/challans/:id', auth.requireAuth, wrap(async (req, res) => {
  const existing = await db.getChallan(req.params.id);
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
  await db.updateChallan(req.params.id, req.body);
  res.json(await db.getChallan(req.params.id));
}));

app.delete('/api/challans/:id', auth.requireAuth, wrap(async (req, res) => {
  const existing = await db.getChallan(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Challan not found' });
  await db.deleteChallan(req.params.id);
  res.status(204).end();
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
