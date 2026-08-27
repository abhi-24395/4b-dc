function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatMoney(n) {
  return Number(n || 0).toFixed(2);
}

async function main() {
  const id = new URLSearchParams(location.search).get('id');
  const content = document.getElementById('content');
  if (!id) {
    content.textContent = 'No challan specified.';
    return;
  }

  const [challanRes, settingsRes] = await Promise.all([
    fetch(`/api/challans/${id}`),
    fetch('/api/settings'),
  ]);

  if (!challanRes.ok) {
    content.textContent = 'Challan not found.';
    return;
  }

  const challan = await challanRes.json();
  const settings = await settingsRes.json();

  const total = challan.items.reduce((sum, i) => sum + Number(i.amount || 0), 0);

  document.title = `Delivery Challan ${challan.serial_number}`;

  content.innerHTML = `
    <h1>${escapeHtml(settings.company_name || 'DELIVERY CHALLAN')}</h1>
    <p class="subtitle">${escapeHtml(settings.company_address || '')}${settings.company_gstin ? ` &middot; GSTIN: ${escapeHtml(settings.company_gstin)}` : ''}</p>
    <h2 style="text-align:center;">DELIVERY CHALLAN</h2>

    <div class="header-block">
      <div>
        <div><strong>Serial No:</strong> ${escapeHtml(challan.serial_number)}</div>
        <div><strong>Date:</strong> ${escapeHtml(challan.challan_date)}</div>
        <div><strong>Location:</strong> ${escapeHtml(challan.location_name || challan.location_code)}</div>
      </div>
      <div class="right">
        <div><strong>Vehicle No:</strong> ${escapeHtml(challan.vehicle_number)}</div>
        <div><strong>Place of Supply:</strong> ${escapeHtml(challan.place_of_supply)}</div>
      </div>
    </div>

    <div class="header-block">
      <div>
        <div><strong>Consignee (Party):</strong> ${escapeHtml(challan.party_name)}</div>
        <div>${escapeHtml(challan.party_address)}</div>
        ${challan.party_gstin ? `<div><strong>GSTIN:</strong> ${escapeHtml(challan.party_gstin)}</div>` : ''}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Description</th>
          <th>HSN/SAC</th>
          <th class="num">Qty</th>
          <th>Unit</th>
          <th class="num">Rate</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${challan.items.map((item, idx) => `
          <tr>
            <td>${idx + 1}</td>
            <td>${escapeHtml(item.description)}</td>
            <td>${escapeHtml(item.hsn_code)}</td>
            <td class="num">${item.quantity}</td>
            <td>${escapeHtml(item.unit)}</td>
            <td class="num">${formatMoney(item.rate)}</td>
            <td class="num">${formatMoney(item.amount)}</td>
          </tr>
        `).join('')}
        <tr class="totals-row">
          <td colspan="6" style="text-align:right;">Total</td>
          <td class="num">${formatMoney(total)}</td>
        </tr>
      </tbody>
    </table>

    <div class="remarks"><strong>Remarks:</strong> ${escapeHtml(challan.remarks)}</div>

    <div class="signatures">
      <div>Received By</div>
      <div>Authorized Signatory</div>
    </div>
  `;
}

main().catch((err) => {
  document.getElementById('content').textContent = `Error: ${err.message}`;
});
