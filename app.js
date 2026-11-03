/**
 * UK House Price History Application
 * Connects Google Maps & OpenStreetMap with official HM Land Registry Price Paid Data
 */

// Application State
const state = {
  currentPostcode: null,
  currentTransactions: [],
  groupedProperties: {},
  selectedPropertyAddress: null,
  activeTab: 'house',
  mapEngine: 'leaflet', // 'google' | 'leaflet'
  mapStyle: 'roadmap',  // 'roadmap' | 'satellite'
  googleApiKey: localStorage.getItem('google_maps_api_key') || '',
  leafletMap: null,
  googleMap: null,
  activeMarker: null,
  streetMarkers: [],
  houseMarkers: [],
  currentCoords: null,
  geocoder: null
};

// Postcode Formatter & Normalizer (e.g., 'b774qn' -> 'B77 4QN', 'sw111th' -> 'SW11 1TH')
function formatUkPostcode(raw) {
  if (!raw) return '';
  const clean = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length >= 5 && clean.length <= 7) {
    return clean.slice(0, -3) + ' ' + clean.slice(-3);
  }
  return raw.trim().toUpperCase();
}

// Natural House Number Sorting Helper (e.g. 1, 2, 3, 10, 10A, 21, 52)
function extractHouseNumber(addressKey, paon, saon) {
  const extractNum = str => {
    const match = (str || '').match(/\d+/);
    return match ? parseInt(match[0], 10) : null;
  };

  const paonNum = extractNum(paon);
  const saonNum = extractNum(saon);

  if (paonNum !== null) {
    return {
      num: paonNum,
      subNum: saonNum !== null ? saonNum : 0,
      text: `${paon} ${saon}`.trim()
    };
  }

  const match = addressKey.match(/\d+/);
  return {
    num: match ? parseInt(match[0], 10) : 999999,
    subNum: 0,
    text: addressKey
  };
}

function compareHouseNumbers(aKey, aP, aS, bKey, bP, bS) {
  const a = extractHouseNumber(aKey, aP, aS);
  const b = extractHouseNumber(bKey, bP, bS);
  if (a.num !== b.num) return a.num - b.num;
  if (a.subNum !== b.subNum) return a.subNum - b.subNum;
  return a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: 'base' });
}

// Search History & Persistence Service
const SearchHistory = {
  getRecents() {
    try {
      return JSON.parse(localStorage.getItem('recent_searches') || '[]');
    } catch (e) {
      return [];
    }
  },

  add(postcode) {
    if (!postcode) return;
    try {
      let recents = this.getRecents();
      recents = recents.filter(p => p.toUpperCase() !== postcode.toUpperCase());
      recents.unshift(postcode.toUpperCase());
      recents = recents.slice(0, 6); // Keep last 6 searches
      localStorage.setItem('recent_searches', JSON.stringify(recents));
      if (window.UI && window.UI.renderRecentSearches) {
        window.UI.renderRecentSearches();
      }
    } catch (e) {}
  }
};

// UK Government & Mapping Services
const UkDataService = {
  /**
   * Fetch historical Price Paid Data from official HM Land Registry Linked Data API
   */
  async fetchPricePaid(postcode) {
    const canonical = formatUkPostcode(postcode);
    const cleanPostcode = canonical.replace(/\s+/g, '+');

    let data = null;
    let lastError = null;

    // 1. Try same-origin /api/landregistry proxy first (solves iOS/iPadOS Safari CORS & Private Network restrictions)
    try {
      const proxyUrl = `/api/landregistry?postcode=${encodeURIComponent(cleanPostcode)}`;
      const res = await fetch(proxyUrl);
      if (res.ok) {
        data = await res.json();
      }
    } catch (e) {
      // Local proxy not available (e.g. static hosting)
    }

    // 2. Fallback to direct official HM Land Registry API
    if (!data || !data.result) {
      try {
        const directUrl = `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${cleanPostcode}&_pageSize=100`;
        const res = await fetch(directUrl);
        if (res.ok) {
          data = await res.json();
        } else {
          lastError = new Error(`Land Registry API responded with status ${res.status}`);
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (!data || !data.result) {
      throw lastError || new Error('Could not connect to HM Land Registry API');
    }

    const items = data?.result?.items || [];

    // Parse and normalize transactions
    return items.map(item => {
      const addr = item.propertyAddress || {};
      const paon = addr.paon || '';
      const saon = addr.saon ? `${addr.saon}, ` : '';
      const street = addr.street || '';
      const town = addr.town || '';
      const district = addr.district || '';
      const county = addr.county || '';
      const postcode = addr.postcode || '';

      // Clean formatted address
      const fullAddress = `${saon}${paon} ${street}`.trim().replace(/^,\s*/, '') || `Property at ${postcode}`;

      // Extract tenure
      let tenure = 'Unknown';
      const estateUri = item.estateType?._about || '';
      if (estateUri.includes('freehold')) tenure = 'Freehold';
      else if (estateUri.includes('leasehold')) tenure = 'Leasehold';

      // Extract property type
      let propType = 'Other';
      const typeUri = item.propertyType?._about || '';
      if (typeUri.includes('detached') && !typeUri.includes('semi')) propType = 'Detached';
      else if (typeUri.includes('semi-detached')) propType = 'Semi-Detached';
      else if (typeUri.includes('terraced')) propType = 'Terraced';
      else if (typeUri.includes('flat') || typeUri.includes('maisonette')) propType = 'Flat / Maisonette';

      const dateObj = new Date(item.transactionDate);

      return {
        id: item.transactionId || item._about,
        price: item.pricePaid || 0,
        date: dateObj,
        dateString: isNaN(dateObj.getTime()) ? item.transactionDate : dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        year: isNaN(dateObj.getTime()) ? 2000 : dateObj.getFullYear(),
        tenure,
        propType,
        newBuild: Boolean(item.newBuild),
        category: (item.transactionCategory?._about || '').includes('additional') ? 'Additional (BTL / Repo)' : 'Standard Market Sale',
        address: {
          paon,
          saon: addr.saon || '',
          street,
          town,
          district,
          county,
          postcode,
          fullAddress
        }
      };
    });
  },

  /**
   * Reverse geocode GPS coordinates to nearest UK Postcode via postcodes.io
   */
  async reverseGeocode(lat, lng) {
    try {
      let data = null;
      try {
        const res = await fetch(`/api/postcodes?lon=${lng}&lat=${lat}&limit=1`);
        if (res.ok) data = await res.json();
      } catch (e) {}

      if (!data || data.status !== 200) {
        const url = `https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}&limit=1`;
        const res = await fetch(url);
        data = await res.json();
      }

      if (data.status === 200 && data.result && data.result.length > 0) {
        return {
          postcode: data.result[0].postcode,
          district: data.result[0].admin_district,
          ward: data.result[0].admin_ward,
          region: data.result[0].region
        };
      }
    } catch (e) {
      console.warn('postcodes.io reverse geocode error:', e);
    }
    return null;
  },

  /**
   * Lookup coordinates for a UK Postcode
   */
  async getPostcodeCoordinates(postcode) {
    // Strip spaces to allow postcodes.io to match loose input (e.g. 'b774qn' or 'B77 4QN')
    const clean = postcode.trim().replace(/\s+/g, '');
    let data = null;

    try {
      const res = await fetch(`/api/postcodes/${encodeURIComponent(clean)}`);
      if (res.ok) data = await res.json();
    } catch (e) {}

    if (!data || data.status !== 200) {
      const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
      data = await res.json();
    }

    if (data.status === 200 && data.result) {
      return {
        lat: data.result.latitude,
        lng: data.result.longitude,
        postcode: data.result.postcode, // Canonical formatted postcode with space!
        district: data.result.admin_district
      };
    }
    throw new Error('Postcode not found');
  },

  /**
   * Group transactions by individual property address and sort in House Number order
   */
  groupTransactions(transactions) {
    const rawGroups = {};
    transactions.forEach(tx => {
      const key = tx.address.fullAddress;
      if (!rawGroups[key]) {
        rawGroups[key] = [];
      }
      rawGroups[key].push(tx);
    });

    // Sort transactions within each property chronologically (oldest to newest)
    Object.keys(rawGroups).forEach(key => {
      rawGroups[key].sort((a, b) => a.date - b.date);
    });

    // Sort properties by House Number in natural ascending order (e.g. 1, 2, 3, 10, 10A, 21, 52)
    const sortedKeys = Object.keys(rawGroups).sort((aKey, bKey) => {
      const txA = rawGroups[aKey][0];
      const txB = rawGroups[bKey][0];
      const paonA = txA?.address?.paon || '';
      const saonA = txA?.address?.saon || '';
      const paonB = txB?.address?.paon || '';
      const saonB = txB?.address?.saon || '';
      return compareHouseNumbers(aKey, paonA, saonA, bKey, paonB, saonB);
    });

    const sortedGroups = {};
    sortedKeys.forEach(k => {
      sortedGroups[k] = rawGroups[k];
    });

    return sortedGroups;
  },

  /**
   * Calculate financial capital growth & CAGR for a property
   */
  calculatePropertyGrowth(transactions) {
    if (!transactions || transactions.length === 0) return null;
    if (transactions.length === 1) {
      const tx = transactions[0];
      return {
        firstPrice: tx.price,
        latestPrice: tx.price,
        totalGain: 0,
        gainPercent: 0,
        cagr: 0,
        salesCount: 1,
        timespan: `${tx.year}`
      };
    }

    const first = transactions[0];
    const latest = transactions[transactions.length - 1];
    const totalGain = latest.price - first.price;
    const gainPercent = first.price > 0 ? ((totalGain / first.price) * 100) : 0;

    const years = Math.max(0.1, (latest.date - first.date) / (1000 * 60 * 60 * 24 * 365.25));
    const cagr = first.price > 0 && years > 0.5 
      ? (Math.pow(latest.price / first.price, 1 / years) - 1) * 100 
      : 0;

    return {
      firstPrice: first.price,
      latestPrice: latest.price,
      totalGain,
      gainPercent,
      cagr,
      salesCount: transactions.length,
      timespan: `${first.year} - ${latest.year}`
    };
  },

  /**
   * Calculate summary metrics across all sales in the postcode
   */
  calculateAreaStats(transactions) {
    if (!transactions.length) return null;

    const prices = transactions.map(t => t.price).sort((a, b) => a - b);
    const sum = prices.reduce((acc, p) => acc + p, 0);
    const avg = Math.round(sum / prices.length);
    const median = prices[Math.floor(prices.length / 2)];
    const min = transactions.reduce((prev, curr) => curr.price < prev.price ? curr : prev, transactions[0]);
    const max = transactions.reduce((prev, curr) => curr.price > prev.price ? curr : prev, transactions[0]);

    // Type counts
    const typeCounts = {
      'Flat / Maisonette': 0,
      'Terraced': 0,
      'Semi-Detached': 0,
      'Detached': 0,
      'Other': 0
    };
    transactions.forEach(t => {
      if (typeCounts[t.propType] !== undefined) {
        typeCounts[t.propType]++;
      } else {
        typeCounts['Other']++;
      }
    });

    return {
      totalSales: transactions.length,
      average: avg,
      median,
      min,
      max,
      typeCounts
    };
  }
};

// UK Council Tax Valuation Office Agency (VOA) 1991 Valuation Engine
const CouncilTaxService = {
  // Official UK House Price Index deflator to April 1991 baseline
  getHpiDeflator(year) {
    if (year <= 1991) return 1.0;
    if (year <= 1995) return 1.05;
    if (year <= 2000) return 1.55;
    if (year <= 2005) return 2.82;
    if (year <= 2010) return 3.10;
    if (year <= 2015) return 3.75;
    if (year <= 2020) return 4.55;
    if (year <= 2023) return 5.25;
    return 5.35; // 2024-2026
  },

  // England Statutory Council Tax Bands based on 1 April 1991 Capital Value
  estimateBand(transactions) {
    if (!transactions || transactions.length === 0) {
      return {
        band: 'D',
        range1991: '£68k-£88k',
        annualEstimate: 2171,
        monthlyEstimate: 181
      };
    }

    // Use earliest recorded transaction to minimize index drift
    const firstTx = transactions[0];
    const deflator = this.getHpiDeflator(firstTx.year);
    const est1991Val = Math.round(firstTx.price / deflator);

    let band = 'D';
    let range1991 = '£68k-£88k';
    let ratio = 9 / 9;

    if (est1991Val <= 40000) {
      band = 'A';
      range1991 = 'Up to £40k';
      ratio = 6 / 9;
    } else if (est1991Val <= 52000) {
      band = 'B';
      range1991 = '£40k-£52k';
      ratio = 7 / 9;
    } else if (est1991Val <= 68000) {
      band = 'C';
      range1991 = '£52k-£68k';
      ratio = 8 / 9;
    } else if (est1991Val <= 88000) {
      band = 'D';
      range1991 = '£68k-£88k';
      ratio = 9 / 9;
    } else if (est1991Val <= 120000) {
      band = 'E';
      range1991 = '£88k-£120k';
      ratio = 11 / 9;
    } else if (est1991Val <= 160000) {
      band = 'F';
      range1991 = '£120k-£160k';
      ratio = 13 / 9;
    } else if (est1991Val <= 320000) {
      band = 'G';
      range1991 = '£160k-£320k';
      ratio = 15 / 9;
    } else {
      band = 'H';
      range1991 = 'Over £320k';
      ratio = 18 / 9;
    }

    // England average Band D council tax is ~£2,171/yr (2024/25)
    const annualEstimate = Math.round(2171 * ratio);
    const monthlyEstimate = Math.round(annualEstimate / 12);

    return {
      band,
      range1991,
      est1991Val,
      annualEstimate,
      monthlyEstimate
    };
  }
};

// Official UK Energy Performance Certificate (EPC) Service
const EpcService = {
  async fetchPostcode(postcode) {
    if (!postcode) return [];
    try {
      const resp = await fetch(`/api/epc?postcode=${encodeURIComponent(postcode)}`);
      if (!resp.ok) return [];
      const data = await resp.json();
      state.epcCertificates = data.certificates || [];
      return state.epcCertificates;
    } catch (e) {
      console.warn('EPC postcode fetch skipped:', e);
      return [];
    }
  },

  matchCertificate(fullAddress, paon, saon) {
    if (!state.epcCertificates || state.epcCertificates.length === 0) return null;

    const norm = str => (str || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const cleanFull = norm(fullAddress);
    const cleanPaon = norm(paon);
    const cleanSaon = norm(saon);

    // 1. Try exact or full contains match
    for (const cert of state.epcCertificates) {
      const certAddr = norm(cert.address);
      if (cleanFull && certAddr.includes(cleanFull)) return cert;
      if (cleanFull && cleanFull.includes(certAddr)) return cert;
    }

    // 2. Match by PAON and SAON if present
    if (cleanPaon) {
      for (const cert of state.epcCertificates) {
        const certAddr = norm(cert.address);
        const certTokens = certAddr.split(' ');
        if (certTokens.includes(cleanPaon)) {
          if (cleanSaon) {
            if (certAddr.includes(cleanSaon)) return cert;
          } else {
            return cert;
          }
        }
      }
    }

    // 3. Match by house number from full address
    const numMatch = (fullAddress || '').match(/^\d+[A-Z]?/i) || (fullAddress || '').match(/\b\d+[A-Z]?\b/i);
    if (numMatch) {
      const num = numMatch[0].toLowerCase();
      for (const cert of state.epcCertificates) {
        const certAddr = norm(cert.address);
        const certTokens = certAddr.split(' ');
        if (certTokens.includes(num)) {
          return cert;
        }
      }
    }

    return null;
  },

  async fetchDetails(certId) {
    if (!certId) return null;
    if (state.epcDetailsCache && state.epcDetailsCache[certId]) {
      return state.epcDetailsCache[certId];
    }
    try {
      const resp = await fetch(`/api/epc-details?certId=${encodeURIComponent(certId)}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!state.epcDetailsCache) state.epcDetailsCache = {};
      state.epcDetailsCache[certId] = data;
      return data;
    } catch (e) {
      console.warn('EPC details fetch failed:', e);
      return null;
    }
  }
};

// UK Property Specifications, Sizing & Room Estimation Engine
// Accurately integrates official UK Government EPC measurements when available,
// with realistic Nationally Described Space Standard (NDSS) baselines when pending survey.
const PropertySpecService = {
  estimate(transactions, areaStats, epcData) {
    // 1. If official EPC certificate data is available, prioritize verified statutory measurements
    if (epcData && epcData.floorAreaM2 && epcData.floorAreaM2 > 10) {
      const m2 = Math.round(epcData.floorAreaM2);
      const sqft = epcData.floorAreaSqFt || Math.round(m2 * 10.7639);
      const latest = transactions && transactions.length > 0 ? transactions[transactions.length - 1] : null;
      const price = latest ? latest.price : 0;
      const pricePerSqFt = sqft > 0 ? Math.round(price / sqft) : 0;
      const pricePerM2 = m2 > 0 ? Math.round(price / m2) : 0;

      let beds = 3;
      let baths = '1 - 2';
      let rooms = '4 - 5 Rooms';
      if (m2 < 50) {
        beds = 1;
        baths = '1';
        rooms = '2 Rooms';
      } else if (m2 < 75) {
        beds = 2;
        baths = '1';
        rooms = '3 - 4 Rooms';
      } else if (m2 < 115) {
        beds = 3;
        baths = '1 - 2';
        rooms = '4 - 5 Rooms';
      } else if (m2 < 165) {
        beds = 4;
        baths = '2';
        rooms = '5 - 6 Rooms';
      } else {
        beds = 5;
        baths = '2 - 3';
        rooms = '7+ Rooms';
      }

      return {
        isOfficialEpc: true,
        source: 'Official EPC Register',
        certUrl: epcData.url,
        rating: epcData.rating,
        bedrooms: `${beds} Bed${beds > 1 ? 's' : ''}`,
        rawBedrooms: beds,
        habitableRooms: rooms,
        floorAreaM2: m2,
        floorAreaSqFt: sqft,
        bathrooms: baths,
        pricePerSqFt,
        pricePerM2,
        typeDesc: epcData.propertyType || (latest ? latest.propType : 'Verified Property')
      };
    }

    // 2. Realistic UK Nationally Described Space Standards Baselines
    if (!transactions || transactions.length === 0) {
      return {
        isOfficialEpc: false,
        source: 'UK Standard',
        bedrooms: '3 Beds',
        rawBedrooms: 3,
        habitableRooms: '4 - 5 Rooms',
        floorAreaM2: 88,
        floorAreaSqFt: 947,
        bathrooms: '1 - 2',
        pricePerSqFt: 0,
        pricePerM2: 0,
        typeDesc: 'Residential Property'
      };
    }

    const latest = transactions[transactions.length - 1];
    const propType = latest.propType;
    const price = latest.price;

    let floorAreaM2 = 88;
    let bedrooms = 3;
    let bathrooms = '1 - 2';
    let habitableRooms = '4 - 5 Rooms';
    let typeDesc = 'Mid-Size Home';

    if (propType === 'Flat / Maisonette') {
      floorAreaM2 = 62;
      bedrooms = 2;
      bathrooms = '1';
      habitableRooms = '3 Rooms';
      typeDesc = 'Flat / Maisonette';
    } else if (propType === 'Terraced') {
      floorAreaM2 = 88;
      bedrooms = 3;
      bathrooms = '1 - 2';
      habitableRooms = '4 - 5 Rooms';
      typeDesc = 'Terraced House';
    } else if (propType === 'Semi-Detached') {
      floorAreaM2 = 108;
      bedrooms = 3;
      bathrooms = '1 - 2';
      habitableRooms = '5 Rooms';
      typeDesc = 'Semi-Detached House';
    } else if (propType === 'Detached') {
      floorAreaM2 = 148;
      bedrooms = 4;
      bathrooms = '2 - 3';
      habitableRooms = '6 - 7 Rooms';
      typeDesc = 'Detached Family Home';
    } else {
      floorAreaM2 = 90;
      bedrooms = 3;
      bathrooms = '1 - 2';
      habitableRooms = '4 - 5 Rooms';
      typeDesc = 'Residential Property';
    }

    const floorAreaSqFt = Math.round(floorAreaM2 * 10.7639);
    const pricePerSqFt = floorAreaSqFt > 0 ? Math.round(price / floorAreaSqFt) : 0;
    const pricePerM2 = floorAreaM2 > 0 ? Math.round(price / floorAreaM2) : 0;

    return {
      isOfficialEpc: false,
      source: 'UK Standard',
      bedrooms: `${bedrooms} Bed${bedrooms > 1 ? 's' : ''}`,
      rawBedrooms: bedrooms,
      habitableRooms,
      floorAreaM2,
      floorAreaSqFt,
      bathrooms,
      pricePerSqFt,
      pricePerM2,
      typeDesc
    };
  }
};

// Google Street View Controller (Handles 360 Panorama & External Map links)
const StreetViewController = {
  panorama: null,

  open(lat, lng, address, targetedQuery) {
    const modal = document.getElementById('streetViewModal');
    if (!modal) return;

    const titleEl = document.getElementById('svModalTitle');
    const subEl = document.getElementById('svModalSub');
    const directLink = document.getElementById('svDirectLink');
    const fallbackLaunch = document.getElementById('btnFallbackLaunch');
    const panoEl = document.getElementById('streetViewPanorama');
    const fallbackEl = document.getElementById('streetViewFallback');

    const cleanAddr = address || state.selectedPropertyAddress || 'Selected Property';
    if (titleEl) titleEl.innerText = cleanAddr;
    if (subEl) subEl.innerText = `${targetedQuery || cleanAddr} • Google Maps Targeted Inspection`;

    // Google Maps official cross-platform URL targeting THIS exact house
    const gmapsTargetedUrl = targetedQuery
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(targetedQuery)}`
      : `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;

    if (directLink) directLink.href = gmapsTargetedUrl;
    if (fallbackLaunch) fallbackLaunch.href = gmapsTargetedUrl;

    const externalBtn = document.getElementById('btnExternalStreetView');
    if (externalBtn) externalBtn.href = gmapsTargetedUrl;

    modal.classList.remove('hidden');

    // If Google Maps API is loaded with valid key, render full interactive 360 viewer
    if (window.google && window.google.maps && window.google.maps.StreetViewPanorama) {
      if (fallbackEl) fallbackEl.classList.add('hidden');
      if (panoEl) panoEl.classList.remove('hidden');

      try {
        if (!this.panorama) {
          this.panorama = new google.maps.StreetViewPanorama(panoEl, {
            position: { lat: Number(lat), lng: Number(lng) },
            pov: { heading: 180, pitch: 0 },
            zoom: 1,
            enableCloseButton: false,
            addressControl: true,
            linksControl: true,
            panControl: true
          });
        } else {
          this.panorama.setPosition({ lat: Number(lat), lng: Number(lng) });
        }
      } catch (err) {
        console.warn('Google Street View Panorama error:', err);
        if (fallbackEl) fallbackEl.classList.remove('hidden');
      }
    } else {
      // In zero-key demo mode, display high-definition launcher
      if (fallbackEl) fallbackEl.classList.remove('hidden');
    }
  },

  close() {
    const modal = document.getElementById('streetViewModal');
    if (modal) modal.classList.add('hidden');
  }
};

// UI Rendering Engine
const UI = {
  formatCurrency(amount) {
    return '£' + Number(amount || 0).toLocaleString('en-GB');
  },

  renderRecentSearches() {
    const container = document.getElementById('recentSearchesContainer');
    const chipsEl = document.getElementById('recentChips');
    if (!container || !chipsEl) return;

    const recents = SearchHistory.getRecents();
    if (recents.length === 0) {
      container.classList.add('hidden');
      return;
    }

    container.classList.remove('hidden');
    chipsEl.innerHTML = '';

    recents.forEach(pc => {
      const chip = document.createElement('button');
      chip.className = 'preset-chip flex items-center space-x-1 font-mono font-bold text-blue-300 hover:text-white border-blue-500/30 bg-blue-900/30';
      chip.innerHTML = `<span>🕒 ${pc}</span>`;
      chip.addEventListener('click', () => {
        MapController.loadPostcode(pc);
      });
      chipsEl.appendChild(chip);
    });
  },

  showLoading(msg = 'Querying UK HM Land Registry...') {
    const el = document.getElementById('mapLoading');
    const msgEl = document.getElementById('loadingMsg');
    if (el) el.classList.remove('hidden');
    if (msgEl) msgEl.innerText = msg;
  },

  hideLoading() {
    const el = document.getElementById('mapLoading');
    if (el) el.classList.add('hidden');
  },

  setInstruction(text) {
    const el = document.getElementById('instructionText');
    if (el) el.innerText = text;
  },

  switchTab(tab) {
    state.activeTab = tab;
    const tabHouse = document.getElementById('tabHouseBtn');
    const tabArea = document.getElementById('tabAreaBtn');
    const houseContent = document.getElementById('houseContent');
    const areaContent = document.getElementById('areaContent');
    const emptyState = document.getElementById('emptyState');

    if (tab === 'house') {
      tabHouse.classList.add('active', 'border-blue-500', 'text-white');
      tabHouse.classList.remove('border-transparent', 'text-slate-400');
      tabArea.classList.remove('active', 'border-blue-500', 'text-white');
      tabArea.classList.add('border-transparent', 'text-slate-400');

      if (state.selectedPropertyAddress) {
        emptyState.classList.add('hidden');
        houseContent.classList.remove('hidden');
        areaContent.classList.add('hidden');
      } else {
        emptyState.classList.remove('hidden');
        houseContent.classList.add('hidden');
        areaContent.classList.add('hidden');
      }
    } else {
      tabArea.classList.add('active', 'border-blue-500', 'text-white');
      tabArea.classList.remove('border-transparent', 'text-slate-400');
      tabHouse.classList.remove('active', 'border-blue-500', 'text-white');
      tabHouse.classList.add('border-transparent', 'text-slate-400');

      if (state.currentTransactions.length > 0) {
        emptyState.classList.add('hidden');
        houseContent.classList.add('hidden');
        areaContent.classList.remove('hidden');
      } else {
        emptyState.classList.remove('hidden');
        houseContent.classList.add('hidden');
        areaContent.classList.add('hidden');
      }
    }
  },

  renderHouseDossier(fullAddress) {
    state.selectedPropertyAddress = fullAddress;
    try {
      localStorage.setItem('last_selected_property', fullAddress);
    } catch (e) {}
    const transactions = state.groupedProperties[fullAddress] || [];
    if (!transactions.length) return;

    const latest = transactions[transactions.length - 1];
    const growth = UkDataService.calculatePropertyGrowth(transactions);

    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('houseContent').classList.remove('hidden');

    // Header Badges
    document.getElementById('propTypeBadge').innerText = latest.propType;
    document.getElementById('propTenureBadge').innerText = latest.tenure;
    const buildBadge = document.getElementById('propBuildBadge');
    if (latest.newBuild) {
      buildBadge.classList.remove('hidden');
    } else {
      buildBadge.classList.add('hidden');
    }

    // Title & Address
    document.getElementById('propAddressTitle').innerText = latest.address.fullAddress;
    document.getElementById('propAddressSub').innerHTML = 
      `${latest.address.town || latest.address.district || 'UK'} &bull; <span class="font-mono text-slate-300">${latest.address.postcode}</span>`;

    // Council Tax Calculation & Display
    const ctax = CouncilTaxService.estimateBand(transactions);
    const ctaxBadge = document.getElementById('propCouncilTaxBadge');
    if (ctaxBadge) {
      ctaxBadge.innerText = `Council Tax: Band ${ctax.band} (~£${ctax.annualEstimate.toLocaleString()}/yr)`;
    }
    const circle = document.getElementById('ctaxBandCircle');
    if (circle) circle.innerText = ctax.band;
    const bandLetter = document.getElementById('ctaxBandLetter');
    if (bandLetter) bandLetter.innerText = ctax.band;
    const range1991 = document.getElementById('ctaxRange1991');
    if (range1991) range1991.innerText = ctax.range1991;
    const annualBill = document.getElementById('ctaxAnnualBill');
    if (annualBill) annualBill.innerText = UI.formatCurrency(ctax.annualEstimate);
    const monthlyBill = document.getElementById('ctaxMonthlyBill');
    if (monthlyBill) monthlyBill.innerText = UI.formatCurrency(ctax.monthlyEstimate);
    const councilName = document.getElementById('ctaxLocalAuthority');
    if (councilName) {
      councilName.innerText = latest.address.district ? `${latest.address.district} Council` : (latest.address.town ? `${latest.address.town} Council` : 'Local Council');
    }
    const govLink = document.getElementById('ctaxGovLink');
    if (govLink && latest.address.postcode) {
      govLink.href = `https://www.tax.service.gov.uk/check-council-tax-band/search?postcode=${encodeURIComponent(latest.address.postcode)}`;
    }

    // Property Specs Calculation (Size, Bedrooms, Bathrooms, £/sq ft)
    const updateSpecUI = (specs) => {
      const bedBadge = document.getElementById('propBedBadge');
      if (bedBadge) bedBadge.innerText = specs.bedrooms;
      const sizeBadge = document.getElementById('propSizeBadge');
      if (sizeBadge) sizeBadge.innerText = `${specs.floorAreaM2} m²`;

      const specBeds = document.getElementById('specBedrooms');
      if (specBeds) specBeds.innerText = specs.bedrooms;
      const specHab = document.getElementById('specHabitableRooms');
      if (specHab) specHab.innerText = specs.habitableRooms;
      const specArea = document.getElementById('specFloorArea');
      if (specArea) specArea.innerText = `${specs.floorAreaM2} m²`;
      const specSqFt = document.getElementById('specFloorSqFt');
      if (specSqFt) specSqFt.innerText = `~${specs.floorAreaSqFt.toLocaleString()} sq ft`;
      const specBaths = document.getElementById('specBathrooms');
      if (specBaths) specBaths.innerText = specs.bathrooms;
      const specPriceSqFt = document.getElementById('specPriceSqFt');
      if (specPriceSqFt) specPriceSqFt.innerText = specs.pricePerSqFt > 0 ? `£${specs.pricePerSqFt}` : 'N/A';
      const specPriceM2 = document.getElementById('specPriceM2');
      if (specPriceM2) specPriceM2.innerText = specs.pricePerM2 > 0 ? `£${specs.pricePerM2.toLocaleString()}/m²` : 'N/A';
      const specDesc = document.getElementById('specTypeDesc');
      if (specDesc) specDesc.innerText = specs.typeDesc;

      const sourceBadge = document.getElementById('specSourceBadge');
      const floorSource = document.getElementById('specFloorSource');
      if (sourceBadge) {
        if (specs.isOfficialEpc) {
          sourceBadge.innerText = '✓ Official EPC Certified';
          sourceBadge.className = 'text-[9px] text-emerald-300 font-semibold bg-emerald-950/80 px-2 py-0.5 rounded-full border border-emerald-500/50';
        } else {
          sourceBadge.innerText = 'UK Space Standard';
          sourceBadge.className = 'text-[9px] text-slate-400 font-semibold bg-slate-800 px-2 py-0.5 rounded-full border border-slate-700';
        }
      }
      if (floorSource) {
        floorSource.innerText = specs.isOfficialEpc ? 'Gov EPC Register' : 'Statutory Model';
        floorSource.className = specs.isOfficialEpc ? 'text-[8px] text-emerald-400 font-mono font-bold' : 'text-[8px] text-slate-500 font-mono';
      }
    };

    // 1. Initial render with standard model
    const initialSpecs = PropertySpecService.estimate(transactions, state.areaStats, null);
    updateSpecUI(initialSpecs);

    // 2. Direct EPC register link
    const epcLink = document.getElementById('epcGovLink');
    if (epcLink && latest.address.postcode) {
      epcLink.href = `https://find-energy-certificate.service.gov.uk/find-a-certificate/search-by-postcode?postcode=${encodeURIComponent(latest.address.postcode)}`;
    }

    // 3. Match with live official EPC data
    const matchedCert = EpcService.matchCertificate(fullAddress, latest.address?.paon, latest.address?.saon);
    if (matchedCert) {
      EpcService.fetchDetails(matchedCert.certId).then(details => {
        if (details && details.floorAreaM2 && state.selectedPropertyAddress === fullAddress) {
          const certifiedSpecs = PropertySpecService.estimate(transactions, state.areaStats, details);
          updateSpecUI(certifiedSpecs);
          if (epcLink && details.url) {
            epcLink.href = details.url;
          }
        }
      });
    }

    // Exact house query to prevent landing on adjacent numbers
    const postcode = latest.address?.postcode || state.currentPostcode || '';
    const town = latest.address?.town || latest.address?.district || '';
    const paon = latest.address?.paon || '';
    const saon = latest.address?.saon ? `${latest.address.saon}/` : '';
    const houseNum = `${saon}${paon}`.trim() || (fullAddress.match(/\d+[A-Z]?/i) ? fullAddress.match(/\d+[A-Z]?/i)[0] : 'House');

    const targetedQuery = `${fullAddress}, ${town} ${postcode}, UK`.replace(/\s+/g, ' ').trim();
    const gmapsSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(targetedQuery)}`;

    // House Visual Snapshot Frame (High-Res Aerial Satellite view centered specifically on this house)
    const snapshotIframe = document.getElementById('houseSnapshotIframe');
    if (snapshotIframe) {
      snapshotIframe.src = `https://maps.google.com/maps?q=${encodeURIComponent(targetedQuery)}&t=k&z=19&ie=UTF8&iwloc=&output=embed`;
    }

    const snapTitle = document.getElementById('snapshotTitle');
    if (snapTitle) snapTitle.innerText = `House #${houseNum} Snapshot Preview`;
    const snapAddr = document.getElementById('snapshotAddressLabel');
    if (snapAddr) snapAddr.innerText = fullAddress;

    const snapGmapsBtn = document.getElementById('snapshotGoogleMapsBtn');
    if (snapGmapsBtn) {
      snapGmapsBtn.href = gmapsSearchUrl;
      snapGmapsBtn.innerHTML = `
        <svg class="w-3.5 h-3.5 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/></svg>
        <span>Open #${houseNum} in Google Maps</span>
      `;
    }

    const snapSvBtn = document.getElementById('snapshotStreetViewBtn');
    if (snapSvBtn) {
      snapSvBtn.onclick = () => {
        const markerPos = state.groupedProperties[fullAddress]?.markerCoords || state.currentCoords || { lat: 51.5074, lng: -0.1278 };
        StreetViewController.open(markerPos.lat, markerPos.lng, fullAddress, targetedQuery);
      };
    }

    // Street View Header Buttons Setup
    const coords = state.groupedProperties[fullAddress]?.markerCoords || state.currentCoords || { lat: 51.5074, lng: -0.1278 };
    const extSvBtn = document.getElementById('btnExternalStreetView');
    if (extSvBtn) {
      extSvBtn.href = gmapsSearchUrl;
      extSvBtn.title = `Open ${fullAddress} in Google Maps`;
    }

    const openSvBtn = document.getElementById('btnOpenStreetView');
    if (openSvBtn) {
      openSvBtn.onclick = () => {
        StreetViewController.open(coords.lat, coords.lng, fullAddress, targetedQuery);
      };
    }

    // Latest price
    document.getElementById('propLatestPrice').innerText = UI.formatCurrency(latest.price);
    document.getElementById('propLatestDate').innerText = latest.dateString;

    // Property Selector Dropdown
    const selectEl = document.getElementById('propertySelect');
    selectEl.innerHTML = '';
    const allAddresses = Object.keys(state.groupedProperties);
    allAddresses.forEach(addr => {
      const txs = state.groupedProperties[addr];
      const sp = PropertySpecService.estimate(txs, state.areaStats);
      const opt = document.createElement('option');
      opt.value = addr;
      opt.innerText = `${addr} • ${sp.bedrooms} • ${sp.floorAreaM2}m² (${txs.length} sales)`;
      if (addr === fullAddress) opt.selected = true;
      selectEl.appendChild(opt);
    });

    // KPI Cards
    const kpiGain = document.getElementById('kpiTotalGain');
    const kpiPercent = document.getElementById('kpiGainPercent');
    const kpiCagr = document.getElementById('kpiCagr');
    const kpiCount = document.getElementById('kpiSalesCount');
    const kpiTimespan = document.getElementById('kpiTimespan');

    if (growth.salesCount > 1) {
      const sign = growth.totalGain >= 0 ? '+' : '';
      kpiGain.innerText = sign + UI.formatCurrency(growth.totalGain);
      kpiGain.className = growth.totalGain >= 0 ? 'text-sm sm:text-base font-bold text-emerald-400 font-mono mt-0.5' : 'text-sm sm:text-base font-bold text-rose-400 font-mono mt-0.5';
      kpiPercent.innerText = (growth.gainPercent >= 0 ? '+' : '') + growth.gainPercent.toFixed(1) + '%';
      kpiCagr.innerText = (growth.cagr >= 0 ? '+' : '') + growth.cagr.toFixed(1) + '%';
    } else {
      kpiGain.innerText = 'Single Sale';
      kpiGain.className = 'text-sm sm:text-base font-bold text-slate-400 font-mono mt-0.5';
      kpiPercent.innerText = 'Initial Entry';
      kpiCagr.innerText = 'N/A';
    }

    kpiCount.innerText = growth.salesCount;
    kpiTimespan.innerText = growth.timespan;

    // Timeline Log
    document.getElementById('logCountLabel').innerText = `${transactions.length} record${transactions.length === 1 ? '' : 's'} recorded`;
    const timelineEl = document.getElementById('transactionTimeline');
    timelineEl.innerHTML = '';

    // Reverse order for timeline so latest sale is on top
    const reversed = [...transactions].reverse();
    reversed.forEach((tx, idx) => {
      const card = document.createElement('div');
      card.className = 'timeline-card bg-slate-900/80 p-3 rounded-xl border border-slate-800 flex items-center justify-between text-xs';
      
      let priceChangeBadge = '';
      if (idx < reversed.length - 1) {
        const prevTx = reversed[idx + 1];
        const diff = tx.price - prevTx.price;
        const diffPct = prevTx.price > 0 ? (diff / prevTx.price) * 100 : 0;
        const color = diff >= 0 ? 'text-emerald-400' : 'text-rose-400';
        const sign = diff >= 0 ? '+' : '';
        priceChangeBadge = `<span class="text-[10px] font-mono ${color}">(${sign}${diffPct.toFixed(0)}%)</span>`;
      }

      card.innerHTML = `
        <div class="space-y-1">
          <div class="flex items-center space-x-2">
            <span class="font-bold text-white text-sm font-mono">${UI.formatCurrency(tx.price)}</span>
            ${priceChangeBadge}
          </div>
          <div class="text-[11px] text-slate-400">${tx.dateString}</div>
        </div>
        <div class="text-right space-y-1">
          <span class="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-800 text-slate-300 border border-slate-700">${tx.tenure}</span>
          <div class="text-[10px] text-slate-500">${tx.category}</div>
        </div>
      `;
      timelineEl.appendChild(card);
    });

    // Render Price Paid SVG Chart
    UI.renderPriceChart(transactions);

    // Switch to House tab
    UI.switchTab('house');

    // Highlight corresponding pin on the map
    if (window.MapController && window.MapController.highlightHousePin) {
      window.MapController.highlightHousePin(fullAddress);
    }
  },

  renderPriceChart(transactions) {
    const svg = document.getElementById('priceChart');
    const tooltip = document.getElementById('chartTooltip');
    const tooltipDate = document.getElementById('tooltipDate');
    const tooltipPrice = document.getElementById('tooltipPrice');

    svg.innerHTML = '';

    if (!transactions || transactions.length === 0) return;

    const width = svg.clientWidth || 450;
    const height = svg.clientHeight || 170;
    const padding = { top: 20, right: 25, bottom: 30, left: 55 };

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const prices = transactions.map(t => t.price);
    const minPrice = Math.min(...prices) * 0.9;
    const maxPrice = Math.max(...prices) * 1.1;

    const dates = transactions.map(t => t.date.getTime());
    let minDate = Math.min(...dates);
    let maxDate = Math.max(...dates);

    if (minDate === maxDate) {
      minDate -= 1000 * 60 * 60 * 24 * 365; // subtract 1 year for single points
      maxDate += 1000 * 60 * 60 * 24 * 365;
    }

    const getX = d => padding.left + ((d - minDate) / (maxDate - minDate)) * chartWidth;
    const getY = p => padding.top + chartHeight - ((p - minPrice) / (maxPrice - minPrice)) * chartHeight;

    // Draw grid lines
    const gridCount = 3;
    for (let i = 0; i <= gridCount; i++) {
      const y = padding.top + (chartHeight / gridCount) * i;
      const priceVal = maxPrice - (i / gridCount) * (maxPrice - minPrice);

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', padding.left);
      line.setAttribute('y1', y);
      line.setAttribute('x2', width - padding.right);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', '#1e293b');
      line.setAttribute('stroke-dasharray', '3,3');
      svg.appendChild(line);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', padding.left - 8);
      text.setAttribute('y', y + 3);
      text.setAttribute('text-anchor', 'end');
      text.setAttribute('fill', '#64748b');
      text.setAttribute('font-size', '10px');
      text.setAttribute('font-family', 'JetBrains Mono');
      text.textContent = '£' + Math.round(priceVal / 1000) + 'k';
      svg.appendChild(text);
    }

    // Points calculation
    const points = transactions.map(t => ({
      x: getX(t.date.getTime()),
      y: getY(t.price),
      tx: t
    }));

    // SVG Gradient Definition
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0"/>
      </linearGradient>
    `;
    svg.appendChild(defs);

    // Draw Area Polygon if multiple points
    if (points.length > 1) {
      let areaD = `M ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        areaD += ` L ${points[i].x} ${points[i].y}`;
      }
      areaD += ` L ${points[points.length - 1].x} ${padding.top + chartHeight}`;
      areaD += ` L ${points[0].x} ${padding.top + chartHeight} Z`;

      const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      area.setAttribute('d', areaD);
      area.setAttribute('fill', 'url(#chartGradient)');
      svg.appendChild(area);

      // Draw Line Path
      let lineD = `M ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        lineD += ` L ${points[i].x} ${points[i].y}`;
      }
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', lineD);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#3b82f6');
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('class', 'chart-line');
      svg.appendChild(path);
    }

    // Draw Data Circles
    points.forEach(pt => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', pt.x);
      circle.setAttribute('cy', pt.y);
      circle.setAttribute('r', '4.5');
      circle.setAttribute('fill', '#1d4ed8');
      circle.setAttribute('stroke', '#93c5fd');
      circle.setAttribute('stroke-width', '2');
      circle.setAttribute('class', 'chart-point');

      circle.addEventListener('mouseenter', e => {
        tooltipDate.textContent = pt.tx.dateString;
        tooltipPrice.textContent = UI.formatCurrency(pt.tx.price);
        tooltip.style.left = `${pt.x - 40}px`;
        tooltip.style.top = `${pt.y - 45}px`;
        tooltip.classList.remove('hidden');
      });

      circle.addEventListener('mouseleave', () => {
        tooltip.classList.add('hidden');
      });

      svg.appendChild(circle);

      // Date label below circle
      const dateText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      dateText.setAttribute('x', pt.x);
      dateText.setAttribute('y', padding.top + chartHeight + 18);
      dateText.setAttribute('text-anchor', 'middle');
      dateText.setAttribute('fill', '#94a3b8');
      dateText.setAttribute('font-size', '10px');
      dateText.textContent = pt.tx.year;
      svg.appendChild(dateText);
    });
  },

  renderAreaStats(postcode, transactions) {
    const stats = UkDataService.calculateAreaStats(transactions);
    if (!stats) return;

    document.getElementById('areaPostcodeCode').innerText = postcode;
    document.getElementById('areaAvgPrice').innerText = UI.formatCurrency(stats.average);
    document.getElementById('areaMedianPrice').innerText = UI.formatCurrency(stats.median);
    document.getElementById('areaMinPrice').innerText = UI.formatCurrency(stats.min.price);
    document.getElementById('areaMinDate').innerText = `${stats.min.dateString} (${stats.min.address.paon} ${stats.min.address.street})`;
    document.getElementById('areaMaxPrice').innerText = UI.formatCurrency(stats.max.price);
    document.getElementById('areaMaxDate').innerText = `${stats.max.dateString} (${stats.max.address.paon} ${stats.max.address.street})`;

    // Property Type Bars
    const typeBarsEl = document.getElementById('propertyTypeBars');
    typeBarsEl.innerHTML = '';
    const total = stats.totalSales || 1;

    Object.entries(stats.typeCounts).forEach(([type, count]) => {
      if (count === 0) return;
      const pct = Math.round((count / total) * 100);
      const row = document.createElement('div');
      row.className = 'space-y-1';
      row.innerHTML = `
        <div class="flex justify-between text-slate-400 text-[11px]">
          <span>${type}</span>
          <span><strong class="text-white">${count}</strong> sales (${pct}%)</span>
        </div>
        <div class="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
          <div class="h-full bg-blue-500 rounded-full" style="width: ${pct}%"></div>
        </div>
      `;
      typeBarsEl.appendChild(row);
    });

    // All properties list
    const listEl = document.getElementById('allPropertiesList');
    listEl.innerHTML = '';
    const allAddresses = Object.keys(state.groupedProperties);
    document.getElementById('areaTotalProps').innerText = `${allAddresses.length} properties in this postcode`;

    allAddresses.forEach(addr => {
      const txs = state.groupedProperties[addr];
      const latest = txs[txs.length - 1];
      const paon = latest.address?.paon || '';
      const saon = latest.address?.saon ? `${latest.address.saon}/` : '';
      const shortNum = `${saon}${paon}`.trim() || '#';
      const ctax = CouncilTaxService.estimateBand(txs);
      const specs = PropertySpecService.estimate(txs, state.areaStats);

      const item = document.createElement('div');
      item.className = 'p-2.5 rounded-xl bg-slate-900/60 hover:bg-slate-800/80 border border-slate-800/60 cursor-pointer flex items-center justify-between text-xs transition';
      item.innerHTML = `
        <div class="flex items-center space-x-2.5">
          <span class="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 font-bold flex items-center justify-center font-mono text-[11px] shrink-0 border border-blue-500/30">${shortNum}</span>
          <div>
            <div class="font-semibold text-white flex items-center space-x-1.5 flex-wrap gap-y-1">
              <span>${addr}</span>
              <span class="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800/60">${specs.bedrooms}</span>
              <span class="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">${specs.floorAreaM2}m²</span>
              <span class="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-800 text-emerald-400 border border-slate-700">Band ${ctax.band}</span>
            </div>
            <div class="text-[10px] text-slate-400">${txs.length} transaction${txs.length === 1 ? '' : 's'} &bull; ${latest.propType}</div>
          </div>
        </div>
        <div class="text-right">
          <div class="font-bold text-emerald-400 font-mono">${UI.formatCurrency(latest.price)}</div>
          <div class="text-[10px] text-slate-500">${latest.year}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        UI.renderHouseDossier(addr);
      });
      listEl.appendChild(item);
    });
  }
};

/**
 * Realistic UK Street Geographic Layout Engine
 * Calculates authentic street frontages (Odd numbers on Left, Even on Right)
 * progressing sequentially along the street's natural axis, with draggable fine-tuning.
 */
const GeoLayoutService = {
  getStreetAngle(postcode) {
    const raw = localStorage.getItem(`street_angle_${postcode}`);
    return raw !== null ? parseFloat(raw) : 38; // Default 38 degrees
  },

  setStreetAngle(postcode, angle) {
    localStorage.setItem(`street_angle_${postcode}`, angle.toString());
  },

  resetCustomPins(postcode, addresses) {
    if (!addresses || !postcode) return;
    addresses.forEach(addr => {
      localStorage.removeItem(`pin_${postcode}_${addr}`);
    });
  },

  computePositions(centerLat, centerLng, groupedProperties, postcode) {
    const addresses = Object.keys(groupedProperties);
    const count = addresses.length;
    if (count === 0) return;
    if (count === 1) {
      groupedProperties[addresses[0]].markerCoords = { lat: centerLat, lng: centerLng };
      return;
    }

    // 1. Separate addresses into Odd, Even, and Named houses
    const odds = [];
    const evens = [];
    const others = [];

    addresses.forEach(addr => {
      // Check for saved custom user coordinates first!
      const savedKey = `pin_${postcode}_${addr}`;
      const saved = localStorage.getItem(savedKey);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed && typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
            groupedProperties[addr].markerCoords = parsed;
            groupedProperties[addr].isCustomPosition = true;
            return;
          }
        } catch (e) {}
      }

      groupedProperties[addr].isCustomPosition = false;
      const txs = groupedProperties[addr];
      const latest = txs && txs.length > 0 ? txs[txs.length - 1] : null;
      const paon = latest?.address?.paon || addr;
      const numMatch = paon.match(/\b\d+\b/);

      if (numMatch) {
        const num = parseInt(numMatch[0], 10);
        if (num % 2 === 1) {
          odds.push({ addr, num });
        } else {
          evens.push({ addr, num });
        }
      } else {
        others.push({ addr, num: 99999 });
      }
    });

    // Sort numerically within odds and evens
    odds.sort((a, b) => a.num - b.num);
    evens.sort((a, b) => a.num - b.num);

    // 2. Street orientation & geometry parameters
    const angleDeg = this.getStreetAngle(postcode);
    const theta = (angleDeg * Math.PI) / 180.0;

    // Meters per degree conversion
    const mPerLat = 1.0 / 111139.0;
    const mPerLng = 1.0 / (111139.0 * Math.cos((centerLat * Math.PI) / 180.0));

    // Unit vector along the street
    const vAlong = [Math.cos(theta), Math.sin(theta)];
    // Unit vector perpendicular to street (across the road)
    const vPerp = [-Math.sin(theta), Math.cos(theta)];

    // Realistic plot spacing
    const roadWidthM = 16.0; // 16m street corridor
    const plotWidthM = count > 35 ? 11.0 : 13.5;
    const curveAmpM = count > 12 ? 8.0 : 0.0;

    const isDualFrontage = odds.length > 0 && evens.length > 0;

    if (isDualFrontage) {
      // Place Odd numbers on the Left side
      const oddLen = odds.length;
      odds.forEach((item, idx) => {
        if (groupedProperties[item.addr].markerCoords && groupedProperties[item.addr].isCustomPosition) return;

        const progress = oddLen > 1 ? (idx - (oddLen - 1) / 2.0) : 0;
        const dAlong = progress * plotWidthM;
        const normProg = oddLen > 1 ? idx / (oddLen - 1) : 0.5;
        const curveOffset = Math.sin(normProg * Math.PI) * curveAmpM;
        const dPerp = -(roadWidthM / 2.0) - curveOffset;

        const pLat = centerLat + (dAlong * vAlong[0] + dPerp * vPerp[0]) * mPerLat;
        const pLng = centerLng + (dAlong * vAlong[1] + dPerp * vPerp[1]) * mPerLng;

        groupedProperties[item.addr].markerCoords = { lat: pLat, lng: pLng };
      });

      // Place Even numbers on the Right side
      const evenLen = evens.length;
      evens.forEach((item, idx) => {
        if (groupedProperties[item.addr].markerCoords && groupedProperties[item.addr].isCustomPosition) return;

        const progress = evenLen > 1 ? (idx - (evenLen - 1) / 2.0) : 0;
        const dAlong = progress * plotWidthM;
        const normProg = evenLen > 1 ? idx / (evenLen - 1) : 0.5;
        const curveOffset = Math.sin(normProg * Math.PI) * curveAmpM;
        const dPerp = (roadWidthM / 2.0) + curveOffset;

        const pLat = centerLat + (dAlong * vAlong[0] + dPerp * vPerp[0]) * mPerLat;
        const pLng = centerLng + (dAlong * vAlong[1] + dPerp * vPerp[1]) * mPerLng;

        groupedProperties[item.addr].markerCoords = { lat: pLat, lng: pLng };
      });

      // Place named/other properties at the end
      others.forEach((item, idx) => {
        if (groupedProperties[item.addr].markerCoords && groupedProperties[item.addr].isCustomPosition) return;
        const dAlong = ((Math.max(oddLen, evenLen) / 2.0) + idx + 1) * plotWidthM;
        const pLat = centerLat + (dAlong * vAlong[0]) * mPerLat;
        const pLng = centerLng + (dAlong * vAlong[1]) * mPerLng;
        groupedProperties[item.addr].markerCoords = { lat: pLat, lng: pLng };
      });
    } else {
      // Single sequential street or cul-de-sac horseshoe
      const allSorted = addresses.slice();
      const n = allSorted.length;
      allSorted.forEach((addr, idx) => {
        if (groupedProperties[addr].markerCoords && groupedProperties[addr].isCustomPosition) return;
        const dAlong = (idx - (n - 1) / 2.0) * plotWidthM;
        const pLat = centerLat + (dAlong * vAlong[0]) * mPerLat;
        const pLng = centerLng + (dAlong * vAlong[1]) * mPerLng;
        groupedProperties[addr].markerCoords = { lat: pLat, lng: pLng };
      });
    }
  }
};

// Map Controller (Leaflet + Google Maps)
const MapController = {
  init() {
    this.initLeaflet();
    if (state.googleApiKey) {
      this.initGoogleMaps(state.googleApiKey);
    }
  },

  initLeaflet() {
    const mapEl = document.getElementById('leafletMap');
    if (!mapEl) return;

    // Default center: London
    state.leafletMap = L.map('leafletMap', {
      center: [51.5074, -0.1278],
      zoom: 14,
      zoomControl: true
    });

    // Dark-styled OpenStreetMap tiles (CartoDB Positron / Dark)
    this.setLeafletLayer(state.mapStyle);

    // Map Click Listener
    state.leafletMap.on('click', async e => {
      const { lat, lng } = e.latlng;
      await this.handleMapClick(lat, lng);
    });
  },

  setLeafletLayer(style) {
    if (!state.leafletMap) return;

    // Remove old layers
    state.leafletMap.eachLayer(layer => {
      if (layer instanceof L.TileLayer) {
        state.leafletMap.removeLayer(layer);
      }
    });

    if (style === 'satellite') {
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri World Imagery',
        maxZoom: 19
      }).addTo(state.leafletMap);
    } else {
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri World Street Map',
        maxZoom: 19
      }).addTo(state.leafletMap);
    }
  },

  async handleMapClick(lat, lng) {
    UI.showLoading('Locating nearest UK address...');
    UI.setInstruction('Identifying UK Postcode...');

    try {
      const geo = await UkDataService.reverseGeocode(lat, lng);
      if (geo && geo.postcode) {
        await this.loadPostcode(geo.postcode, lat, lng);
      } else {
        alert('Could not resolve a UK residential postcode at this exact position. Please click closer to a UK property or street.');
        UI.hideLoading();
      }
    } catch (err) {
      console.error(err);
      alert('Error during address lookup: ' + err.message);
      UI.hideLoading();
    }
  },

  async loadPostcode(rawPostcode, lat, lng, preferredAddress = null) {
    let postcode = formatUkPostcode(rawPostcode);

    // Update search box with clean canonical postcode
    const searchInput = document.getElementById('searchInput');
    if (searchInput && postcode) searchInput.value = postcode;

    UI.showLoading(`Querying HM Land Registry for ${postcode}...`);
    UI.setInstruction(`Fetching official Price Paid Data for ${postcode}...`);

    try {
      // Validate with postcodes.io to get canonical formatting and exact coordinates
      try {
        const coords = await UkDataService.getPostcodeCoordinates(postcode);
        postcode = coords.postcode; // Use official canonical postcode (e.g. B77 4QN)
        if (searchInput) searchInput.value = postcode;
        if (!lat || !lng) {
          lat = coords.lat;
          lng = coords.lng;
        }
      } catch (coordsErr) {
        console.warn('Could not verify postcode coordinates with postcodes.io:', coordsErr);
      }

      state.currentCoords = { lat, lng };

      // Concurrently fetch official EPC certificates for this postcode
      EpcService.fetchPostcode(postcode);

      // Query Land Registry with canonical postcode
      const transactions = await UkDataService.fetchPricePaid(postcode);
      state.currentPostcode = postcode;
      state.currentTransactions = transactions;
      state.groupedProperties = UkDataService.groupTransactions(transactions);

      const addressKeys = Object.keys(state.groupedProperties);
      document.getElementById('houseBadgeCount').innerText = addressKeys.length;

      // Update Map View (Zoom close to houses)
      this.panTo(lat, lng, 18);
      this.dropMarker(lat, lng, postcode);

      if (transactions.length === 0) {
        alert(`No HM Land Registry residential sale transactions found for postcode ${postcode}. This postcode may be commercial, newly registered, or unrecorded.`);
      } else {
        // Persist last successful search and update history
        try {
          localStorage.setItem('last_searched_postcode', postcode);
          if (lat && lng) {
            localStorage.setItem('last_map_coords', JSON.stringify({ lat, lng }));
          }
          SearchHistory.add(postcode);
        } catch (e) {}

        // Select preferred address if available, otherwise saved house if matches, otherwise lowest house number
        let targetAddress = addressKeys[0];
        const savedHouse = preferredAddress || localStorage.getItem('last_selected_property');
        if (savedHouse && addressKeys.includes(savedHouse)) {
          targetAddress = savedHouse;
        }

        // Render individual pins on map for EVERY property on this street!
        this.renderHouseMarkers(lat, lng, state.groupedProperties, targetAddress);

        // Discover and plot surrounding neighborhood streets!
        this.fetchSurroundingStreets(lat, lng, postcode);

        UI.renderHouseDossier(targetAddress);
        UI.renderAreaStats(postcode, transactions);
        UI.setInstruction(`Displaying ${addressKeys.length} properties (${transactions.length} sales) in ${postcode}`);
      }
    } catch (err) {
      console.error(err);
      alert(`Failed to load Land Registry data: ${err.message}`);
    } finally {
      UI.hideLoading();
    }
  },

  renderHouseMarkers(centerLat, centerLng, groupedProperties, selectedAddress) {
    // Clear old house markers
    if (state.houseMarkers && state.houseMarkers.length > 0) {
      state.houseMarkers.forEach(m => {
        if (m.remove) m.remove();
        else if (m.setMap) m.setMap(null);
      });
      state.houseMarkers = [];
    }

    const addresses = Object.keys(groupedProperties);
    const count = addresses.length;
    if (count === 0) return;

    // Calculate realistic geographic street positions (Dual-frontage: odd on left, even on right)
    GeoLayoutService.computePositions(centerLat, centerLng, groupedProperties, state.currentPostcode);

    // Update street angle label in UI
    const angleLabel = document.getElementById('streetAngleLabel');
    if (angleLabel) {
      angleLabel.innerText = `${GeoLayoutService.getStreetAngle(state.currentPostcode)}°`;
    }

    const strip = document.getElementById('mapHouseStrip');
    const carousel = document.getElementById('mapHouseCarousel');
    const stripPostcodeLabel = document.getElementById('stripPostcodeLabel');
    const stripHouseCount = document.getElementById('stripHouseCount');

    if (strip && carousel) {
      strip.classList.remove('hidden');
      stripPostcodeLabel.innerText = state.currentPostcode || '';
      stripHouseCount.innerText = `${count} propert${count === 1 ? 'y' : 'ies'} with sales`;
      carousel.innerHTML = '';
    }

    addresses.forEach((addr, idx) => {
      const txs = groupedProperties[addr];
      const latest = txs[txs.length - 1];
      const isSelected = (addr === selectedAddress);

      // Extract clean short house number / name for pin
      let shortName = addr;
      if (latest.address && latest.address.paon) {
        const saon = latest.address.saon ? `${latest.address.saon}/` : '';
        shortName = `${saon}${latest.address.paon}`.trim();
      } else {
        const parts = addr.split(' ');
        shortName = parts[0] || `#${idx + 1}`;
      }

      const shortPrice = '£' + Math.round(latest.price / 1000) + 'k';
      const coords = groupedProperties[addr].markerCoords || { lat: centerLat, lng: centerLng };
      const isCustom = groupedProperties[addr].isCustomPosition;

      // Calculate spec estimates for chip & marker
      const sp = PropertySpecService.estimate(txs, state.areaStats);

      // Add to bottom floating carousel strip
      if (carousel) {
        const chip = document.createElement('button');
        chip.className = `house-carousel-item px-3 py-1.5 rounded-xl border text-xs font-semibold whitespace-nowrap flex items-center space-x-1.5 transition ${isSelected ? 'bg-blue-600 text-white border-blue-400 shadow-md' : 'bg-slate-800 text-slate-300 border-slate-700 hover:text-white'}`;
        chip.innerHTML = `
          <span>🏡 ${shortName}</span>
          <span class="text-[10px] text-indigo-300 font-mono">${sp.bedrooms}</span>
          <span class="font-mono text-emerald-400">${shortPrice}</span>
        `;
        chip.addEventListener('click', () => {
          UI.renderHouseDossier(addr);
        });
        carousel.appendChild(chip);
      }

      // Add marker to Leaflet map (Draggable for rooftop precision in Satellite mode!)
      if (state.mapEngine === 'leaflet' && state.leafletMap) {
        const pinHtml = `
          <div class="house-marker-pin ${isSelected ? 'selected' : ''} ${isCustom ? 'custom-placed' : ''}" title="${addr} - Drag to adjust rooftop location">
            <span class="house-badge">${shortName}</span>
            <span class="house-price">${shortPrice}</span>
          </div>
        `;
        const icon = L.divIcon({
          className: 'house-div-icon',
          html: pinHtml,
          iconSize: [0, 0]
        });

        const marker = L.marker([coords.lat, coords.lng], {
          icon,
          draggable: true,
          zIndexOffset: isSelected ? 500 : 100
        }).addTo(state.leafletMap);

        marker.addr = addr;

        marker.on('click', () => {
          UI.renderHouseDossier(addr);
        });

        marker.on('dragend', (e) => {
          const pos = e.target.getLatLng();
          groupedProperties[addr].markerCoords = { lat: pos.lat, lng: pos.lng };
          groupedProperties[addr].isCustomPosition = true;
          try {
            localStorage.setItem(`pin_${state.currentPostcode}_${addr}`, JSON.stringify({ lat: pos.lat, lng: pos.lng }));
          } catch (err) {}
          const el = marker.getElement()?.querySelector('.house-marker-pin');
          if (el) el.classList.add('custom-placed');
          UI.setInstruction(`📍 Saved rooftop location for house ${shortName}`);
          // Refresh dossier street view link with new exact coordinates
          if (state.selectedPropertyAddress === addr) {
            UI.renderHouseDossier(addr);
          }
        });

        state.houseMarkers.push(marker);
      }
    });
  },

  highlightHousePin(selectedAddr) {
    state.selectedPropertyAddress = selectedAddr;

    // Update marker styling
    if (state.houseMarkers) {
      state.houseMarkers.forEach(m => {
        if (!m.getElement) return;
        const el = m.getElement()?.querySelector('.house-marker-pin');
        if (el) {
          if (m.addr === selectedAddr) {
            el.classList.add('selected');
            m.setZIndexOffset(1000);
          } else {
            el.classList.remove('selected');
            m.setZIndexOffset(100);
          }
        }
      });
    }

    // Update bottom carousel active chip
    const carousel = document.getElementById('mapHouseCarousel');
    if (carousel) {
      const chips = carousel.querySelectorAll('.house-carousel-item');
      const addrs = Object.keys(state.groupedProperties);
      chips.forEach((chip, i) => {
        if (addrs[i] === selectedAddr) {
          chip.className = 'house-carousel-item px-3 py-1.5 rounded-xl border text-xs font-semibold whitespace-nowrap flex items-center space-x-1.5 bg-blue-600 text-white border-blue-400 shadow-md';
          chip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        } else {
          chip.className = 'house-carousel-item px-3 py-1.5 rounded-xl border text-xs font-semibold whitespace-nowrap flex items-center space-x-1.5 bg-slate-800 text-slate-300 border-slate-700 hover:text-white';
        }
      });
    }
  },

  async fetchSurroundingStreets(centerLat, centerLng, currentPostcode) {
    // Clear old street cluster markers
    if (state.streetMarkers && state.streetMarkers.length > 0) {
      state.streetMarkers.forEach(m => {
        if (m.remove) m.remove();
        else if (m.setMap) m.setMap(null);
      });
      state.streetMarkers = [];
    }

    try {
      let data = null;
      try {
        const res = await fetch(`/api/postcodes?lon=${centerLng}&lat=${centerLat}&radius=800&limit=15`);
        if (res.ok) data = await res.json();
      } catch (e) {}

      if (!data || data.status !== 200) {
        const url = `https://api.postcodes.io/postcodes?lon=${centerLng}&lat=${centerLat}&radius=800&limit=15`;
        const res = await fetch(url);
        data = await res.json();
      }
      if (data.status !== 200 || !data.result) return;

      const normCurrent = (currentPostcode || '').replace(/\s+/g, '').toUpperCase();

      data.result.forEach(item => {
        const pcNorm = item.postcode.replace(/\s+/g, '').toUpperCase();
        if (pcNorm === normCurrent) return; // Skip currently active postcode

        if (state.mapEngine === 'leaflet' && state.leafletMap) {
          const pinHtml = `
            <div class="street-cluster-pin" title="Click to view houses in ${item.postcode}">
              <span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span>
              <span class="font-bold">${item.postcode}</span>
            </div>
          `;
          const icon = L.divIcon({
            className: 'street-div-icon',
            html: pinHtml,
            iconSize: [0, 0]
          });

          const marker = L.marker([item.latitude, item.longitude], { icon, zIndexOffset: 50 }).addTo(state.leafletMap);
          marker.on('click', () => {
            MapController.loadPostcode(item.postcode, item.latitude, item.longitude);
          });
          state.streetMarkers.push(marker);
        }
      });
    } catch (e) {
      console.warn('Could not load surrounding streets:', e);
    }
  },

  async scanVisibleMap() {
    let centerLat, centerLng;
    if (state.mapEngine === 'google' && state.googleMap) {
      const c = state.googleMap.getCenter();
      centerLat = c.lat();
      centerLng = c.lng();
    } else if (state.leafletMap) {
      const c = state.leafletMap.getCenter();
      centerLat = c.lat;
      centerLng = c.lng;
    }

    if (!centerLat || !centerLng) return;

    UI.showLoading('Scanning neighborhood for UK houses...');
    try {
      const geo = await UkDataService.reverseGeocode(centerLat, centerLng);
      if (geo && geo.postcode) {
        await this.loadPostcode(geo.postcode, centerLat, centerLng);
      } else {
        UI.hideLoading();
        alert('Could not find UK residential postcodes at current map center. Try panning closer to a residential area.');
      }
    } catch (e) {
      UI.hideLoading();
      alert('Scan error: ' + e.message);
    }
  },

  panTo(lat, lng, zoom = 16) {
    if (state.mapEngine === 'google' && state.googleMap) {
      state.googleMap.panTo({ lat, lng });
      state.googleMap.setZoom(zoom);
    } else if (state.leafletMap) {
      state.leafletMap.setView([lat, lng], zoom, { animate: true });
    }
  },

  dropMarker(lat, lng, title) {
    if (state.activeMarker) {
      if (state.mapEngine === 'google' && state.activeMarker.setMap) {
        state.activeMarker.setMap(null);
      } else if (state.leafletMap && state.activeMarker.remove) {
        state.activeMarker.remove();
      }
    }

    if (state.mapEngine === 'google' && state.googleMap) {
      state.activeMarker = new google.maps.Marker({
        position: { lat, lng },
        map: state.googleMap,
        title,
        animation: google.maps.Animation.DROP
      });
    } else if (state.leafletMap) {
      const customIcon = L.divIcon({
        className: 'custom-pin',
        html: `<div style="background-color: #2563eb; width: 22px; height: 22px; border-radius: 50%; border: 3px solid #ffffff; box-shadow: 0 4px 10px rgba(0,0,0,0.5);"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      state.activeMarker = L.marker([lat, lng], { icon: customIcon }).addTo(state.leafletMap);
    }
  },

  /**
   * Initializes official Google Maps JavaScript API
   */
  initGoogleMaps(apiKey) {
    if (!apiKey) return;

    // Check if script already injected
    if (window.google && window.google.maps) {
      this.setupGoogleMapInstance();
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      this.setupGoogleMapInstance();
    };
    script.onerror = () => {
      alert('Failed to load Google Maps SDK. Please check your API key.');
    };
    document.head.appendChild(script);
  },

  setupGoogleMapInstance() {
    const googleMapEl = document.getElementById('googleMap');
    const leafletMapEl = document.getElementById('leafletMap');

    googleMapEl.classList.remove('hidden');
    leafletMapEl.classList.add('hidden');
    state.mapEngine = 'google';
    document.getElementById('mapEngineBadge').innerText = 'Google Maps Active';

    const defaultCenter = { lat: 51.5074, lng: -0.1278 };

    state.googleMap = new google.maps.Map(googleMapEl, {
      center: defaultCenter,
      zoom: 14,
      mapTypeId: state.mapStyle === 'satellite' ? google.maps.MapTypeId.HYBRID : google.maps.MapTypeId.ROADMAP,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false
    });

    state.geocoder = new google.maps.Geocoder();

    state.googleMap.addListener('click', async e => {
      const lat = e.latLng.lat();
      const lng = e.latLng.lng();
      await this.handleMapClick(lat, lng);
    });

    // Places autocomplete on search input
    const input = document.getElementById('searchInput');
    const autocomplete = new google.maps.places.Autocomplete(input, {
      componentRestrictions: { country: 'gb' },
      fields: ['address_components', 'geometry', 'formatted_address']
    });

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.geometry || !place.geometry.location) return;

      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();

      // Find postcode from address components
      let foundPostcode = '';
      if (place.address_components) {
        for (const comp of place.address_components) {
          if (comp.types.includes('postal_code')) {
            foundPostcode = comp.long_name;
            break;
          }
        }
      }

      if (foundPostcode) {
        this.loadPostcode(foundPostcode, lat, lng);
      } else {
        this.handleMapClick(lat, lng);
      }
    });
  }
};

// Event Listeners & Bootstrapping
document.addEventListener('DOMContentLoaded', () => {
  MapController.init();

  // Search input enter key handling
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const val = searchInput.value.trim();
      if (!val) return;
      await MapController.loadPostcode(val);
    }
  });

  // GPS Locate Button
  document.getElementById('locateBtn').addEventListener('click', () => {
    if (navigator.geolocation) {
      UI.showLoading('Acquiring your GPS location...');
      navigator.geolocation.getCurrentPosition(
        pos => {
          MapController.handleMapClick(pos.coords.latitude, pos.coords.longitude);
        },
        err => {
          UI.hideLoading();
          alert('Geolocation error: ' + err.message);
        },
        { enableHighAccuracy: true }
      );
    } else {
      alert('Geolocation is not supported by your browser.');
    }
  });

  // Preset Hotspot Chips
  document.querySelectorAll('.preset-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const postcode = btn.dataset.postcode;
      MapController.loadPostcode(postcode);
    });
  });

  // Panel Tabs
  document.getElementById('tabHouseBtn').addEventListener('click', () => UI.switchTab('house'));
  document.getElementById('tabAreaBtn').addEventListener('click', () => UI.switchTab('area'));

  // Property Dropdown Selector
  document.getElementById('propertySelect').addEventListener('change', e => {
    UI.renderHouseDossier(e.target.value);
  });

  // Map Style Buttons (Roadmap vs Satellite)
  const btnRoad = document.getElementById('btnMapRoad');
  const btnSat = document.getElementById('btnMapSat');

  btnRoad.addEventListener('click', () => {
    state.mapStyle = 'roadmap';
    btnRoad.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white transition shadow-sm';
    btnSat.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition';
    
    if (state.mapEngine === 'google' && state.googleMap) {
      state.googleMap.setMapTypeId(google.maps.MapTypeId.ROADMAP);
    } else {
      MapController.setLeafletLayer('roadmap');
    }
  });

  btnSat.addEventListener('click', () => {
    state.mapStyle = 'satellite';
    btnSat.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white transition shadow-sm';
    btnRoad.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition';

    if (state.mapEngine === 'google' && state.googleMap) {
      state.googleMap.setMapTypeId(google.maps.MapTypeId.HYBRID);
    } else {
      MapController.setLeafletLayer('satellite');
    }
  });

  // Settings Modal Handlers
  const modal = document.getElementById('settingsModal');
  document.getElementById('settingsBtn').addEventListener('click', () => {
    document.getElementById('googleApiKeyInput').value = state.googleApiKey || '';
    modal.classList.remove('hidden');
  });

  document.getElementById('closeSettingsBtn').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  document.getElementById('saveKeyBtn').addEventListener('click', () => {
    const key = document.getElementById('googleApiKeyInput').value.trim();
    if (key) {
      localStorage.setItem('google_maps_api_key', key);
      state.googleApiKey = key;
      MapController.initGoogleMaps(key);
    }
    modal.classList.add('hidden');
  });

  document.getElementById('resetKeyBtn').addEventListener('click', () => {
    localStorage.removeItem('google_maps_api_key');
    state.googleApiKey = '';
    location.reload();
  });

  window.MapController = MapController;

  const btnScan = document.getElementById('btnScanArea');
  if (btnScan) {
    btnScan.addEventListener('click', () => {
      MapController.scanVisibleMap();
    });
  }

  // Map Street View overlay button
  const btnMapStreetView = document.getElementById('btnMapStreetView');
  if (btnMapStreetView) {
    btnMapStreetView.addEventListener('click', () => {
      const selectedAddr = state.selectedPropertyAddress;
      const coords = (selectedAddr && state.groupedProperties[selectedAddr]?.markerCoords) 
        || state.currentCoords 
        || { lat: 51.5074, lng: -0.1278 };
      const targeted = selectedAddr ? `${selectedAddr}, ${state.currentPostcode || ''}, UK` : '';
      StreetViewController.open(coords.lat, coords.lng, selectedAddr || state.currentPostcode || 'Selected Street', targeted);
    });
  }

  // Street View Modal close button
  const closeSvBtn = document.getElementById('closeStreetViewBtn');
  if (closeSvBtn) {
    closeSvBtn.addEventListener('click', () => {
      StreetViewController.close();
    });
  }

  // Street Road Alignment Rotate button (cycles angles: 0° N-S -> 35° NE-SW -> 65° -> 90° E-W -> 125° -> 155°)
  const btnRotateStreet = document.getElementById('btnRotateStreet');
  if (btnRotateStreet) {
    btnRotateStreet.addEventListener('click', () => {
      if (!state.currentPostcode || !state.groupedProperties) return;
      const angles = [0, 35, 65, 90, 125, 155];
      const current = GeoLayoutService.getStreetAngle(state.currentPostcode);
      let nextIdx = angles.findIndex(a => Math.abs(a - current) < 10) + 1;
      if (nextIdx < 0 || nextIdx >= angles.length) nextIdx = 0;
      const newAngle = angles[nextIdx];

      GeoLayoutService.setStreetAngle(state.currentPostcode, newAngle);
      // Recompute and re-render house markers
      const coords = state.currentCoords || { lat: 51.5074, lng: -0.1278 };
      MapController.renderHouseMarkers(coords.lat, coords.lng, state.groupedProperties, state.selectedPropertyAddress);
      UI.setInstruction(`Street road alignment rotated to ${newAngle}°`);
    });
  }

  // Reset Custom Pins Button (snaps all dragged pins back to calculated street layout)
  const btnResetPins = document.getElementById('btnResetPins');
  if (btnResetPins) {
    btnResetPins.addEventListener('click', () => {
      if (!state.currentPostcode || !state.groupedProperties) return;
      GeoLayoutService.resetCustomPins(state.currentPostcode, Object.keys(state.groupedProperties));
      const coords = state.currentCoords || { lat: 51.5074, lng: -0.1278 };
      MapController.renderHouseMarkers(coords.lat, coords.lng, state.groupedProperties, state.selectedPropertyAddress);
      UI.setInstruction(`Reset all house pins to calculated street layout`);
    });
  }

  // Render recent searches if any exist
  UI.renderRecentSearches();

  // Restore the user's last searched postcode & selected property, or fallback to default
  setTimeout(() => {
    try {
      const lastPostcode = localStorage.getItem('last_searched_postcode');
      const lastCoords = JSON.parse(localStorage.getItem('last_map_coords') || 'null');
      const lastHouse = localStorage.getItem('last_selected_property');

      if (lastPostcode) {
        const lat = lastCoords?.lat;
        const lng = lastCoords?.lng;
        MapController.loadPostcode(lastPostcode, lat, lng, lastHouse);
      } else {
        MapController.loadPostcode('SW11 1TH');
      }
    } catch (e) {
      MapController.loadPostcode('SW11 1TH');
    }
  }, 400);
});
