exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;

  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Variables Airtable manquantes dans Netlify' })
    };
  }

  try {
    let allRecords = [];
    let offset = null;

    do {
      let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?pageSize=100`;
      if (offset) url += `&offset=${offset}`;

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          statusCode: response.status,
          headers,
          body: JSON.stringify({ error: `Airtable ${response.status}`, details: errText })
        };
      }

      const data = await response.json();
      allRecords = allRecords.concat(data.records || []);
      offset = data.offset;
    } while (offset);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(allRecords)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
