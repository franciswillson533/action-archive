export async function onRequest(context) {
  const request = context.request;
  const env = context.env;

  const AIRTABLE_TOKEN = env.AIRTABLE_TOKEN;
  const AIRTABLE_BASE_ID = env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE_NAME = env.AIRTABLE_TABLE_NAME || 'Products';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders });
  }

  // 🔑 Récupération du header (Cloudflare passe les headers en lowercase)
  const adminPassword = request.headers.get('x-admin-password');
  if (adminPassword !== env.ADMIN_PASSWORD) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await request.text();
    const { action, recordId, fields } = JSON.parse(body || '{}');

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
    return new Response(
      JSON.stringify(data),
      { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
