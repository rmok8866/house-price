export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const postcode = (req.query.postcode || '').trim();
  if (!postcode) {
    return res.status(400).json({ error: 'Missing postcode' });
  }

  const cleanPostcode = postcode.replace(/\s+/g, '+').toUpperCase();
  const url = `https://find-energy-certificate.service.gov.uk/find-a-certificate/search-by-postcode?postcode=${encodeURIComponent(cleanPostcode)}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return res.status(200).json({ postcode, total: 0, certificates: [] });
    }

    const html = await response.text();
    const rows = [...html.matchAll(/<tr class="govuk-table__row">([\s\S]*?)<\/tr>/g)];
    const certificates = [];

    for (const r of rows) {
      const rowHtml = r[1];
      const linkMatch = rowHtml.match(/href="(\/energy-certificate\/([\d\-]+))"/);
      const addrMatch = rowHtml.match(/>([^<]+)<\/a>/);
      const ratingMatch = rowHtml.match(/govuk-tag[^>]*>([A-G])<\/span>/);

      if (linkMatch && addrMatch) {
        certificates.push({
          certId: linkMatch[2],
          path: linkMatch[1],
          address: addrMatch[1].trim().replace(/&#39;/g, "'"),
          rating: ratingMatch ? ratingMatch[1] : ''
        });
      }
    }

    return res.status(200).json({
      postcode,
      total: certificates.length,
      certificates
    });
  } catch (err) {
    return res.status(200).json({ postcode, total: 0, certificates: [], error: err.message });
  }
}
