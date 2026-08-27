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

  const showAmountColumn = challan.items.length > 1;

  document.title = `Delivery Challan ${challan.serial_number}`;

  content.innerHTML = `
    <div class="challan-box">
      <div class="company-row">
        <div class="company-info">
          <h1>${escapeHtml(settings.company_name)}</h1>
          ${settings.company_gstin ? `<p class="gstin">${escapeHtml(settings.company_gstin)}</p>` : ''}
          <p class="address">${escapeHtml(settings.company_address)}</p>
        </div>
        <div class="company-logo-block">
          ${settings.company_logo ? `<img class="company-logo" src="${escapeHtml(settings.company_logo)}" alt="Logo" />` : ''}
          <div class="serial-badge">DC Number: ${escapeHtml(challan.serial_number)}</div>
        </div>
      </div>

      <div class="contact-row">
        <div class="contact-block">
          <p><strong>From:-</strong></p>
          <p>Contact Person Name: ${escapeHtml(challan.from_contact_name)}</p>
          <p>Contact Person Mobile: ${escapeHtml(challan.from_contact_mobile)}</p>
          <p>Address: ${escapeHtml(challan.from_address)}</p>
        </div>
        <div class="contact-block">
          <p><strong>To:-</strong></p>
          <p>Contact Person Name: ${escapeHtml(challan.to_contact_name)}</p>
          ${challan.to_email ? `<p>E-mail: ${escapeHtml(challan.to_email)}</p>` : ''}
          <p>Contact Person Mobile: ${escapeHtml(challan.to_mobile)}</p>
          <p>Address: ${escapeHtml(challan.to_address)}</p>
        </div>
      </div>

      <table class="items-table">
        <thead>
          <tr>
            <th>SL: No</th>
            <th>Item Name</th>
            <th class="num">Qty</th>
            <th class="num">Price</th>
            ${showAmountColumn ? '<th class="num">Amount</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${challan.items.map((item, idx) => `
            <tr>
              <td>${idx + 1}</td>
              <td>${escapeHtml(item.item_name)}</td>
              <td class="num">${item.quantity}</td>
              <td class="num">${formatMoney(item.price)}</td>
              ${showAmountColumn ? `<td class="num">${formatMoney(item.amount)}</td>` : ''}
            </tr>
          `).join('')}
          ${showAmountColumn ? `
            <tr class="totals-row">
              <td colspan="4" style="text-align:right;">Total</td>
              <td class="num">${formatMoney(challan.items.reduce((sum, i) => sum + Number(i.amount || 0), 0))}</td>
            </tr>
          ` : ''}
        </tbody>
      </table>
    </div>
  `;
}

main().catch((err) => {
  document.getElementById('content').textContent = `Error: ${err.message}`;
});
