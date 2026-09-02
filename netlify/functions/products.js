const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const store = getStore('products');
    const data = await store.get('all-products', { type: 'json' });
    
    if (!data || !data.products) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify([])
      };
    }
    
    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify(data.products)
    };
  } catch (error) {
    console.error('Erreur lecture Netlify Blobs:', error);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify([])
    };
  }
};
