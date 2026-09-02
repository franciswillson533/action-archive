exports.handler = async (event) => {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Products';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { action, recordId, fields } = JSON.parse(event.body || '{}');

    let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`;
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
        'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    if (fields && (action === 'patch' || action === 'create')) {
      fetchOptions.body = JSON.stringify({ fields });
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json();
    return {
      statusCode: response.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};
