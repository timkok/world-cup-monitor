document.addEventListener('DOMContentLoaded', () => {
    let allData = [];
    let tickpickData = [];
    let historyByEvent = new Map();
    let trendChartInstance = null;
    let currentChartIndex = 0;
    let initialized = false;

    // --- Configuration ---
    const localCities = ['New York / New Jersey', 'Philadelphia, PA', 'Boston, MA'];
    const metlifeCities = ['New York / New Jersey', 'East Rutherford'];
    const phillyBostonCities = ['Philadelphia, PA', 'Boston, MA'];
    const strongTeams = ['USA', 'Argentina', 'Brazil', 'France', 'England', 'Spain', 'Germany', 'Portugal'];
    
    // Family Cost Settings
    let fcTickets = parseInt(localStorage.getItem('fcTickets')) || 4;
    let fcParking = parseInt(localStorage.getItem('fcParking')) || 80;
    let fcFood = parseInt(localStorage.getItem('fcFood')) || 120;

    const RELOAD_INTERVAL_MS = 60 * 60 * 1000;
    
    let currentSortCol = 'decision';
    let currentSortDir = 'asc';

    // --- User targets (per-match overrides, persisted in localStorage) ---
    const TARGETS_KEY = 'wcm.userTargets.v1';
    function loadUserTargets() {
        try { return JSON.parse(localStorage.getItem(TARGETS_KEY) || '{}'); } catch { return {}; }
    }
    function saveUserTargets(t) { localStorage.setItem(TARGETS_KEY, JSON.stringify(t)); }
    let userTargets = loadUserTargets();

    // --- Notification de-dupe (so we only fire once per (match, target, price)) ---
    const SEEN_KEY = 'wcm.seenHits.v1';
    function loadSeen() { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } }
    function saveSeen(s) { localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); }

    // --- Pinned matches (user manually starred) ---
    const PINS_KEY = 'wcm.pinned.v1';
    function loadPins() { try { return new Set(JSON.parse(localStorage.getItem(PINS_KEY) || '[]')); } catch { return new Set(); } }
    function savePins(s) { localStorage.setItem(PINS_KEY, JSON.stringify([...s])); }
    let pinnedSet = loadPins();

    // --- DOM Elements ---
    const searchInput = document.getElementById('search-input');
    const stageFilter = document.getElementById('stage-filter');
    const regionFilter = document.getElementById('region-filter');
    const chartToggles = document.querySelectorAll('.chart-toggle');
    const quickFilters = document.querySelectorAll('.quick-filter');
    const btnUpdateCost = document.getElementById('update-family-cost');

    let currentQuickFilter = 'hide10';

    // --- Data Fetching ---
    function fetchCsv(path) {
        return fetch(`${path}?t=${Date.now()}`).then(response => {
            if (!response.ok) throw new Error(`Failed to load ${path}`);
            return response.text();
        }).then(csvText => new Promise(resolve => {
            Papa.parse(csvText, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true,
                complete: results => resolve(results.data),
            });
        }));
    }

    const monthMap = {'Jan':'01', 'Feb':'02', 'Mar':'03', 'Apr':'04', 'May':'05', 'Jun':'06', 'Jul':'07', 'Aug':'08', 'Sep':'09', 'Oct':'10', 'Nov':'11', 'Dec':'12'};

    // Venue-local timezone abbreviation for World Cup 2026 host cities (June/July = DST).
    // Used to disambiguate the date_time strings returned by SeatGeek (which are venue-local).
    const cityTzMap = [
        ['New York / New Jersey', 'ET'],
        ['East Rutherford', 'ET'],
        ['Philadelphia', 'ET'],
        ['Boston', 'ET'],
        ['Foxborough', 'ET'],
        ['Atlanta', 'ET'],
        ['Miami', 'ET'],
        ['Ft Lauderdale', 'ET'],
        ['Toronto', 'ET'],
        ['Houston', 'CT'],
        ['Dallas', 'CT'],
        ['Arlington', 'CT'],
        ['Kansas City', 'CT'],
        ['Mexico City', 'CT'],
        ['Guadalajara', 'CT'],
        ['Zapopan', 'CT'],
        ['Monterrey', 'CT'],
        ['Seattle', 'PT'],
        ['Vancouver', 'PT'],
        ['Los Angeles', 'PT'],
        ['San Francisco', 'PT'],
        ['Santa Clara', 'PT'],
    ];
    function venueTz(city) {
        if (!city) return '';
        for (const [needle, tz] of cityTzMap) {
            if (city.includes(needle)) return tz;
        }
        return '';
    }

    function normalizeString(str) {
        if (!str) return '';
        return str.toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    // Loaded asynchronously from team_aliases.json. List of [variantNormalized,
    // canonicalNormalized] pairs, sorted by variant length DESC so longer
    // matches replace before shorter prefixes (e.g. 'unitedstates' before 'us').
    let teamAliasPairs = [];
    function applyAliases(s) {
        if (!s || !teamAliasPairs.length) return s;
        let out = s;
        for (const [variant, canonical] of teamAliasPairs) {
            if (variant === canonical) continue;
            if (out.indexOf(variant) !== -1) out = out.split(variant).join(canonical);
        }
        return out;
    }
    function fetchAliases() {
        return fetch('team_aliases.json?t=' + Date.now())
            .then(r => r.ok ? r.json() : {})
            .then(map => {
                const pairs = [];
                for (const [canonical, variants] of Object.entries(map)) {
                    if (canonical.startsWith('_')) continue;
                    const cNorm = normalizeString(canonical);
                    const all = new Set([cNorm, ...variants.map(normalizeString).filter(Boolean)]);
                    for (const v of all) pairs.push([v, cNorm]);
                }
                pairs.sort((a, b) => b[0].length - a[0].length);
                teamAliasPairs = pairs;
            }).catch(() => { /* aliases optional */ });
    }

    function extractTeams(str) {
        if (!str) return [];
        const parts = str.toLowerCase().split(/vs\.?/);
        if (parts.length === 2) {
            return [
                applyAliases(normalizeString(parts[0])),
                applyAliases(normalizeString(parts[1])),
            ];
        }
        return [];
    }

    function extractMatchNumber(str) {
        if (!str) return null;
        const m = str.match(/match\s+(\d+)/i);
        return m ? m[1] : null;
    }

    // Generic match-by-date+teams helper: tries match number, then teams, then venue.
    function matchByDateAndTeams(sgRow, candidateRows, nameField, venueField) {
        if (!sgRow.date_time) return null;
        const m = sgRow.date_time.match(/,\s*([A-Za-z]+)\s*(\d+)/);
        if (!m) return null;
        const month = monthMap[m[1].substring(0,3)];
        const day = String(m[2]).padStart(2, '0');
        const sgDateStr = `2026-${month}-${day}`;
        const sgTeams = extractTeams(sgRow.match);
        const sgMatchNum = extractMatchNumber(sgRow.match);

        return candidateRows.find(r => {
            if (!r.start_date || !String(r.start_date).startsWith(sgDateStr)) return false;
            const rName = r[nameField] || '';
            const rMatchNum = extractMatchNumber(rName);
            if (sgMatchNum && rMatchNum && sgMatchNum === rMatchNum) return true;
            if (sgTeams.length === 2) {
                const norm = applyAliases(normalizeString(rName));
                if (norm.includes(sgTeams[0]) && norm.includes(sgTeams[1])) return true;
            }
            const sgV = normalizeString(sgRow.venue);
            const rV = normalizeString(r[venueField]);
            if (sgV && rV && (sgV.includes(rV) || rV.includes(sgV))) return true;
            return false;
        });
    }

    function matchVivid(sgRow, vsData) {
        return matchByDateAndTeams(sgRow, vsData, 'name', 'venue');
    }

    function matchTickPick(sgRow, tpData) {
        if(!sgRow.date_time) return null;
        const match = sgRow.date_time.match(/,\s*([A-Za-z]+)\s*(\d+)/);
        if (!match) return null;
        const month = monthMap[match[1].substring(0,3)];
        const day = String(match[2]).padStart(2, '0');
        const sgDateStr = `2026-${month}-${day}`;
        
        const sgTeams = extractTeams(sgRow.match);
        const sgMatchNum = extractMatchNumber(sgRow.match);

        return tpData.find(tpRow => {
            if (!tpRow.start_date || !tpRow.start_date.startsWith(sgDateStr)) return false;
            
            // 1. Try to match by Match Number
            const tpMatchNum = extractMatchNumber(tpRow.name);
            if (sgMatchNum && tpMatchNum && sgMatchNum === tpMatchNum) return true;

            // 2. Try to match by Teams
            if (sgTeams.length === 2) {
                const normTpName = normalizeString(tpRow.name);
                if (normTpName.includes(sgTeams[0]) && normTpName.includes(sgTeams[1])) {
                    return true;
                }
            }

            // 3. Fallback to Venue matching
            if (tpRow.venue && sgRow.venue) {
                const tpV = normalizeString(tpRow.venue);
                const sgV = normalizeString(sgRow.venue);
                if (tpV.includes(sgV) || sgV.includes(tpV)) return true;
            }

            return false;
        });
    }

    // --- Core Logic Engine ---
    function getFaceValue(stage) {
        const s = (stage || '').toLowerCase();
        if (s.includes('final') && !s.includes('semi') && !s.includes('quarter')) return 600;
        if (s.includes('semi')) return 400;
        if (s.includes('quarter')) return 250;
        if (s.includes('16') || s.includes('32')) return 175;
        return 175; // Group stage (East Coast realistic minimum for 2026)
    }

    function isStrongMatch(matchName) {
        if (!matchName) return false;
        return strongTeams.some(team => matchName.includes(team));
    }

    function getTargetPrice(row, currentPrice, fv) {
        if (!currentPrice) return 0;
        const s = (row.stage || '').toLowerCase();
        const isSemiOrFinal = s.includes('final') || s.includes('semi');
        const isKnockoutOrStrong = s.includes('16') || s.includes('32') || s.includes('quarter') || isStrongMatch(row.match);

        if (isSemiOrFinal) {
            return currentPrice * 0.9;
        } else if (isKnockoutOrStrong) {
            return Math.min(currentPrice * 0.85, fv * 6);
        } else {
            return Math.min(currentPrice * 0.75, fv * 4);
        }
    }

    function getDecision(currentPrice, targetPrice, signal) {
        if (!currentPrice) return 'Unknown';
        if (currentPrice <= targetPrice) {
            // At/below target — strongest buy when also at recent floor or rising
            return 'Buy';
        }
        if (currentPrice <= targetPrice * 1.15) {
            // 15% above target — only Watch unless still declining (then Wait — let it drop)
            if (signal === 'Declining') return 'Wait';
            return 'Watch';
        }
        if (currentPrice <= targetPrice * 1.5) {
            return 'Watch';
        }
        return 'Avoid';
    }

    // --- Trend signal from price history ---
    // Returns one of: 'Near low', 'Declining', 'Rising', 'Volatile', 'Stable', 'No data'
    function computeSignal(eventId, currentPrice) {
        if (!currentPrice) return { signal: 'No data', mean: null, min: null, std: null, cv: 0 };
        const series = historyByEvent.get(String(eventId)) || [];
        if (series.length <= 1) return { signal: 'No data', mean: null, min: null, std: null, cv: 0 };

        const now = Date.now();
        const day = 86400000;
        let window = series.filter(p => now - p.t.getTime() <= 7 * day);
        if (window.length < 3) window = series.filter(p => now - p.t.getTime() <= 30 * day);
        if (window.length < 2) window = series;

        const prices = window.map(p => p.price);
        const mean = prices.reduce((s,v) => s+v, 0) / prices.length;
        const min = Math.min(...prices);
        const variance = prices.reduce((s,v) => s + (v-mean)*(v-mean), 0) / prices.length;
        const std = Math.sqrt(variance);
        const cv = mean ? std / mean : 0;

        let signal = 'Stable';
        if (cv > 0.08) signal = 'Volatile';
        else if (currentPrice <= min * 1.05) signal = 'Near low';
        else if (mean && currentPrice < mean * 0.97) signal = 'Declining';
        else if (mean && currentPrice > mean * 1.03) signal = 'Rising';
        return { signal, mean, min, std, cv };
    }

    function getFamilyFit(row) {
        try {
            const match = row.date_time.match(/^([A-Za-z]+),.+·\s*(\d+):(\d+)([ap]m)/i);
            if (!match) return "Moderate";
            const dayOfWeek = match[1].toLowerCase();
            const isWeekend = ['fri', 'sat', 'sun'].includes(dayOfWeek);
            
            let hour = parseInt(match[2]);
            const ampm = match[4].toLowerCase();
            if (ampm === 'pm' && hour !== 12) hour += 12;
            if (ampm === 'am' && hour === 12) hour = 0;
            const isLate = hour >= 21; // 9pm or later
            const isDaytime = hour <= 18; // 6pm or earlier

            const city = (row.host_city || '').toLowerCase();
            const isMetlifePhilly = city.includes('jersey') || city.includes('philadelphia');
            const isBoston = city.includes('boston');
            const isEastCoast = isMetlifePhilly || isBoston;
            const isToronto = city.includes('toronto');
            
            const stageLower = (row.stage || '').toLowerCase();
            const isSemiOrFinal = stageLower.includes('final') || stageLower.includes('semi');

            if (isLate || isToronto) return "Hard with Kids";
            if (isEastCoast && isWeekend && isDaytime) return "Family Friendly";
            if (!isEastCoast && !isToronto && !isSemiOrFinal) return "Not Worth Travel";
            
            return "Moderate";
        } catch(e) {
            return "Moderate";
        }
    }

    function generateReason(row, multiplier, decision, familyFit) {
        const parts = [];
        const isEast = localCities.some(c => row.host_city && row.host_city.includes(c));
        const isML = metlifeCities.some(c => row.host_city && row.host_city.includes(c));

        // Core decision reason (keep short)
        if (decision === 'Avoid') {
            parts.push(multiplier > 10 ? `${Math.round(multiplier)}x face, way too high` : 'Above target, too pricey');
        } else if (decision === 'Buy') {
            parts.push('Below target, buy candidate');
        } else if (decision === 'Wait') {
            parts.push('Declining, let it drop');
        } else {
            parts.push('Close to target');
        }

        // Location context (1 phrase max)
        if (isML) parts.push('MetLife');
        else if (familyFit === 'Family Friendly') parts.push('good local day trip');
        else if (familyFit === 'Hard with Kids') parts.push('late/far, hard w/ kids');
        else if (familyFit === 'Not Worth Travel') parts.push('flight city');
        else if (isEast) parts.push('East Coast');

        // Team tax
        if (isStrongMatch(row.match)) parts.push('strong teams');

        // Cap to max 2 phrases
        return parts.slice(0, 2).join('. ');
    }

    // Build per-SG-event merged time series from price_history.csv (SG),
    // tickpick_history.csv (mapped via row.tp_event_id) and vivid_history.csv
    // (mapped via row.vs_event_id). Source-tagged so we can debug later.
    function buildMergedHistory() {
        historyByEvent = new Map();

        // Reverse lookups for the cross-platform mappings discovered in
        // processAggregatedData.
        const tpToSg = new Map();
        const vsToSg = new Map();
        for (const row of allData) {
            if (row.tp_event_id != null) tpToSg.set(String(row.tp_event_id), String(row.event_id));
            if (row.vs_event_id != null) vsToSg.set(String(row.vs_event_id), String(row.event_id));
        }

        function add(sgId, t, price, src) {
            if (sgId == null || price == null || isNaN(price) || isNaN(t.getTime())) return;
            const key = String(sgId);
            if (!historyByEvent.has(key)) historyByEvent.set(key, []);
            historyByEvent.get(key).push({ t, price: Number(price), src });
        }

        for (const r of sgRawHistory) {
            if (r.event_id == null || r.low_usd == null) continue;
            add(r.event_id, new Date(r.observed_at), r.low_usd, 'SG');
        }
        for (const r of tpRawHistory) {
            if (r.tickpick_event_id == null || r.low_price_usd == null) continue;
            const sgId = tpToSg.get(String(r.tickpick_event_id));
            if (!sgId) continue;
            add(sgId, new Date(r.observed_at), r.low_price_usd, 'TP');
        }
        for (const r of vsRawHistory) {
            if (r.vivid_event_id == null || r.low_price_usd == null) continue;
            const sgId = vsToSg.get(String(r.vivid_event_id));
            if (!sgId) continue;
            add(sgId, new Date(r.observed_at), r.low_price_usd, 'VS');
        }
        for (const arr of historyByEvent.values()) arr.sort((a, b) => a.t - b.t);
    }

    // Phase 2 of the data pipeline: now that historyByEvent is populated with
    // merged multi-source observations, compute trend signals + final decisions
    // + reason text per row.
    function applySignalsAndDecisions() {
        allData.forEach(row => {
            const sig = computeSignal(row.event_id, row.agg_lowest_price);
            row.signal = sig.signal;
            row.signal_mean = sig.mean;
            row.signal_min = sig.min;
            row.decision = getDecision(row.agg_lowest_price, row.target_price, row.signal);
            row.reason = generateReason(row, row.multiplier, row.decision, row.family_fit);
            const { change, pct } = calculateDynamicChange(row, 7);
            row.change7d = change;
            row.pct7d = pct;
        });
    }

    function processAggregatedData() {
        allData.forEach(row => {
            const tpMatch = matchTickPick(row, tickpickData);
            const vsMatch = matchVivid(row, vividData);
            const sgPrice = row.latest_low_usd != null && !isNaN(row.latest_low_usd) ? Number(row.latest_low_usd) : null;
            const tpPrice = tpMatch && tpMatch.low_price_usd != null ? Number(tpMatch.low_price_usd) : null;
            const vsPrice = vsMatch && vsMatch.low_price_usd != null ? Number(vsMatch.low_price_usd) : null;
            row.tp_event_id = tpMatch ? tpMatch.tickpick_event_id : null;
            row.vs_event_id = vsMatch ? vsMatch.vivid_event_id : null;

            // Pick the cheapest non-null price across the three platforms.
            const candidates = [
                { src: 'SeatGeek', price: sgPrice, url: row.url },
                { src: 'TickPick', price: tpPrice, url: tpMatch ? tpMatch.url : null },
                { src: 'Vivid',    price: vsPrice, url: vsMatch ? vsMatch.url : null },
            ].filter(c => c.price != null);
            let lowestPrice = null, bestUrl = row.url, bestSource = 'N/A';
            if (candidates.length) {
                candidates.sort((a, b) => a.price - b.price);
                lowestPrice = candidates[0].price;
                bestUrl = candidates[0].url;
                bestSource = candidates[0].src;
            }

            row.agg_lowest_price = lowestPrice;
            row.agg_best_url = bestUrl;
            row.agg_source = bestSource;
            row.sg_price = sgPrice;
            row.sg_url = row.url;
            row.tp_price = tpPrice;
            row.tp_url = tpMatch ? tpMatch.url : null;
            row.vs_price = vsPrice;
            row.vs_url = vsMatch ? vsMatch.url : null;
            
            row.fv = getFaceValue(row.stage);
            row.multiplier = lowestPrice ? lowestPrice / row.fv : 0;
            const computedTarget = getTargetPrice(row, lowestPrice, row.fv);
            const userTarget = userTargets[row.event_id];
            row.target_price = (userTarget != null && !isNaN(userTarget) && userTarget > 0) ? Number(userTarget) : computedTarget;
            row.target_is_custom = userTarget != null && !isNaN(userTarget) && userTarget > 0;

            // Signal + decision + family are deferred to applySignalsAndDecisions()
            // so they can use the merged multi-source history (built after this pass).
            row.signal = 'No data';
            row.signal_mean = null;
            row.signal_min = null;
            row.decision = 'Unknown';
            row.family_cost = lowestPrice ? (lowestPrice * fcTickets) + fcParking + fcFood : 0;
            row.family_fit = getFamilyFit(row);
            row.reason = '';
            // change7d / pct7d computed in applySignalsAndDecisions().
        });
    }

    // --- Bootstrapping ---
    let vividData = [];
    let sgRawHistory = [];
    let tpRawHistory = [];
    let vsRawHistory = [];

    function loadData() {
        Promise.all([
            fetchCsv('seatgeek_data.csv'),
            fetchCsv('tickpick_history.csv').catch(() => []),
            fetchCsv('tickpick_data.csv').catch(() => []),
            fetchCsv('vivid_data.csv').catch(() => []),
            fetchCsv('price_history.csv').catch(() => []),
            fetchCsv('vivid_history.csv').catch(() => []),
            fetchAliases(),
        ])
            .then(([snapshot, tpHistory, tpSnapshot, vsSnapshot, sgHistory, vsHistory]) => {
                allData = snapshot;
                tickpickData = tpSnapshot;
                vividData = vsSnapshot || [];
                sgRawHistory = sgHistory || [];
                tpRawHistory = tpHistory || [];
                vsRawHistory = vsHistory || [];

                // historyByEvent will be populated *after* processAggregatedData has
                // resolved each SG row's tp_event_id / vs_event_id, so the key is
                // always the canonical SG event_id with a merged time series.
                processAggregatedData();
                buildMergedHistory();
                // Re-run the part of processAggregatedData that depends on history
                // (signal + decision) now that historyByEvent is populated.
                applySignalsAndDecisions();

                if (!initialized) {
                    initDashboard();
                    initialized = true;
                } else {
                    refreshDashboard();
                }
                updateLastUpdatedLabel();
            })
            .catch(err => {
                document.getElementById('all-matches-body').innerHTML =
                    `<tr><td colspan="8" class="text-center" style="color:red">Error loading data: ${err.message}</td></tr>`;
            });
    }

    loadData();
    setInterval(loadData, RELOAD_INTERVAL_MS);

    function initDashboard() {
        populateFilters();

        const toggleFamilyBtn = document.getElementById('toggle-family-btn');
        if (toggleFamilyBtn) {
            toggleFamilyBtn.addEventListener('click', () => {
                const table = document.getElementById('all-matches-table');
                table.classList.toggle('hide-family-cols');
                toggleFamilyBtn.textContent = table.classList.contains('hide-family-cols') ? 'Show Family Cols' : 'Hide Family Cols';
                toggleFamilyBtn.style.backgroundColor = table.classList.contains('hide-family-cols') ? '#3b82f6' : '#94a3b8';
            });
        }        
        // Enable browser notifications for target hits
        const notifyBtn = document.getElementById('enable-notify');
        if (notifyBtn) {
            notifyBtn.addEventListener('click', () => {
                if (!('Notification' in window)) { alert('Browser notifications not supported.'); return; }
                Notification.requestPermission().then(p => {
                    if (p === 'granted') {
                        try { new Notification('🔔 Alerts enabled', { body: 'You will be notified when matches hit your target price.' }); } catch (e) {}
                        renderAlertBar();
                    }
                });
            });
        }

        if (btnUpdateCost) {
            btnUpdateCost.addEventListener('click', () => {
                fcTickets = parseInt(document.getElementById('fc-tickets').value) || 4;
                fcParking = parseInt(document.getElementById('fc-parking').value) || 80;
                fcFood = parseInt(document.getElementById('fc-food').value) || 120;
                localStorage.setItem('fcTickets', fcTickets);
                localStorage.setItem('fcParking', fcParking);
                localStorage.setItem('fcFood', fcFood);
                processAggregatedData();
                buildMergedHistory();
                applySignalsAndDecisions();
                refreshDashboard();
            });
        }

        // Default highlight on hide10 button
        quickFilters.forEach(b => {
            if (b.dataset.filter === 'hide10') b.style.backgroundColor = '#2563eb';
        });

        // Add sorting listeners
        const headers = document.querySelectorAll('#all-matches-table th[data-sort]');
        headers.forEach(th => {
            th.addEventListener('click', () => {
                const sortCol = th.dataset.sort;
                if (currentSortCol === sortCol) {
                    currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSortCol = sortCol;
                    currentSortDir = 'asc';
                }
                
                headers.forEach(h => {
                    const baseText = h.textContent.replace(' ▲', '').replace(' ▼', '').replace(' ↕', '');
                    if (h === th) {
                        h.textContent = baseText + (currentSortDir === 'asc' ? ' ▲' : ' ▼');
                    } else {
                        h.textContent = baseText + ' ↕';
                    }
                });
                
                applyFilters();
            });
        });

        startUpdateCountdown();

        quickFilters.forEach(btn => {
            btn.addEventListener('click', e => {
                quickFilters.forEach(b => b.style.backgroundColor = '#64748b');
                e.target.style.backgroundColor = '#2563eb';
                currentQuickFilter = e.target.dataset.filter;
                applyFilters();
            });
        });

        searchInput.addEventListener('input', applyFilters);
        stageFilter.addEventListener('change', applyFilters);
        regionFilter.addEventListener('change', applyFilters);

        chartToggles.forEach(btn => {
            btn.addEventListener('click', e => {
                chartToggles.forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                updateChart(currentChartIndex, e.target.dataset.period);
            });
        });

        refreshDashboard();

        // Default chart to Best MetLife Watch
        if (allData.length > 0) {
            const metlifeMatches = allData.filter(r => r.agg_lowest_price && metlifeCities.some(c => r.host_city && r.host_city.includes(c)));
            metlifeMatches.sort((a, b) => a.decision === 'Buy' ? -1 : (a.multiplier - b.multiplier));
            let bestIndex = 0;
            if (metlifeMatches.length > 0) {
                bestIndex = allData.indexOf(metlifeMatches[0]);
            }
            document.getElementById('match-selector').value = bestIndex;
            updateChart(bestIndex, getActivePeriod());
        }
    }

    function refreshDashboard() {
        renderSummaryBanner();
        renderMetrics();
        renderDecisionBoard();
        renderAlertBar();
        populateMatchSelector();
        applyFilters();
    }

    // --- Today's Action Summary Banner ---
    function renderSummaryBanner() {
        const el = document.getElementById('action-summary');
        const txt = document.getElementById('action-summary-text');
        if (!el || !txt) return;
        const validRows = allData.filter(d => d.agg_lowest_price != null);
        const hits = validRows.filter(r => r.agg_lowest_price && r.target_price && r.agg_lowest_price <= r.target_price);
        const mlRows = validRows.filter(r => metlifeCities.some(c => r.host_city && r.host_city.includes(c)));
        const mlClose = mlRows.filter(r => r.agg_lowest_price <= r.target_price * 1.15);
        const localRows = validRows.filter(r => localCities.some(c => r.host_city && r.host_city.includes(c)));
        const allLocalExpensive = localRows.length > 0 && localRows.every(r => r.agg_lowest_price > r.target_price * 1.5);

        el.className = 'action-summary';
        if (hits.length > 0) {
            const best = hits.sort((a,b) => a.agg_lowest_price - b.agg_lowest_price)[0];
            txt.textContent = `\u2705 Target hit: ${best.match} at $${best.agg_lowest_price} (target $${Math.round(best.target_price)}). Check now!`;
            el.classList.add('action-buy');
        } else if (mlClose.length > 0) {
            const best = mlClose.sort((a,b) => a.agg_lowest_price/a.target_price - b.agg_lowest_price/b.target_price)[0];
            txt.textContent = `\ud83c\udfdf\ufe0f MetLife close to target: ${best.match} at $${best.agg_lowest_price} (target $${Math.round(best.target_price)}). Watch closely.`;
        } else if (allLocalExpensive) {
            txt.textContent = `\u274c No local buy today. All East Coast matches are >50% above target.`;
            el.classList.add('action-none');
        } else {
            txt.textContent = `\ud83d\udc40 Watch only. No matches at target yet. Keep monitoring.`;
            el.classList.add('action-none');
        }
    }

    // --- Price Confidence ---
    function getPriceConfidence(row) {
        const prices = [row.sg_price, row.tp_price, row.vs_price].filter(p => p != null);
        if (prices.length >= 3) {
            const spread = Math.max(...prices) - Math.min(...prices);
            const avg = prices.reduce((a,b) => a+b, 0) / prices.length;
            if (spread / avg <= 0.10) return { label: 'High', cls: 'conf-high', spread };
            return { label: 'Med', cls: 'conf-med', spread };
        }
        if (prices.length === 2) {
            const spread = Math.abs(prices[0] - prices[1]);
            return { label: 'Med', cls: 'conf-med', spread };
        }
        return { label: 'Low', cls: 'conf-low', spread: 0 };
    }

    // --- Budget Status ---
    let familyBudget = parseInt(localStorage.getItem('wcm.budget')) || 1000;
    function getBudgetStatus(familyCost) {
        if (!familyCost) return { label: '', cls: '' };
        if (familyCost <= familyBudget) return { label: 'Within Budget', cls: 'budget-ok' };
        if (familyCost <= familyBudget * 1.25) return { label: 'Slightly Over', cls: 'budget-over' };
        return { label: 'Too Expensive', cls: 'budget-no' };
    }

    // --- Check FIFA First logic ---
    function shouldCheckFifa(row) {
        return row.multiplier > 3 || row.decision === 'Watch' || row.decision === 'Avoid' || row.decision === 'Wait';
    }

    // --- Source links: show every platform we found a price on ---
    function renderSources(row) {
        const items = [];
        const cheapestSource = row.agg_source;
        if (row.sg_price != null && row.sg_url) {
            const isBest = cheapestSource === 'SeatGeek' || cheapestSource === 'Both';
            items.push(
                `<a href="${row.sg_url}" target="_blank" rel="noopener" ` +
                `class="src-tag src-sg${isBest ? ' src-best' : ''}" ` +
                `title="Open on SeatGeek">SG $${Math.round(row.sg_price).toLocaleString()}${isBest ? ' ★' : ''}</a>`
            );
        }
        if (row.tp_price != null && row.tp_url) {
            const isBest = cheapestSource === 'TickPick' || cheapestSource === 'Both';
            items.push(
                `<a href="${row.tp_url}" target="_blank" rel="noopener" ` +
                `class="src-tag src-tp${isBest ? ' src-best' : ''}" ` +
                `title="Open on TickPick">TP $${Math.round(row.tp_price).toLocaleString()}${isBest ? ' ★' : ''}</a>`
            );
        }
        if (row.vs_price != null && row.vs_url) {
            const isBest = cheapestSource === 'Vivid';
            items.push(
                `<a href="${row.vs_url}" target="_blank" rel="noopener" ` +
                `class="src-tag src-vs${isBest ? ' src-best' : ''}" ` +
                `title="Open on Vivid Seats">VS $${Math.round(row.vs_price).toLocaleString()}${isBest ? ' ★' : ''}</a>`
            );
        }
        if (!items.length) return '<span style="color:#94a3b8;font-size:0.78rem;">No source available</span>';
        return `<span class="src-row">${items.join('')}</span>`;
    }

    // --- Signal badge helper ---
    function getSignalBadge(signal) {
        const map = {
            'Near low':   { cls: 'signal-low',    label: 'Near low' },
            'Declining':  { cls: 'signal-down',   label: 'Declining' },
            'Rising':     { cls: 'signal-up',     label: 'Rising' },
            'Volatile':   { cls: 'signal-vol',    label: 'Volatile' },
            'Stable':     { cls: 'signal-stable', label: 'Stable' },
            'No data':    { cls: 'signal-stable', label: 'No data' },
        };
        const m = map[signal] || map['No data'];
        return `<span class="badge ${m.cls}">${m.label}</span>`;
    }

    // --- Target-hit alert bar + browser Notifications ---
    function renderAlertBar() {
        const bar = document.getElementById('alert-bar');
        const list = document.getElementById('alert-list');
        if (!bar || !list) return;
        const hits = allData.filter(r => r.agg_lowest_price && r.target_price && r.agg_lowest_price <= r.target_price);
        if (hits.length === 0) {
            bar.classList.add('empty');
            list.innerHTML = '';
            return;
        }
        bar.classList.remove('empty');
        hits.sort((a,b) => (a.agg_lowest_price/a.target_price) - (b.agg_lowest_price/b.target_price));
        const top = hits.slice(0, 6);
        list.innerHTML = top.map(r =>
            `<a href="${r.agg_best_url}" target="_blank" rel="noopener">${r.match} $${r.agg_lowest_price}</a>`
        ).join(' · ') + (hits.length > 6 ? ` <em>(+${hits.length - 6} more)</em>` : '');

        if ('Notification' in window && Notification.permission === 'granted') {
            const seen = loadSeen();
            for (const r of hits) {
                const key = `${r.event_id}:${Math.round(r.target_price)}`;
                if (seen.has(key)) continue;
                try {
                    new Notification(`🎯 Target hit: ${r.match}`, {
                        body: `$${r.agg_lowest_price} on ${r.agg_source} — your target $${Math.round(r.target_price)}`,
                        tag: String(r.event_id),
                    });
                } catch (e) { /* ignore */ }
                seen.add(key);
            }
            saveSeen(seen);
        }
    }

    function getActivePeriod() {
        const active = document.querySelector('.chart-toggle.active');
        return active ? active.dataset.period : 'all';
    }

    function updateLastUpdatedLabel() {
        const timestamps = allData
            .map(d => d.latest_observed_at)
            .filter(Boolean)
            .map(t => new Date(t).getTime())
            .filter(t => !isNaN(t));
        const label = document.getElementById('last-updated-time');
        if (timestamps.length === 0) {
            label.textContent = 'Unknown';
            return;
        }
        label.textContent = new Date(Math.max(...timestamps)).toLocaleString();
    }

    function calculateDynamicChange(row, intervalDays) {
        const currentPrice = row.agg_lowest_price || row.latest_low_usd;
        if (!currentPrice) return { change: 0, pct: 0 };

        const series = historyByEvent.get(String(row.event_id)) || [];
        if (series.length <= 1) return { change: 0, pct: 0 };

        let comparePoint;
        if (intervalDays === 'all') {
            comparePoint = series[0];
        } else {
            const days = parseInt(intervalDays, 10);
            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            comparePoint = series[0];
            for (const p of series) {
                if (p.t.getTime() <= cutoff) comparePoint = p;
                else break;
            }
        }

        const comparePrice = comparePoint.price;
        const change = currentPrice - comparePrice;
        const pct = comparePrice > 0 ? (change / comparePrice) * 100 : 0;
        return { change, pct };
    }

    // --- UI Rendering ---
    function getFlagEmoji(countryName) {
        const flags = {
            'USA': '🇺🇸', 'Mexico': '🇲🇽', 'Canada': '🇨🇦', 'Brazil': '🇧🇷', 'Argentina': '🇦🇷',
            'France': '🇫🇷', 'Germany': '🇩🇪', 'Spain': '🇪🇸', 'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'Portugal': '🇵🇹',
            'Netherlands': '🇳🇱', 'Belgium': '🇧🇪', 'Croatia': '🇭🇷', 'Uruguay': '🇺🇾', 'Colombia': '🇨🇴',
            'Switzerland': '🇨🇭', 'Senegal': '🇸🇳', 'Japan': '🇯🇵', 'South Korea': '🇰🇷', 'Australia': '🇦🇺',
            'Iran': '🇮🇷', 'Morocco': '🇲🇦', 'Saudi Arabia': '🇸🇦', 'Qatar': '🇶🇦', 'Ecuador': '🇪🇨',
            'Ghana': '🇬🇭', 'Cameroon': '🇨🇲', 'Tunisia': '🇹🇳', 'Costa Rica': '🇨🇷', 'Wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿',
            'Serbia': '🇷🇸', 'Poland': '🇵🇱', 'Denmark': '🇩🇰', 'Ivory Coast': '🇨🇮', 'Czechia': '🇨🇿',
            'Algeria': '🇩🇿', 'Turkey': '🇹🇷', 'Bosnia & Herzegovina': '🇧🇦', 'South Africa': '🇿🇦',
            'New Zealand': '🇳🇿', 'Egypt': '🇪🇬', 'Paraguay': '🇵🇾', 'Sweden': '🇸🇪', 'Norway': '🇳🇴',
            'Iraq': '🇮🇶', 'Jordan': '🇯🇴', 'DR Congo': '🇨🇩', 'Uzbekistan': '🇺🇿', 'Panama': '🇵🇦',
            'Haiti': '🇭🇹', 'Curacao': '🇨🇼', 'Cape Verde': '🇨🇻', 'Scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'Austria': '🇦🇹'
        };
        if (!countryName) return '';
        let parts = countryName.split(' vs ');
        if (parts.length === 2) {
            let flag1 = flags[parts[0].trim()] || '🏳️';
            let flag2 = flags[parts[1].trim()] || '🏳️';
            return `${flag1} ${parts[0].trim()} vs ${parts[1].trim()} ${flag2}`;
        }
        return countryName;
    }

    function getDecisionBadge(decision, url) {
        if (decision === 'Buy') return `<a href="${url}" target="_blank" class="badge badge-buy" style="display:inline-block; padding:8px 12px; text-decoration:none;">BUY NOW</a>`;
        if (decision === 'Watch' || decision === 'Wait') return `<a href="${url}" target="_blank" class="badge badge-monitor" style="display:inline-block; padding:6px 10px; text-decoration:none; background:#fef9c3; color:#854d0e; border:1px solid #fde047;">WATCH</a>`;
        return `<span class="badge badge-wait" style="background:#f1f5f9; color:#94a3b8; border:1px solid #e2e8f0;">AVOID</span>`;
    }

    function renderMetrics() {
        const validRows = allData.filter(d => d.agg_lowest_price != null && !isNaN(d.agg_lowest_price));
        
        // Today's Buy: best buy-decision match
        const buys = validRows.filter(r => r.decision === 'Buy');
        buys.sort((a,b) => (a.agg_lowest_price / a.target_price) - (b.agg_lowest_price / b.target_price));
        const bestBuy = buys[0];
        document.getElementById('metric-best-buy').innerHTML = bestBuy
            ? `<span style="font-size:0.85rem">${bestBuy.match}</span><br><span style="font-size:1.1rem;font-weight:700">$${bestBuy.agg_lowest_price}</span><br><small style="color:#64748b">Target $${Math.round(bestBuy.target_price)}</small>`
            : '<span style="color:#94a3b8">None today</span>';

        // Cheapest Driveable
        const locals = validRows.filter(r => localCities.some(c => r.host_city && r.host_city.includes(c)));
        locals.sort((a,b) => a.agg_lowest_price - b.agg_lowest_price);
        const cheapLocal = locals[0];
        document.getElementById('metric-cheapest-local').innerHTML = cheapLocal
            ? `<span style="font-size:0.85rem">${cheapLocal.match}</span><br><span style="font-size:1.1rem;font-weight:700">$${cheapLocal.agg_lowest_price}</span><br><small style="color:#64748b">${cheapLocal.host_city.split(',')[0]}</small>`
            : 'N/A';

        // Best MetLife Watch
        const metlife = validRows.filter(r => metlifeCities.some(c => r.host_city && r.host_city.includes(c)));
        metlife.sort((a,b) => (a.agg_lowest_price / a.target_price) - (b.agg_lowest_price / b.target_price));
        const bestML = metlife[0];
        document.getElementById('metric-best-metlife').innerHTML = bestML
            ? `<span style="font-size:0.85rem">${bestML.match}</span><br><span style="font-size:1.1rem;font-weight:700">$${bestML.agg_lowest_price}</span><br><small style="color:#64748b">Target $${Math.round(bestML.target_price)}</small>`
            : 'N/A';

        // Do Not Buy count
        const avoids = validRows.filter(r => r.decision === 'Avoid').length;
        document.getElementById('metric-avoid-count').innerHTML = `<span style="font-size:1.5rem;font-weight:700">${avoids}</span><br><small style="color:#64748b">of ${validRows.length} matches</small>`;
    }

    function renderDecisionBoard() {
        const tbody = document.getElementById('decision-board-body');
        tbody.innerHTML = '';

        // Pinned matches first
        const pinned = allData.filter(r => r.agg_lowest_price && pinnedSet.has(String(r.event_id)));
        // Auto watchlist: local + strong teams (excluding already pinned)
        const auto = allData.filter(r => r.agg_lowest_price && !pinnedSet.has(String(r.event_id)) && (
            localCities.some(c => r.host_city && r.host_city.includes(c)) || isStrongMatch(r.match)
        ));

        const sortWL = (arr) => arr.sort((a,b) => {
            if (a.decision === 'Buy' && b.decision !== 'Buy') return -1;
            if (a.decision !== 'Buy' && b.decision === 'Buy') return 1;
            return (a.agg_lowest_price/a.target_price) - (b.agg_lowest_price/b.target_price);
        });
        sortWL(pinned);
        sortWL(auto);

        function renderWLRow(row, isPinned) {
            const tr = document.createElement('tr');
            const customMark = row.target_is_custom ? '<span class="custom-mark" title="Custom target">★</span> ' : '';
            const pinBtn = isPinned
                ? `<button class="pin-btn pinned" data-eid="${row.event_id}" title="Unpin">⭐</button>`
                : `<button class="pin-btn" data-eid="${row.event_id}" title="Pin to watchlist">☆</button>`;
            const distToTarget = row.agg_lowest_price && row.target_price
                ? (row.agg_lowest_price <= row.target_price
                    ? `<span style="color:#16a34a;font-size:0.78rem;">$${Math.abs(Math.round(row.agg_lowest_price - row.target_price))} below</span>`
                    : `<span style="color:#dc2626;font-size:0.78rem;">$${Math.round(row.agg_lowest_price - row.target_price)} above</span>`)
                : '';
            tr.innerHTML = `
                <td>${pinBtn} <strong>${getFlagEmoji(row.match)}</strong><br><small style="color:#666">${row.host_city.split(',')[0]}</small></td>
                <td class="price-cell">$${row.agg_lowest_price}<br><small style="color:#64748b;">${customMark}Target: $${Math.round(row.target_price)}</small><br>${distToTarget}</td>
                <td style="font-size:0.8rem; color:#475569;">${getSignalBadge(row.signal)}<br>${row.reason}</td>
                <td>${getDecisionBadge(row.decision, row.agg_best_url)}</td>
            `;
            return tr;
        }

        if (pinned.length > 0) {
            const header = document.createElement('tr');
            header.innerHTML = '<td colspan="4" style="background:#fef9c3;font-weight:600;font-size:0.85rem;padding:6px 12px;">📌 Pinned</td>';
            tbody.appendChild(header);
            pinned.forEach(row => tbody.appendChild(renderWLRow(row, true)));
        }

        if (auto.length > 0) {
            const header = document.createElement('tr');
            header.innerHTML = '<td colspan="4" style="background:#f0f9ff;font-weight:600;font-size:0.85rem;padding:6px 12px;">🤖 Auto (Local + Strong Teams)</td>';
            tbody.appendChild(header);
            auto.slice(0, 10).forEach(row => tbody.appendChild(renderWLRow(row, false)));
        }

        if (pinned.length === 0 && auto.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center">No matches on watchlist.</td></tr>';
        }

        // Bind pin buttons
        tbody.querySelectorAll('.pin-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const eid = btn.dataset.eid;
                if (pinnedSet.has(eid)) pinnedSet.delete(eid);
                else pinnedSet.add(eid);
                savePins(pinnedSet);
                refreshDashboard();
            });
        });
    }

    function populateFilters() {
        stageFilter.innerHTML = '<option value="All">All Stages</option>';
        const stages = [...new Set(allData.map(d => d.stage))].filter(Boolean);
        stages.forEach(stage => {
            const option = document.createElement('option');
            option.value = stage;
            option.textContent = stage;
            stageFilter.appendChild(option);
        });
    }

    function applyFilters() {
        const searchTerm = searchInput.value.toLowerCase();
        const stage = stageFilter.value;
        const region = regionFilter.value;

        const filtered = allData.filter(row => {
            const matchStr = (row.match || '').toLowerCase();
            const cityStr = (row.host_city || '').toLowerCase();
            const matchesSearch = matchStr.includes(searchTerm) || cityStr.includes(searchTerm);
            const matchesStage = (stage === 'All') || (row.stage === stage);
            
            let matchesRegion = true;
            if (region === 'MetLife') matchesRegion = metlifeCities.some(c => row.host_city && row.host_city.includes(c));
            if (region === 'PhillyBoston') matchesRegion = phillyBostonCities.some(c => row.host_city && row.host_city.includes(c));
            if (region === 'Toronto') matchesRegion = cityStr.includes('toronto');

            let matchesQuick = true;
            if (currentQuickFilter === 'fv3') matchesQuick = row.multiplier > 0 && row.multiplier <= 3;
            if (currentQuickFilter === 'east5') matchesQuick = row.multiplier > 0 && row.multiplier <= 5 && localCities.some(c => row.host_city && row.host_city.includes(c));
            if (currentQuickFilter === 'metlife8') matchesQuick = row.multiplier > 0 && row.multiplier <= 8 && metlifeCities.some(c => row.host_city && row.host_city.includes(c));
            if (currentQuickFilter === 'hide10') matchesQuick = row.multiplier > 0 && row.multiplier <= 10;

            return matchesSearch && matchesStage && matchesRegion && matchesQuick;
        });

        // Apply Sorting — decision priority first by default
        const decisionOrder = { 'Buy': 0, 'Wait': 1, 'Watch': 2, 'Unknown': 3, 'Avoid': 4 };
        filtered.sort((a, b) => {
            let valA, valB;
            if (currentSortCol === 'decision') {
                valA = decisionOrder[a.decision] ?? 3;
                valB = decisionOrder[b.decision] ?? 3;
                if (valA !== valB) return currentSortDir === 'asc' ? valA - valB : valB - valA;
                // Secondary: price ascending within same decision
                return (a.agg_lowest_price || 999999) - (b.agg_lowest_price || 999999);
            } else if (currentSortCol === 'match') {
                valA = a.match || '';
                valB = b.match || '';
            } else if (currentSortCol === 'venue') {
                valA = a.venue || '';
                valB = b.venue || '';
            } else if (currentSortCol === 'price') {
                valA = a.agg_lowest_price || 999999;
                valB = b.agg_lowest_price || 999999;
            } else if (currentSortCol === 'multiplier') {
                valA = a.multiplier || 999;
                valB = b.multiplier || 999;
            } else if (currentSortCol === 'cost') {
                valA = a.family_cost || 999999;
                valB = b.family_cost || 999999;
            } else if (currentSortCol === 'fit') {
                valA = a.family_fit || '';
                valB = b.family_fit || '';
            }
            
            if (valA < valB) return currentSortDir === 'asc' ? -1 : 1;
            if (valA > valB) return currentSortDir === 'asc' ? 1 : -1;
            return 0;
        });

        renderMainTable(filtered);
    }

    function renderMainTable(data) {
        const tbody = document.getElementById('all-matches-body');
        tbody.innerHTML = '';

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center">No matches found matching criteria.</td></tr>';
            return;
        }

        data.forEach(row => {
            const tr = document.createElement('tr');

            const matchHtml = getFlagEmoji(row.match);
            const priceStr = row.agg_lowest_price ? `$${row.agg_lowest_price.toLocaleString()}` : 'N/A';
            const targetVal = row.target_price ? Math.round(row.target_price) : '';
            const famCostStr = row.family_cost ? `$${row.family_cost.toLocaleString()}` : 'N/A';
            const ppCostStr = row.family_cost ? `($${Math.round(row.family_cost/fcTickets)}/pp)` : '';

            let fitColor = '#64748b';
            if (row.family_fit === 'Family Friendly') fitColor = '#059669';
            if (row.family_fit === 'Hard with Kids') fitColor = '#d97706';
            if (row.family_fit === 'Not Worth Travel') fitColor = '#dc2626';
            const customMark = row.target_is_custom ? '<span class="custom-mark" title="Custom target">★</span>' : '';

            // Calculate 24h trend
            const ch24 = calculateDynamicChange(row, 1);
            let trendHtml = '';
            if (ch24.change > 0) {
                trendHtml = `<span style="color:#dc2626; font-size:0.8rem; font-weight:bold;">↗ (+$${Math.round(ch24.change)})</span>`;
            } else if (ch24.change < 0) {
                trendHtml = `<span style="color:#16a34a; font-size:0.8rem; font-weight:bold;">↘ (-$${Math.abs(Math.round(ch24.change))})</span>`;
            }

            const conf = getPriceConfidence(row);
            const budgetSt = getBudgetStatus(row.family_cost);

            tr.innerHTML = `
                <td data-label="Match"><div><strong>${matchHtml}</strong><br><small style="color:#666">${row.stage} • ${row.date_time}${venueTz(row.host_city) ? ' ' + venueTz(row.host_city) : ''}</small></div></td>
                <td data-label="Venue">${row.venue}<br><small style="color:#666">${row.host_city}</small></td>
                <td data-label="Price" class="price-cell"><div>${priceStr} ${trendHtml}<br><span style="display:inline-flex;align-items:center;gap:4px;color:#64748b;font-weight:normal;font-size:0.78rem;">Target: ${customMark}<input type="number" class="target-input" data-event-id="${row.event_id}" value="${targetVal}" min="1"></span><div style="margin-top:4px;">${renderSources(row)} <span class="${conf.cls}">${conf.label}${conf.spread ? ' ±$'+Math.round(conf.spread) : ''}</span></div></div></td>
                <td data-label="Signal">${getSignalBadge(row.signal)}</td>
                <td data-label="Multiplier"><span class="countdown-badge" style="background:#e2e8f0; color:#334155;">${row.multiplier.toFixed(1)}x FV</span></td>
                <td data-label="Family $" class="family-col"><div><strong>${famCostStr}</strong><br><small style="color:#64748b;">${ppCostStr}</small><br><span class="${budgetSt.cls}">${budgetSt.label}</span></div></td>
                <td data-label="Family fit" class="family-col"><span style="color:${fitColor}; font-weight:500; font-size:0.85rem;">${row.family_fit}</span></td>
                <td data-label="Reason" style="font-size:0.8rem; color:#475569; max-width:200px;">${row.reason}${shouldCheckFifa(row) ? '<br><span class="fifa-first-badge">Check FIFA first</span>' : ''}</td>
                <td data-label="Notes"><input type="text" class="note-input" data-event-id="${row.event_id}" value="${(userNotes[row.event_id] || '').replace(/"/g, '&quot;')}" placeholder="Add note..."></td>
                <td data-label="Decision" style="text-align:center;">${getDecisionBadge(row.decision, row.agg_best_url)}</td>
            `;
            tbody.appendChild(tr);
        });

        // Bind editable target inputs
        tbody.querySelectorAll('input.target-input').forEach(input => {
            input.addEventListener('change', e => {
                const id = e.target.dataset.eventId;
                const val = Number(e.target.value);
                if (!isNaN(val) && val > 0) userTargets[id] = val;
                else delete userTargets[id];
                saveUserTargets(userTargets);
                processAggregatedData();
                buildMergedHistory();
                applySignalsAndDecisions();
                refreshDashboard();
                updateChart(currentChartIndex, getActivePeriod());
            });
            input.addEventListener('click', e => e.stopPropagation());
        });

        // Bind notes inputs
        tbody.querySelectorAll('input.note-input').forEach(input => {
            input.addEventListener('change', e => {
                const id = e.target.dataset.eventId;
                const val = e.target.value.trim();
                if (val) userNotes[id] = val;
                else delete userNotes[id];
                saveNotes(userNotes);
            });
            input.addEventListener('click', e => e.stopPropagation());
        });
    }

    function populateMatchSelector() {
        const selector = document.getElementById('match-selector');
        selector.innerHTML = '';
        allData.forEach((row, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = `${row.match} (${row.host_city})`;
            selector.appendChild(option);
        });
        selector.addEventListener('change', e => {
            currentChartIndex = e.target.value;
            updateChart(currentChartIndex, getActivePeriod());
        });
    }

    function updateChart(index, period = 'all') {
        currentChartIndex = index;
        const row = allData[index];
        if (!row) return;

        const ch24 = calculateDynamicChange(row, 1);
        const ch7 = calculateDynamicChange(row, 7);
        
        document.getElementById('chart-24h').textContent = ch24.change === 0 ? '-' : (ch24.change > 0 ? `+$${Math.round(ch24.change)}` : `-$${Math.abs(Math.round(ch24.change))}`);
        document.getElementById('chart-24h').style.color = ch24.change > 0 ? '#dc2626' : (ch24.change < 0 ? '#16a34a' : '#64748b');
        
        document.getElementById('chart-7d').textContent = ch7.change === 0 ? '-' : (ch7.change > 0 ? `+$${Math.round(ch7.change)}` : `-$${Math.abs(Math.round(ch7.change))}`);
        document.getElementById('chart-7d').style.color = ch7.change > 0 ? '#dc2626' : (ch7.change < 0 ? '#16a34a' : '#64748b');

        if (row.agg_lowest_price && row.target_price) {
            const diff = row.agg_lowest_price - row.target_price;
            document.getElementById('chart-target-dist').textContent = diff > 0 ? `$${Math.round(diff)} above target` : `$${Math.abs(Math.round(diff))} BELOW target!`;
            document.getElementById('chart-target-dist').style.color = diff > 0 ? '#dc2626' : '#16a34a';
        } else {
            document.getElementById('chart-target-dist').textContent = '-';
        }

        const sigEl = document.getElementById('chart-signal');
        if (sigEl) sigEl.innerHTML = getSignalBadge(row.signal || 'No data');

        const series = historyByEvent.get(String(row.event_id)) || [];

        let filtered = series;
        if (period === '1w') {
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            filtered = series.filter(p => p.t.getTime() >= cutoff);
        } else if (period === '1m') {
            const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
            filtered = series.filter(p => p.t.getTime() >= cutoff);
        }

        const labels = filtered.map(p => p.t.toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }));
        const dataPoints = filtered.map(p => p.price);
        const fullTimestamps = filtered.map(p => p.t.toLocaleString());

        const canvas = document.getElementById('trendChart');
        const ctx = canvas.getContext('2d');
        if (trendChartInstance) trendChartInstance.destroy();

        // Vertical gradient fill for the area under the line (deep navy → near-transparent).
        const grad = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 250);
        grad.addColorStop(0, 'rgba(37, 99, 235, 0.28)');
        grad.addColorStop(1, 'rgba(37, 99, 235, 0.02)');

        // Source color per point so multi-source observations are visually distinguishable.
        const srcToColor = src => src === 'TP' ? '#0d4c8a' : src === 'VS' ? '#9d174d' : '#b45309';
        const pointColors = filtered.map(p => srcToColor(p.src));

        trendChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Get-in Price ($)',
                    data: dataPoints,
                    borderColor: '#0b3d7a',
                    backgroundColor: grad,
                    borderWidth: 2.5,
                    pointBackgroundColor: pointColors,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5,
                    pointRadius: 3.5,
                    pointHoverRadius: 6,
                    fill: true,
                    tension: 0.4,           // smoother curve
                    cubicInterpolationMode: 'monotone',
                    spanGaps: true,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                animation: { duration: 350, easing: 'easeOutQuart' },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#0f172a',
                        titleColor: '#fff',
                        titleFont: { size: 12, family: 'Inter', weight: '600' },
                        bodyFont: { size: 13, family: 'Inter' },
                        padding: 10,
                        cornerRadius: 6,
                        displayColors: false,
                        callbacks: {
                            title: ctx => fullTimestamps[ctx[0].dataIndex] || '',
                            label: ctx => {
                                const src = filtered[ctx.dataIndex] && filtered[ctx.dataIndex].src;
                                const label = src ? ` (${src})` : '';
                                return '$' + ctx.parsed.y.toLocaleString() + label;
                            },
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#64748b', font: { family: 'Inter', size: 11 }, maxTicksLimit: 8, autoSkip: true }
                    },
                    y: {
                        grid: { color: 'rgba(226,232,240,0.6)', drawBorder: false },
                        ticks: { color: '#64748b', font: { family: 'Inter', size: 11 }, callback: v => '$' + Number(v).toLocaleString() }
                    }
                }
            }
        });
    }

    function startUpdateCountdown() {
        const countdownLabel = document.getElementById('update-countdown');
        if (!countdownLabel) return;
        
        function update() {
            const now = new Date();
            const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0);
            const diffMs = nextHour - now;
            const diffMins = Math.floor(diffMs / 60000);
            const diffSecs = Math.floor((diffMs % 60000) / 1000);
            countdownLabel.textContent = `${String(diffMins).padStart(2, '0')}:${String(diffSecs).padStart(2, '0')}`;
        }
        update();
        setInterval(update, 1000);
    }

    // ============================================================
    // FIFA DROP MONITOR MODULE
    // ============================================================

    // --- User Notes (per-match, persisted in localStorage) ---
    const NOTES_KEY = 'wcm.notes.v1';
    function loadNotes() { try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch { return {}; } }
    function saveNotes(n) { localStorage.setItem(NOTES_KEY, JSON.stringify(n)); }
    let userNotes = loadNotes();

    // --- FIFA availability data (manual entries, persisted in localStorage) ---
    const FIFA_KEY = 'wcm.fifaData.v1';
    function loadFifaData() { try { return JSON.parse(localStorage.getItem(FIFA_KEY) || '[]'); } catch { return []; } }
    function saveFifaData(d) { localStorage.setItem(FIFA_KEY, JSON.stringify(d)); }
    let fifaEntries = loadFifaData();

    // --- Payment checklist persistence ---
    const CHK_KEY = 'wcm.checklist.v1';
    function loadChecklist() { try { return JSON.parse(localStorage.getItem(CHK_KEY) || '{}'); } catch { return {}; } }
    function saveChecklist(c) { localStorage.setItem(CHK_KEY, JSON.stringify(c)); }
    const checklistState = loadChecklist();
    ['chk-card','chk-visa','chk-fraud','chk-backup','chk-login'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = !!checklistState[id];
        el.addEventListener('change', () => {
            checklistState[id] = el.checked;
            saveChecklist(checklistState);
        });
    });

    // --- Trip Cost Risk ---
    function getTripRisk(row) {
        const city = (row.host_city || '').toLowerCase();
        if (city.includes('jersey') || city.includes('east rutherford')) return { label: 'Low', cls: 'trip-risk-low', detail: 'MetLife — drive' };
        if (city.includes('philadelphia')) return { label: 'Medium', cls: 'trip-risk-med', detail: 'Philly — 1.5hr drive' };
        if (city.includes('boston') || city.includes('foxborough')) return { label: 'High', cls: 'trip-risk-high', detail: 'Boston — 3.5hr drive' };
        if (city.includes('toronto')) return { label: 'High', cls: 'trip-risk-high', detail: 'Toronto — border crossing' };
        return { label: 'Very High', cls: 'trip-risk-vhigh', detail: 'Flight required' };
    }

    // --- FIFA Section Toggle ---
    const fifaHeader = document.getElementById('fifa-toggle-header');
    const fifaContent = document.getElementById('fifa-content');
    const fifaArrow = document.getElementById('fifa-toggle-arrow');
    if (fifaHeader && fifaContent) {
        fifaHeader.addEventListener('click', () => {
            const shown = fifaContent.style.display !== 'none';
            fifaContent.style.display = shown ? 'none' : 'block';
            fifaArrow.textContent = shown ? '▼' : '▲';
        });
    }

    // --- Populate FIFA match selector ---
    function populateFifaMatchSelector() {
        const sel = document.getElementById('fifa-match-select');
        if (!sel || !allData.length) return;
        sel.innerHTML = '';
        allData.forEach(row => {
            const opt = document.createElement('option');
            opt.value = row.event_id;
            opt.textContent = `${row.match} — ${(row.host_city || '').split(',')[0]}`;
            sel.appendChild(opt);
        });
    }

    // --- Log FIFA entry ---
    const fifaLogBtn = document.getElementById('fifa-log-btn');
    if (fifaLogBtn) {
        fifaLogBtn.addEventListener('click', () => {
            const matchSel = document.getElementById('fifa-match-select');
            const statusSel = document.getElementById('fifa-status-select');
            const qualitySel = document.getElementById('fifa-quality-select');
            const qtyEl = document.getElementById('fifa-qty');
            const cats = [];
            if (document.getElementById('fifa-cat1').checked) cats.push('CAT1');
            if (document.getElementById('fifa-cat2').checked) cats.push('CAT2');
            if (document.getElementById('fifa-cat3').checked) cats.push('CAT3');
            if (document.getElementById('fifa-cat4').checked) cats.push('CAT4');

            const entry = {
                event_id: matchSel.value,
                match_name: matchSel.options[matchSel.selectedIndex].textContent,
                status: statusSel.value,
                categories: cats,
                quality: qualitySel.value,
                qty: parseInt(qtyEl.value) || 0,
                timestamp: new Date().toISOString(),
            };
            fifaEntries.push(entry);
            saveFifaData(fifaEntries);
            renderFifaTable();
            checkMassDrop();
        });
    }

    // --- Compute availability pattern from history ---
    function computePattern(entries) {
        if (entries.length <= 1) return 'Unknown';
        const available = entries.filter(e => e.status === 'available' || e.status === 'limited');
        const soldOut = entries.filter(e => e.status === 'sold_out');
        if (available.length === 0) return 'Long Sold Out';
        if (soldOut.length === 0 && available.length >= 3) return 'Stable';
        if (available.length === 1) return 'One-off';
        // Check if there was a recent burst
        const recent = available.filter(e => Date.now() - new Date(e.timestamp).getTime() < 30 * 60000);
        if (recent.length >= 3) return 'Mass Drop';
        return 'Volatile';
    }

    // --- Compute action signal ---
    function computeAction(latestEntry, pattern) {
        if (!latestEntry) return 'Ignore';
        if (latestEntry.status === 'available') {
            if (pattern === 'Mass Drop' || pattern === 'Stable') return 'Buy';
            if (pattern === 'One-off') return 'Queue Now';
            return 'Login Now';
        }
        if (latestEntry.status === 'limited') return 'Login Now';
        if (pattern === 'Volatile') return 'Watch';
        if (pattern === 'Long Sold Out') return 'Backup Only';
        return 'Watch';
    }

    function getActionBadge(action) {
        const map = {
            'Buy': 'badge-buy', 'Queue Now': 'badge-buy',
            'Login Now': 'badge-monitor', 'Watch': 'badge-monitor',
            'Backup Only': 'badge-wait', 'Ignore': 'badge-wait',
        };
        return `<span class="badge ${map[action] || 'badge-wait'}">${action}</span>`;
    }

    function getQualityLabel(q) {
        const map = { 'real_drop': 'Real Drop', 'cart_return': 'Cart Return', 'ghost_risk': 'Ghost Risk', 'stable_supply': 'Stable Supply' };
        return map[q] || q;
    }
    function getStatusBadge(s) {
        if (s === 'available') return '<span class="fifa-available">Available</span>';
        if (s === 'sold_out') return '<span class="fifa-sold-out">Sold Out</span>';
        return '<span class="fifa-limited">Limited</span>';
    }

    // --- Render FIFA table ---
    function renderFifaTable() {
        const tbody = document.getElementById('fifa-table-body');
        if (!tbody) return;

        // Group by event_id
        const byEvent = new Map();
        for (const e of fifaEntries) {
            const key = e.event_id;
            if (!byEvent.has(key)) byEvent.set(key, []);
            byEvent.get(key).push(e);
        }

        if (byEvent.size === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="color:#94a3b8;">No FIFA availability data yet.</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        for (const [eid, entries] of byEvent) {
            entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            const latest = entries[0];
            const pattern = computePattern(entries);
            const action = computeAction(latest, pattern);

            // Find matching SG row for trip risk
            const sgRow = allData.find(r => String(r.event_id) === String(eid));
            const risk = sgRow ? getTripRisk(sgRow) : { label: '?', cls: '', detail: '' };

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${latest.match_name}</strong></td>
                <td>${getStatusBadge(latest.status)}</td>
                <td>${(latest.categories || []).join(', ') || '-'}</td>
                <td>${getQualityLabel(latest.quality)}</td>
                <td>${pattern}</td>
                <td><small>${new Date(latest.timestamp).toLocaleString()}</small></td>
                <td>${getActionBadge(action)}</td>
                <td><span class="${risk.cls}">${risk.label}</span><br><small style="color:#94a3b8;">${risk.detail}</small></td>
            `;
            tbody.appendChild(tr);
        }
    }

    // --- Mass Drop Detection ---
    function checkMassDrop() {
        const banner = document.getElementById('mass-drop-banner');
        const details = document.getElementById('mass-drop-details');
        if (!banner || !details) return;

        const now = Date.now();
        const window30m = 30 * 60000;
        const recentAvailable = fifaEntries.filter(e =>
            (e.status === 'available' || e.status === 'limited') &&
            (now - new Date(e.timestamp).getTime()) < window30m
        );
        const uniqueMatches = new Set(recentAvailable.map(e => e.event_id));

        if (uniqueMatches.size >= 3) {
            banner.style.display = 'block';
            details.textContent = ` ${uniqueMatches.size} matches went available in the last 30 min! `;
        } else {
            banner.style.display = 'none';
        }
    }

    // Initialize FIFA module after data loads
    const origRefresh = refreshDashboard;
    refreshDashboard = function() {
        origRefresh();
        populateFifaMatchSelector();
        renderFifaTable();
        checkMassDrop();
    };
});
