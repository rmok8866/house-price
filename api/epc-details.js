export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const certId = (req.query.certId || '').trim().replace(/[^0-9\-]/g, '');
  if (!certId) {
    return res.status(400).json({ error: 'Missing certId' });
  }

  const url = `https://find-energy-certificate.service.gov.uk/energy-certificate/${certId}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return res.status(404).json({ error: 'Certificate not found' });
    }

    const html = await response.text();

    // Extract Total floor area
    let floorAreaM2 = null;
    const faMatch = html.match(/Total floor area[\s\S]*?govuk-summary-list__value[^>]*>([\s\S]*?)<\/dd>/i);
    if (faMatch) {
      const numMatch = faMatch[1].match(/([\d\.]+)/);
      if (numMatch) {
        floorAreaM2 = parseFloat(numMatch[1]);
      }
    }

    // Extract Property type
    let propertyType = '';
    const ptMatch = html.match(/Property type[\s\S]*?govuk-summary-list__value[^>]*>([\s\S]*?)<\/dd>/i);
    if (ptMatch) {
      propertyType = ptMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    // Extract Rating
    let rating = '';
    const ratMatch = html.match(/govuk-tag[^>]*>([A-G])<\/span>/i) ||
                     html.match(/current-energy-rating[^>]*>([A-G])<\/span>/i) ||
                     html.match(/epc-rating-result[^\"]*\"[^>]*>([A-G])/i);
    if (ratMatch) {
      rating = ratMatch[1].toUpperCase();
    }

    const floorAreaSqFt = floorAreaM2 ? Math.round(floorAreaM2 * 10.7639) : null;

    return res.status(200).json({
      certId,
      floorAreaM2,
      floorAreaSqFt,
      propertyType,
      rating,
      url
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
