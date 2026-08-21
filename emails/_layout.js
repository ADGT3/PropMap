/**
 * emails/_layout.js — V77.2
 * Shared HTML/text wrapper for all transactional emails.
 */

export function wrapBaseHtml({ inner, agency_name }) {
  const agency = agency_name || 'Edan Property';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(agency)}</title>
</head>
<body style="margin:0;padding:0;background:#f4efe2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f4efe2;padding:32px 16px;">
    <tr>
      <td align="center">
        <table cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#1a1410;padding:24px 32px;">
              <div style="color:#c4841a;font-size:18px;font-weight:700;letter-spacing:0.04em;">${escapeHtml(agency).toUpperCase()}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;color:#222;font-size:15px;line-height:1.55;">
              ${inner}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;background:#f7f4ec;color:#888;font-size:12px;line-height:1.5;border-top:1px solid #eee;">
              ${escapeHtml(agency)} · This is an automated message. Replies will be received by your agent.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function wrapBaseText({ inner, agency_name }) {
  const agency = agency_name || 'Edan Property';
  return `${agency}\n${'='.repeat(agency.length)}\n\n${inner}\n\n--\n${agency}\nThis is an automated message. Replies will be received by your agent.\n`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
