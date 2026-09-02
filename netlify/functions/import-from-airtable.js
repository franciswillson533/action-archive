const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Products';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    // 1. Récupérer tous les produits depuis Airtable (1 seul appel)
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}?pageSize=100`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Airtable ${response.status}` })
      };
    }

    const data = await response.json();
    let allRecords = data.records || [];
    let offset = data.offset;

    // Pagination
    while (offset) {
      const nextResponse = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}?pageSize=100&offset=${offset}`,
        { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } }
      );
      if (nextResponse.ok) {
        const nextData = await nextResponse.json();
        allRecords = allRecords.concat(nextData.records || []);
        offset = nextData.offset;
      } else {
        break;
      }
    }

    // 2. Enrichir les produits
    const products = allRecords.map(r => {
      const f = r.fields || {};
      const nom = (f.Nom || '').toString();
      const nomLower = nom.toLowerCase();
      
      if (!f.Type) {
        f.Type = nomLower.includes('custom') ? 'Custom' : 'Reproduction';
      }
      if (f.Année === undefined || f.Année === null) f.Année = '';
      if (!f.Collection) {
        if (nomLower.includes('popy')) f.Collection = 'Popy';
        else if (nomLower.includes('action man')) f.Collection = 'Palitoy';
        else if (nomLower.includes('action joe')) f.Collection = 'Ceji';
        else if (nomLower.includes('mego')) f.Collection = 'Mego';
        else if (nomLower.includes('big jim')) f.Collection = 'Mattel';
        else if (nomLower.includes('gi joe')) f.Collection = 'Hasbro';
        else if (nomLower.includes('meccano')) f.Collection = 'Meccano';
        else if (nomLower.includes('palitoy')) f.Collection = 'Palitoy';
      }
      if (!f.Image && f.Lien) f.Image = f.Lien;
      
      return { id: r.id, fields: f };
    });

    // 3. Sauvegarder dans Netlify Blobs
    const store = getStore('products');
    await store.set('all-products', JSON.stringify({ products, updatedAt: new Date().toISOString() }));

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        total: products.length,
        message: `${products.length} produits importés dans Netlify Blobs`
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
