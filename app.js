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
    let fcTickets = 4;
    let fcParking = 80;
    let fcFood = 120;

    const RELOAD_INTERVAL_MS = 60 * 60 * 1000;

    // --- DOM Elements ---
    const searchInput = document.getElementById('search-input');
    const stageFilter = document.getElementById('stage-filter');
    const regionFilter = document.getElementById('region-filter');
    const chartToggles = document.querySelectorAll('.chart-toggle');
    const quickFilters = document.querySelectorAll('.quick-filter');
    const btnUpdateCost = document.getElementById('update-family-cost');

    let currentQuickFilter = 'all';

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

    function matchTickPick(sgRow, tpData) {
        if(!sgRow.date_time) return null;
        const match = sgRow.date_time.match(/,\s*([A-Za-z]+)\s*(\d+)/);
        if (!match) return null;
        const month = monthMap[match[1].substring(0,3)];
        const day = String(match[2]).padStart(2, '0');
        const sgDateStr = `2026-${month}-${day}`;
        
        return tpData.find(tpRow => 
            tpRow.start_date && tpRow.start_date.startsWith(sgDateStr) && 
            tpRow.venue && sgRow.venue && tpRow.venue.includes(sgRow.venue)
        );
    }

    // --- Core Logic Engine ---
    function getFaceValue(stage) {
        const s = (stage || '').toLowerCase();
        if (s.includes('final') && !s.includes('semi') && !s.includes('quarter')) return 600;
        if (s.includes('semi')) return 400;
        if (s.includes('quarter')) return 250;
        if (s.includes('16') || s.includes('32')) return 150;
        return 70; // Group stage
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

    function getDecision(currentPrice, targetPrice) {
        if (!currentPrice) return 'Unknown';
        if (currentPrice <= targetPrice) return 'Buy';
        if (currentPrice <= targetPrice * 1.5) return 'Watch';
        return 'Avoid';
    }

    function getFamilyFit(row) {
        try {
            // Parse "Thu, Jun 11 · 2:00pm"
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

            if (isLate || isBoston || isToronto) return "Hard with Kids";
            if (isMetlifePhilly && isWeekend && isDaytime) return "Family Friendly";
            if (!isEastCoast && !isToronto && !isSemiOrFinal) return "Not Worth Travel";
            
            return "Moderate";
        } catch(e) {
            return "Moderate";
        }
    }

    function generateReason(row, multiplier, decision, familyFit) {
        let reason = "";
        const city = (row.host_city || '').split(',')[0];
        const isEast = localCities.some(c => row.host_city && row.host_city.includes(c));

        if (decision === 'Avoid') {
            if (multiplier > 10) reason = `Absurdly overpriced (${multiplier.toFixed(1)}x face).`;
            else reason = `Too expensive vs face value.`;
        } else if (decision === 'Buy') {
            reason = `Hitting target price! ${multiplier.toFixed(1)}x face.`;
        } else {
            reason = `Close to target. Keep watching.`;
        }

        if (familyFit === 'Family Friendly') reason += ` Great local weekend trip.`;
        else if (familyFit === 'Hard with Kids') reason += ` Late night or far drive.`;
        else if (familyFit === 'Not Worth Travel') reason += ` West coast/far travel for early stage.`;
        else if (isEast) reason += ` Good East Coast option.`;

        if (isStrongMatch(row.match)) reason += ` High demand teams.`;

        return reason;
    }

    function processAggregatedData() {
        allData.forEach(row => {
            let tpMatch = matchTickPick(row, tickpickData);
            let sgPrice = row.latest_low_usd;
            let tpPrice = tpMatch ? tpMatch.low_price_usd : null;

            let lowestPrice = sgPrice;
            let bestUrl = row.url;
            let bestSource = "SeatGeek";

            if (tpPrice && (!lowestPrice || tpPrice < lowestPrice)) {
                lowestPrice = tpPrice;
                bestUrl = tpMatch.url;
                bestSource = "TickPick";
            } else if (tpPrice && lowestPrice && tpPrice === lowestPrice) {
                bestSource = "Both";
            } else if (!sgPrice && tpPrice) {
                lowestPrice = tpPrice;
                bestUrl = tpMatch.url;
                bestSource = "TickPick";
            } else if (!sgPrice && !tpPrice) {
                lowestPrice = null;
                bestSource = "N/A";
            }

            row.agg_lowest_price = lowestPrice;
            row.agg_best_url = bestUrl;
            row.agg_source = bestSource;
            
            // Computations for Decision Board
            row.fv = getFaceValue(row.stage);
            row.multiplier = lowestPrice ? lowestPrice / row.fv : 0;
            row.target_price = getTargetPrice(row, lowestPrice, row.fv);
            row.decision = getDecision(lowestPrice, row.target_price);
            row.family_cost = lowestPrice ? (lowestPrice * fcTickets) + fcParking + fcFood : 0;
            row.family_fit = getFamilyFit(row);
            row.reason = generateReason(row, row.multiplier, row.decision, row.family_fit);
            
            const { change, pct } = calculateDynamicChange(row, 7);
            row.change7d = change;
            row.pct7d = pct;
        });
    }

    // --- Bootstrapping ---
    function loadData() {
        Promise.all([
            fetchCsv('seatgeek_data.csv'),
            fetchCsv('price_history.csv').catch(() => []),
            fetchCsv('tickpick_data.csv').catch(() => []),
        ])
            .then(([snapshot, history, tpSnapshot]) => {
                allData = snapshot;
                tickpickData = tpSnapshot;

                historyByEvent = new Map();
                for (const row of history) {
                    if (row.event_id == null || row.low_usd == null) continue;
                    const t = new Date(row.observed_at);
                    if (isNaN(t.getTime())) continue;
                    const key = String(row.event_id);
                    if (!historyByEvent.has(key)) historyByEvent.set(key, []);
                    historyByEvent.get(key).push({ t, price: Number(row.low_usd) });
                }
                for (const arr of historyByEvent.values()) {
                    arr.sort((a, b) => a.t - b.t);
                }

                processAggregatedData();

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
        
        btnUpdateCost.addEventListener('click', () => {
            fcTickets = parseInt(document.getElementById('fc-tickets').value) || 4;
            fcParking = parseInt(document.getElementById('fc-parking').value) || 80;
            fcFood = parseInt(document.getElementById('fc-food').value) || 120;
            processAggregatedData();
            refreshDashboard();
        });

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
        renderMetrics();
        renderDecisionBoard();
        populateMatchSelector();
        applyFilters();
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
        if (series.length === 0) return { change: 0, pct: 0 };

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
        if (decision === 'Watch') return `<span class="badge" style="background:#fef08a; color:#854d0e; border:1px solid #fde047;">WATCH</span>`;
        return `<span class="badge badge-wait">AVOID</span>`;
    }

    function renderMetrics() {
        const validRows = allData.filter(d => d.agg_lowest_price != null && !isNaN(d.agg_lowest_price));
        
        // Best Buy Now
        const buys = validRows.filter(r => r.decision === 'Buy');
        buys.sort((a,b) => (a.agg_lowest_price / a.target_price) - (b.agg_lowest_price / b.target_price));
        document.getElementById('metric-best-buy').innerHTML = buys.length > 0 ? `${getFlagEmoji(buys[0].match)}<br><small>$${buys[0].agg_lowest_price}</small>` : 'None';

        // Cheapest Local
        const locals = validRows.filter(r => localCities.some(c => r.host_city && r.host_city.includes(c)));
        locals.sort((a,b) => a.agg_lowest_price - b.agg_lowest_price);
        document.getElementById('metric-cheapest-local').innerHTML = locals.length > 0 ? `${getFlagEmoji(locals[0].match)}<br><small>$${locals[0].agg_lowest_price}</small>` : 'N/A';

        // Best MetLife
        const metlife = validRows.filter(r => metlifeCities.some(c => r.host_city && r.host_city.includes(c)));
        metlife.sort((a,b) => (a.agg_lowest_price / a.target_price) - (b.agg_lowest_price / b.target_price));
        document.getElementById('metric-best-metlife').innerHTML = metlife.length > 0 ? `${getFlagEmoji(metlife[0].match)}<br><small>$${metlife[0].agg_lowest_price}</small>` : 'N/A';

        // Avoid Count
        const avoids = validRows.filter(r => r.decision === 'Avoid').length;
        document.getElementById('metric-avoid-count').textContent = avoids;
    }

    function renderDecisionBoard() {
        const boardBuy = document.getElementById('board-buy');
        const boardWatch = document.getElementById('board-watch');
        const boardAvoid = document.getElementById('board-avoid');
        
        boardBuy.innerHTML = ''; boardWatch.innerHTML = ''; boardAvoid.innerHTML = '';

        // We only put East Coast or Strong Teams on the board to avoid clutter
        const watchlistData = allData.filter(r => r.agg_lowest_price && (
            localCities.some(c => r.host_city && r.host_city.includes(c)) || isStrongMatch(r.match)
        ));

        // Sorting: Buy (by lowest ratio), Watch (by lowest ratio), Avoid (by highest premium to show how bad it is)
        const buys = watchlistData.filter(r => r.decision === 'Buy').sort((a,b) => (a.agg_lowest_price/a.target_price) - (b.agg_lowest_price/b.target_price)).slice(0,5);
        const watches = watchlistData.filter(r => r.decision === 'Watch').sort((a,b) => (a.agg_lowest_price/a.target_price) - (b.agg_lowest_price/b.target_price)).slice(0,5);
        const avoids = watchlistData.filter(r => r.decision === 'Avoid').sort((a,b) => b.multiplier - a.multiplier).slice(0,5);

        function createCard(row) {
            const div = document.createElement('div');
            div.style.padding = '10px'; div.style.background = '#fff'; div.style.borderRadius = '6px'; div.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
            div.style.border = '1px solid #e2e8f0';
            div.innerHTML = `
                <div style="font-weight:600; font-size:0.95rem;">${getFlagEmoji(row.match)}</div>
                <div style="font-size:0.8rem; color:#64748b;">${row.host_city.split(',')[0]} • ${row.date_time}</div>
                <div style="margin-top:5px; display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:700; color:#0f172a;">$${row.agg_lowest_price} <span style="font-size:0.75rem; font-weight:normal; color:#64748b;">(${row.multiplier.toFixed(1)}x FV)</span></span>
                    <span style="font-size:0.8rem; color:#64748b;">Target: $${Math.round(row.target_price)}</span>
                </div>
            `;
            return div;
        }

        if(buys.length===0) boardBuy.innerHTML = '<div style="color:#64748b; font-size:0.9rem;">No immediate buys found.</div>';
        else buys.forEach(r => boardBuy.appendChild(createCard(r)));

        if(watches.length===0) boardWatch.innerHTML = '<div style="color:#64748b; font-size:0.9rem;">No matches on watchlist.</div>';
        else watches.forEach(r => boardWatch.appendChild(createCard(r)));

        if(avoids.length===0) boardAvoid.innerHTML = '<div style="color:#64748b; font-size:0.9rem;">All clear.</div>';
        else avoids.forEach(r => boardAvoid.appendChild(createCard(r)));
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

        renderMainTable(filtered);
    }

    function renderMainTable(data) {
        const tbody = document.getElementById('all-matches-body');
        tbody.innerHTML = '';

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center">No matches found matching criteria.</td></tr>';
            return;
        }

        data.forEach(row => {
            const tr = document.createElement('tr');
            
            const matchHtml = getFlagEmoji(row.match);
            const priceStr = row.agg_lowest_price ? `$${row.agg_lowest_price.toLocaleString()}` : 'N/A';
            const targetStr = row.target_price ? `$${Math.round(row.target_price).toLocaleString()}` : 'N/A';
            const famCostStr = row.family_cost ? `$${row.family_cost.toLocaleString()}` : 'N/A';
            const ppCostStr = row.family_cost ? `($${Math.round(row.family_cost/fcTickets)}/pp)` : '';

            // Fit coloring
            let fitColor = '#64748b';
            if (row.family_fit === 'Family Friendly') fitColor = '#059669';
            if (row.family_fit === 'Hard with Kids') fitColor = '#d97706';
            if (row.family_fit === 'Not Worth Travel') fitColor = '#dc2626';

            tr.innerHTML = `
                <td><strong>${matchHtml}</strong><br><small style="color:#666">${row.stage} • ${row.date_time}</small></td>
                <td>${row.venue}<br><small style="color:#666">${row.host_city}</small></td>
                <td class="price-cell">${priceStr}<br><small style="color:#64748b; font-weight:normal;">Target: ${targetStr}</small></td>
                <td><span class="countdown-badge" style="background:#e2e8f0; color:#334155;">${row.multiplier.toFixed(1)}x FV</span></td>
                <td><strong>${famCostStr}</strong><br><small style="color:#64748b;">${ppCostStr}</small></td>
                <td><span style="color:${fitColor}; font-weight:500; font-size:0.85rem;">${row.family_fit}</span></td>
                <td style="font-size:0.8rem; color:#475569; max-width:200px;">${row.reason}</td>
                <td style="text-align:center;">${getDecisionBadge(row.decision, row.agg_best_url)}</td>
            `;
            tbody.appendChild(tr);
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

        // Update 24h/7d metrics
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

        const ctx = document.getElementById('trendChart').getContext('2d');
        if (trendChartInstance) trendChartInstance.destroy();

        trendChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Get-in Price ($)',
                    data: dataPoints,
                    borderColor: '#002147',
                    backgroundColor: 'rgba(0, 33, 71, 0.1)',
                    borderWidth: 2,
                    pointBackgroundColor: '#2563eb',
                    pointBorderColor: '#fff',
                    pointRadius: 3,
                    fill: true,
                    tension: 0.1,
                    spanGaps: true,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#002147',
                        titleColor: '#fff',
                        bodyFont: { size: 13, family: 'Inter' },
                        padding: 10,
                        cornerRadius: 4,
                        displayColors: false,
                        callbacks: {
                            title: ctx => fullTimestamps[ctx[0].dataIndex] || '',
                            label: ctx => '$' + ctx.parsed.y.toLocaleString(),
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: '#e2e8f0' },
                        ticks: {
                            color: '#666',
                            font: { family: 'Inter' },
                            maxTicksLimit: 10,
                            autoSkip: true,
                        }
                    },
                    y: {
                        grid: { color: '#e2e8f0' },
                        ticks: {
                            color: '#666',
                            font: { family: 'Inter' },
                            callback: v => '$' + v
                        }
                    }
                }
            }
        });
    }
});
