const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Méthode non autorisée' })
    };
  }

  try {
    const { products } = JSON.parse(event.body || '{}');
    
    if (!Array.isArray(products)) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'products doit être un tableau' })
      };
    }

    const store = getStore('products');
    await store.set('all-products', JSON.stringify({ 
      products, 
      updatedAt: new Date().toISOString() 
    }));

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        total: products.length,
        message: `${products.length} produits synchronisés dans Netlify Blobs`
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};
