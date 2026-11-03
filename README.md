# UK House Price History App 🏡🇬🇧

An interactive mobile and web application that lets users select any house on a map and inspect its complete historical sale records, price growth metrics, and neighborhood statistics using official **HM Land Registry Price Paid Data (1995 – present)**.

---

## 🌟 Key Features

1. **Interactive Google Maps & OpenStreetMap Integration**
   - **Click/Tap to Pinpoint**: Tap any house, building, or street in England & Wales to drop a marker and trigger real-time UK government data lookups.
   - **Dual Engine Architecture**:
     - **Google Maps Mode**: Supports Google Maps JavaScript SDK, Satellite/Hybrid view, and Places Autocomplete.
     - **Interactive Demo Mode (Zero API Key required)**: Uses high-resolution OpenStreetMap & CartoDB tiles so anyone can immediately test without getting blocked by Google Maps API keys.
   - **UK Postcode Search**: Fast search bar with instant jump to any UK postcode (e.g. `SW11 1TH`, `E1 6AN`, `W1K 6ZA`, `M1 1AD`).
   - **GPS Locate Me**: One-touch geolocation button to inspect house histories around your current physical location.
   - **Showcase Hotspot Chips**: Instant one-click presets for Wandsworth, Spitalfields, Mayfair, Manchester, Cambridge, Clifton Bristol, and Birmingham.

2. **Official UK Government Price Paid Data (HMLR)**
   - Queries `https://landregistry.data.gov.uk/data/ppi/transaction-record.json` under the Open Government Licence v3.0.
   - **Detailed Transaction Records**:
     - Exact sale price (£)
     - Transaction date
     - Tenure (Freehold vs. Leasehold)
     - Property Type (Detached, Semi-Detached, Terraced, Flat / Maisonette, Other)
     - Build status (New Build vs. Established)
     - Transaction category (Standard Market Sale vs. Additional/BTL/Repo)

3. **Financial Analytics & Appreciation Metrics**
   - **Capital Gain**: Total monetary growth (£) and percentage return (+X%).
   - **Compound Annual Growth Rate (CAGR)**: Annualized rate of return over the holding period:
     $$\text{CAGR} = \left(\frac{P_{\text{latest}}}{P_{\text{first}}}\right)^{\frac{1}{\text{years}}} - 1$$
   - **Interactive Price History Chart**: Responsive SVG visualization plotting the historical valuation trajectory with hover tooltips and grid markers.
   - **Chronological Transaction Timeline**: Full audit log of all recorded sales for the chosen property.

4. **Street & Postcode Market Pulse**
   - Average and median sale prices across the postcode.
   - Lowest and highest historical sales recorded.
   - Property type breakdown (distribution of flats, terraced, semi-detached, detached).
   - Complete list of all neighboring properties on the street with instant selection.

5. **Android APK Ready**
   - Complete native Android Studio project included in `android/`.
   - Compiles directly into a standalone `.apk` (`android/app/build/outputs/apk/debug/app-debug.apk`).
   - Also fully compatible as a Progressive Web App (PWA) with offline caching.

---

## 🚀 How to Run

### Option 1: Live Web Preview (Instant)
Double-click `run.bat` or run:
```bash
python serve.py
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### Option 2: Build / Rebuild Android APK
Double-click `build-apk.bat` or run in PowerShell:
```powershell
.\build-apk.ps1
```
The compiled APK will be at:
`android/app/build/outputs/apk/debug/app-debug.apk`

### Option 3: Open in Android Studio
1. Launch Android Studio.
2. Select **Open** and choose the `android` folder (`G:\My Drive\APK development\House Price\android`).
3. Press **Run** or build signed APK via **Build > Build Bundle(s) / APK(s) > Build APK(s)**.

---

## 🔑 Adding a Google Maps API Key
1. Open the app and click the **Maps Setup** (gear) button in the top right.
2. Paste your Google Maps JavaScript API key into the dialog and click **Save & Switch Engine**.
3. The key is securely stored in browser `localStorage`.
