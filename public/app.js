const app = document.getElementById('app');
let toastTimer;

function toast(message, isError) {
  clearTimeout(toastTimer);
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401 && path !== '/api/me' && path !== '/api/login') {
    currentRole = null;
    await renderLogin();
    throw new Error('Session expired, please sign in again');
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch (_) {}
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function formatMoney(n) {
  return Number(n || 0).toFixed(2);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- Auth ----------

let currentRole = null;

function applyRoleToChrome() {
  document.getElementById('topbar').hidden = !currentRole;
  document.getElementById('nav-settings').hidden = currentRole !== 'admin';
}

async function renderLogin() {
  document.getElementById('topbar').hidden = true;
  const tpl = document.getElementById('tpl-login');
  app.replaceChildren(tpl.content.cloneNode(true));

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    errorEl.hidden = true;
    try {
      const { role } = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          id: document.getElementById('login-id').value.trim(),
          password: document.getElementById('login-password').value,
        }),
      });
      currentRole = role;
      applyRoleToChrome();
      location.hash = '#/list';
      await router();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

document.getElementById('logout-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST' });
  currentRole = null;
  applyRoleToChrome();
  await renderLogin();
});

// ---------- Routing ----------

function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
}

async function router() {
  if (!currentRole) {
    await renderLogin();
    return;
  }

  const hash = location.hash || '#/list';
  const [, route, param] = hash.match(/^#\/(\w+)(?:\/(.+))?$/) || [];

  try {
    if (route === 'list' || !route) {
      setActiveNav('list');
      await renderList();
    } else if (route === 'new') {
      setActiveNav('new');
      await renderForm(null);
    } else if (route === 'edit') {
      setActiveNav('list');
      await renderForm(param);
    } else if (route === 'settings') {
      if (currentRole !== 'admin') {
        toast('Settings is admin-only', true);
        location.hash = '#/list';
        return;
      }
      setActiveNav('settings');
      await renderSettings();
    } else {
      location.hash = '#/list';
    }
  } catch (err) {
    toast(err.message, true);
  }
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', async () => {
  const { role } = await api('/api/me');
  currentRole = role;
  applyRoleToChrome();
  await router();
});

// ---------- List view ----------

async function renderList() {
  const tpl = document.getElementById('tpl-list');
  app.replaceChildren(tpl.content.cloneNode(true));

  const searchInput = document.getElementById('search-input');
  const rowsBody = document.getElementById('challan-rows');
  const emptyState = document.getElementById('empty-state');

  async function load(q) {
    const rows = await api(`/api/challans${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    rowsBody.innerHTML = '';
    emptyState.hidden = rows.length > 0;
    for (const c of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(c.serial_number)}</td>
        <td>${escapeHtml(c.challan_date)}</td>
        <td>${escapeHtml(c.to_contact_name)}</td>
        <td>${formatMoney(c.total)}</td>
        <td class="row-actions">
          <a href="print.html?id=${c.id}" target="_blank">Print</a>
          <a href="#/edit/${c.id}">Edit</a>
          <button type="button" data-delete="${c.id}" class="btn-secondary">Delete</button>
        </td>
      `;
      rowsBody.appendChild(tr);
    }
  }

  rowsBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete]');
    if (!btn) return;
    if (!confirm('Delete this challan? This cannot be undone.')) return;
    try {
      await api(`/api/challans/${btn.dataset.delete}`, { method: 'DELETE' });
      toast('Challan deleted');
      load(searchInput.value.trim());
    } catch (err) {
      toast(err.message, true);
    }
  });

  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => load(searchInput.value.trim()), 200);
  });

  await load('');
}

// ---------- Form view (new / edit) ----------

function renumberItemRows() {
  document.querySelectorAll('#items-body .item-row').forEach((row, idx) => {
    row.querySelector('.item-sl').textContent = idx + 1;
  });
}

function addItemRow(item) {
  const tpl = document.getElementById('tpl-item-row');
  const row = tpl.content.firstElementChild.cloneNode(true);
  const itemsBody = document.getElementById('items-body');

  const name = row.querySelector('.item-name');
  const qty = row.querySelector('.item-qty');
  const price = row.querySelector('.item-price');
  const amount = row.querySelector('.item-amount');

  if (item) {
    name.value = item.item_name || '';
    qty.value = item.quantity ?? 1;
    price.value = item.price ?? 0;
  }

  function recalcRow() {
    const total = (Number(qty.value) || 0) * (Number(price.value) || 0);
    amount.textContent = formatMoney(total);
    recalcGrandTotal();
  }

  qty.addEventListener('input', recalcRow);
  price.addEventListener('input', recalcRow);
  row.querySelector('.remove-item-btn').addEventListener('click', () => {
    row.remove();
    renumberItemRows();
    recalcGrandTotal();
  });

  itemsBody.appendChild(row);
  renumberItemRows();
  recalcRow();
}

function recalcGrandTotal() {
  const rows = document.querySelectorAll('#items-body .item-row');
  let total = 0;
  rows.forEach((row) => {
    const qty = Number(row.querySelector('.item-qty').value) || 0;
    const price = Number(row.querySelector('.item-price').value) || 0;
    total += qty * price;
  });
  const el = document.getElementById('grand-total');
  if (el) el.textContent = formatMoney(total);
}

function collectItems() {
  const rows = document.querySelectorAll('#items-body .item-row');
  const items = [];
  rows.forEach((row) => {
    const item_name = row.querySelector('.item-name').value.trim();
    if (!item_name) return;
    items.push({
      item_name,
      quantity: Number(row.querySelector('.item-qty').value) || 0,
      price: Number(row.querySelector('.item-price').value) || 0,
    });
  });
  return items;
}

async function updateSerialPreview() {
  const serialInput = document.getElementById('f-serial');
  const location = document.getElementById('f-location').value;
  const date = document.getElementById('f-date').value;
  if (!location || !date) {
    serialInput.value = '';
    return;
  }
  try {
    const { serial } = await api(`/api/next-serial-preview?location=${encodeURIComponent(location)}&date=${encodeURIComponent(date)}`);
    serialInput.value = `${serial} (auto-assigned on save)`;
  } catch (_) {
    serialInput.value = '';
  }
}

async function renderForm(id) {
  const tpl = document.getElementById('tpl-form');
  app.replaceChildren(tpl.content.cloneNode(true));

  const isEdit = !!id;
  document.getElementById('form-title').textContent = isEdit ? 'Edit Delivery Challan' : 'New Delivery Challan';

  const locationSelect = document.getElementById('f-location');
  const dateInput = document.getElementById('f-date');
  const serialInput = document.getElementById('f-serial');

  const locations = await api('/api/locations');
  locationSelect.innerHTML = locations
    .map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)} (${escapeHtml(l.code)})</option>`)
    .join('');

  document.getElementById('add-item-btn').addEventListener('click', () => addItemRow());

  let existing = null;
  if (isEdit) {
    existing = await api(`/api/challans/${id}`);
    locationSelect.value = existing.location_code;
    locationSelect.disabled = true;
    dateInput.value = existing.challan_date;
    dateInput.disabled = true;
    serialInput.value = existing.serial_number;
    document.getElementById('f-from-name').value = existing.from_contact_name;
    document.getElementById('f-from-mobile').value = existing.from_contact_mobile;
    document.getElementById('f-from-address').value = existing.from_address;
    document.getElementById('f-to-name').value = existing.to_contact_name;
    document.getElementById('f-to-email').value = existing.to_email;
    document.getElementById('f-to-mobile').value = existing.to_mobile;
    document.getElementById('f-to-address').value = existing.to_address;
    if (existing.items.length) {
      existing.items.forEach(addItemRow);
    } else {
      addItemRow();
    }
  } else {
    dateInput.value = todayISO();
    locationSelect.addEventListener('change', updateSerialPreview);
    dateInput.addEventListener('change', updateSerialPreview);
    addItemRow();
    await updateSerialPreview();
  }

  document.getElementById('challan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = collectItems();
    if (items.length === 0) {
      toast('Add at least one item', true);
      return;
    }
    const payload = {
      challan_date: dateInput.value,
      location_code: locationSelect.value,
      from_contact_name: document.getElementById('f-from-name').value.trim(),
      from_contact_mobile: document.getElementById('f-from-mobile').value.trim(),
      from_address: document.getElementById('f-from-address').value.trim(),
      to_contact_name: document.getElementById('f-to-name').value.trim(),
      to_email: document.getElementById('f-to-email').value.trim(),
      to_mobile: document.getElementById('f-to-mobile').value.trim(),
      to_address: document.getElementById('f-to-address').value.trim(),
      items,
    };
    try {
      if (isEdit) {
        await api(`/api/challans/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Challan updated');
      } else {
        const created = await api('/api/challans', { method: 'POST', body: JSON.stringify(payload) });
        toast(`Challan ${created.serial_number} created`);
      }
      location.hash = '#/list';
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------- Settings view ----------

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function renderSettings() {
  const tpl = document.getElementById('tpl-settings');
  app.replaceChildren(tpl.content.cloneNode(true));

  const [settings, locations] = await Promise.all([api('/api/settings'), api('/api/locations')]);

  document.getElementById('s-company-name').value = settings.company_name;
  document.getElementById('s-company-gstin').value = settings.company_gstin;
  document.getElementById('s-company-address').value = settings.company_address;
  document.getElementById('s-padding').value = settings.seq_padding;

  let currentLogo = settings.company_logo || '';
  const logoPreview = document.getElementById('s-logo-preview');
  function refreshLogoPreview() {
    if (currentLogo) {
      logoPreview.src = currentLogo;
      logoPreview.hidden = false;
    } else {
      logoPreview.hidden = true;
    }
  }
  refreshLogoPreview();

  document.getElementById('s-logo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    currentLogo = await readFileAsDataURL(file);
    refreshLogoPreview();
  });

  document.getElementById('location-list').innerHTML = locations
    .map((l) => `<li>${escapeHtml(l.name)} &mdash; <strong>${escapeHtml(l.code)}</strong></li>`)
    .join('');

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      company_name: document.getElementById('s-company-name').value.trim(),
      company_gstin: document.getElementById('s-company-gstin').value.trim(),
      company_address: document.getElementById('s-company-address').value.trim(),
      company_logo: currentLogo,
      seq_padding: Number(document.getElementById('s-padding').value) || 2,
    };
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
      toast('Settings saved');
    } catch (err) {
      toast(err.message, true);
    }
  });
}
