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

    const updates = [];
    for (const record of allRecords) {
      const f = record.fields || {};
      const nom = (f.Nom || '').toString();
      const nomLower = nom.toLowerCase();
      const newFields = {};

      if (!f.Type || f.Type === '') {
        newFields.Type = nomLower.includes('custom') ? 'Custom' : 'Reproduction';
      }
      if (f.Année === undefined || f.Année === null) {
        newFields.Année = '';
      }
      if (!f.Collection || f.Collection === '') {
        if (nomLower.includes('popy')) newFields.Collection = 'Popy';
        else if (nomLower.includes('action man')) newFields.Collection = 'Palitoy';
        else if (nomLower.includes('action joe')) newFields.Collection = 'Ceji';
        else if (nomLower.includes('mego')) newFields.Collection = 'Mego';
        else if (nomLower.includes('big jim')) newFields.Collection = 'Mattel';
        else if (nomLower.includes('gi joe')) newFields.Collection = 'Hasbro';
        else if (nomLower.includes('meccano')) newFields.Collection = 'Meccano';
        else if (nomLower.includes('palitoy')) newFields.Collection = 'Palitoy';
      }

      if (Object.keys(newFields).length > 0) {
        updates.push({ id: record.id, nom: f.Nom, fields: newFields });
      }
    }

    const results = { updated: 0, errors: [] };
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      try {
        const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}/${u.id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ fields: u.fields })
        });
        if (r.ok) {
          results.updated++;
        } else {
          const err = await r.json();
          results.errors.push({ id: u.id, nom: u.nom, error: err });
        }
        if (i > 0 && i % 5 === 0) {
          await new Promise(res => setTimeout(res, 200));
        }
      } catch (e) {
        results.errors.push({ id: u.id, nom: u.nom, error: e.message });
      }
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        total: allRecords.length,
        updated: results.updated,
        errors: results.errors.length
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
