// api/search.js
// Thais -- Web Search Endpoint
// Uses Brave Search API to fetch current information
// Privacy-first: no query logging, no result storage

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, count } = req.body;

  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Query is required' });
  }

  const BRAVE_KEY = process.env.BRAVE_SEARCH_KEY;
  if (!BRAVE_KEY) {
    return res.status(500).json({ error: 'Search not configured' });
  }

  try {
    const params = new URLSearchParams({
      q: query.trim(),
      count: String(Math.min(count || 5, 10)),
      safesearch: 'moderate',
      text_decorations: 'false',
      search_lang: 'en',
    });

    const response = await fetch(
      'https://api.search.brave.com/res/v1/web/search?' + params.toString(),
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_KEY,
        },
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error('Brave API error: ' + err);
    }

    const data = await response.json();

    // Extract just what Thais needs -- clean and minimal
    const results = (data.web && data.web.results ? data.web.results : [])
      .slice(0, count || 5)
      .map(function(r) {
        return {
          title: r.title || '',
          url: r.url || '',
          description: r.description || '',
          age: r.age || '',
        };
      });

    return res.status(200).json({
      query: query.trim(),
      results: results,
      total: data.web && data.web.totalResults ? data.web.totalResults : 0,
    });

  } catch (error) {
    console.error('[search] error:', error.message);
    return res.status(500).json({
      error: 'Search failed. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}
