export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;

  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
    return res.status(500).json({ error: 'Variables manquantes' });
  }

  try {
    let allRecords = [];
    let offset = null;
    let pageCount = 0;
    const MAX_PAGES = 5; // ✅ Limite de sécurité (500 produits max)

    do {
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}?pageSize=100${offset ? '&offset=' + offset : ''}`;

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
      });

      if (!response.ok) {
        return res.status(response.status).json({ error: `Airtable ${response.status}` });
      }

      const data = await response.json();
      allRecords = allRecords.concat(data.records || []);
      offset = data.offset;
      pageCount++;
    } while (offset && pageCount < MAX_PAGES);

    return res.status(200).json(allRecords);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
