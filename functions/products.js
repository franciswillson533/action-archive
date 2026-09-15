export async function onRequest(context) {
  const request = context.request;
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  // 👉 On appelle directement le proxy au lieu de lire depuis Blobs
  try {
    // Récupère l'URL de base dynamiquement
    const url = new URL(request.url);
    const proxyUrl = `${url.origin}/airtable-proxy`;
    
    const response = await fetch(proxyUrl);
    const data = await response.json();
    
    return new Response(
      JSON.stringify(data),
      { 
        status: 200, 
        headers: { ...headers, 'Cache-Control': 'public, max-age=300' } 
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify([]),
      { status: 200, headers }
    );
  }
}
