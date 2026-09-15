export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { action, recordId, fields } = req.body || {};

    let url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME || 'Products'}`;
    let method = 'POST';

    if (action === 'patch' && recordId) {
      url += `/${recordId}`;
      method = 'PATCH';
    } else if (action === 'delete' && recordId) {
      url += `/${recordId}`;
      method = 'DELETE';
    }

    const fetchOptions = {
      method,
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    if (fields && (action === 'patch' || action === 'create')) {
      fetchOptions.body = JSON.stringify({ fields });
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
