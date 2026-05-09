document.addEventListener('DOMContentLoaded', () => {
    let allData = [];
    let tickpickData = [];
    let historyByEvent = new Map();
    let trendChartInstance = null;
    let currentChartIndex = 0;
    let initialized = false;

    const localCities = ['New York / New Jersey', 'Philadelphia, PA', 'Boston, MA'];
    const RELOAD_INTERVAL_MS = 60 * 60 * 1000;

    const searchInput = document.getElementById('search-input');
    const stageFilter = document.getElementById('stage-filter');
    const regionFilter = document.getElementById('region-filter');
    const intervalFilter = document.getElementById('interval-filter');
    const chartToggles = document.querySelectorAll('.chart-toggle');

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

    function getFaceValue(stage) {
        const s = (stage || '').toLowerCase();
        if (s.includes('final') && !s.includes('semi') && !s.includes('quarter')) return 600;
        if (s.includes('semi')) return 400;
        if (s.includes('quarter')) return 250;
        if (s.includes('16') || s.includes('32')) return 150;
        return 70; // Group stage
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
            row.sg_price = sgPrice;
            row.tp_price = tpPrice;
        });
    }

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
                    `<tr><td colspan="9" class="text-center" style="color:red">Error loading data: ${err.message}</td></tr>`;
            });
    }

    loadData();
    setInterval(loadData, RELOAD_INTERVAL_MS);

    function initDashboard() {
        populateFilters();
        renderMetrics();
        renderSmartRecommendations();
        populateMatchSelector();
        applyFilters();

        if (allData.length > 0) {
            document.getElementById('match-selector').value = 0;
            updateChart(0, getActivePeriod());
        }

        searchInput.addEventListener('input', applyFilters);
        stageFilter.addEventListener('change', applyFilters);
        regionFilter.addEventListener('change', applyFilters);
        intervalFilter.addEventListener('change', applyFilters);

        chartToggles.forEach(btn => {
            btn.addEventListener('click', e => {
                chartToggles.forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                updateChart(currentChartIndex, e.target.dataset.period);
            });
        });
    }

    function refreshDashboard() {
        renderMetrics();
        renderSmartRecommendations();
        applyFilters();
        updateChart(currentChartIndex, getActivePeriod());
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

    function calculateDaysUntil(dateString) {
        try {
            const match = dateString.match(/,\s*([A-Za-z]+)\s*(\d+)/);
            if (!match) return null;
            const targetDate = new Date(`${match[1]} ${match[2]}, 2026`);
            const today = new Date();
            const diffDays = Math.ceil((targetDate - today) / (1000 * 60 * 60 * 24));
            return diffDays > 0 ? diffDays : 0;
        } catch (e) {
            return null;
        }
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

    function renderMetrics() {
        const totalMatches = allData.length;
        const validPrices = allData.map(d => d.agg_lowest_price).filter(p => p != null && !isNaN(p));
        const cheapestPrice = validPrices.length > 0 ? Math.min(...validPrices) : 0;
        const avgPrice = validPrices.length > 0 ? validPrices.reduce((a, b) => a + b, 0) / validPrices.length : 0;
        const localMatches = allData.filter(row =>
            localCities.some(city => row.host_city && row.host_city.includes(city))
        ).length;

        document.getElementById('metric-total-matches').textContent = totalMatches;
        document.getElementById('metric-cheapest-price').textContent = `$${cheapestPrice.toLocaleString()}`;
        document.getElementById('metric-avg-price').textContent = `$${Math.round(avgPrice).toLocaleString()}`;
        document.getElementById('metric-nj-matches').textContent = localMatches;
    }

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

    function generateOpinion(row, multiplier, pct7d, isLocal) {
        let reasons = [];
        let emoji = '⭐';
        if (pct7d <= -10) {
            emoji = '📉';
            reasons.push(`Dropped ${Math.abs(pct7d).toFixed(0)}% in 7 days`);
        }
        if (multiplier <= 2.5) {
            emoji = '🔥';
            reasons.push(`Rare ${multiplier.toFixed(1)}x premium`);
        }
        if (isLocal) {
            reasons.push(`Local match in ${row.host_city.split(',')[0]}`);
        }
        
        let stageLower = (row.stage || '').toLowerCase();
        if (stageLower.includes('quarter') || stageLower.includes('semi') || stageLower.includes('final')) {
            reasons.push(`High-prestige ${row.stage}`);
        }

        if (reasons.length === 0) {
            reasons.push(`Solid value at ${multiplier.toFixed(1)}x premium`);
        }

        return `<span style="font-size:1.1rem">${emoji}</span> <span style="font-size:0.85rem; color:#475569;">${reasons.join('. ')}.</span>`;
    }

    function renderSmartRecommendations() {
        const tbody = document.querySelector('#priority-deals-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        // Calculate Value Score for all tracked matches
        const scoredData = allData.filter(r => r.agg_lowest_price).map(row => {
            const fv = getFaceValue(row.stage);
            const multiplier = row.agg_lowest_price / fv;
            
            const { pct } = calculateDynamicChange(row, 7); // 7-day trend
            
            let score = multiplier * 10; // Base penalty for high premium
            
            // Trend Bonus
            if (pct < 0) score += pct; // E.g., -15% drop = -15 score
            
            // Prestige Bonus
            const stageLower = (row.stage || '').toLowerCase();
            if (stageLower.includes('final') && !stageLower.includes('semi') && !stageLower.includes('quarter')) score -= 20;
            else if (stageLower.includes('semi')) score -= 15;
            else if (stageLower.includes('quarter')) score -= 10;
            else if (stageLower.includes('16')) score -= 5;
            
            // Local Bonus
            const isLocal = localCities.some(city => row.host_city && row.host_city.includes(city));
            if (isLocal) score -= 10;

            return { row, score, multiplier, pct, isLocal };
        });

        // Sort by lowest score (best value)
        scoredData.sort((a, b) => a.score - b.score);
        const topPicks = scoredData.slice(0, 5);

        if (topPicks.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center">No recommendations available.</td></tr>';
            return;
        }

        topPicks.forEach(pick => {
            const { row, multiplier, pct, isLocal } = pick;
            const tr = document.createElement('tr');
            
            const priceStr = row.agg_lowest_price ? `$${row.agg_lowest_price.toLocaleString()}` : 'N/A';
            const daysUntil = calculateDaysUntil(row.date_time);
            const countdownHtml = daysUntil ? `<br><span class="countdown-badge">Starts in ${daysUntil} Days</span>` : '';
            const matchHtml = getFlagEmoji(row.match);
            
            const opinionHtml = generateOpinion(row, multiplier, pct, isLocal);
            
            tr.innerHTML = `
                <td><strong>${matchHtml}</strong><br><small style="color:#666">${row.host_city}</small>${countdownHtml}</td>
                <td class="price-cell">${priceStr}<br><span style="font-size:0.75rem; color:#64748b; font-weight:normal;">${multiplier.toFixed(1)}x Face</span></td>
                <td>${opinionHtml}</td>
                <td><a href="${row.agg_best_url}" target="_blank" class="btn-link" style="padding: 6px 12px; font-size: 0.75rem;">Buy</a></td>
            `;
            tbody.appendChild(tr);
        });
    }

    function populateFilters() {
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
            if (region === 'Local') {
                matchesRegion = localCities.some(c => row.host_city && row.host_city.includes(c));
            }
            return matchesSearch && matchesStage && matchesRegion;
        });

        renderMainTable(filtered);
    }

    function renderMainTable(data) {
        const tbody = document.getElementById('all-matches-body');
        tbody.innerHTML = '';

        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="text-center">No matches found matching criteria.</td></tr>';
            return;
        }

        const interval = intervalFilter.value;

        data.forEach(row => {
            const tr = document.createElement('tr');
            const { change, pct } = calculateDynamicChange(row, interval);
            const pctStr = `(${Math.abs(pct).toFixed(1)}%)`;

            let changeHtml = '<span class="trend-flat"><span class="trend-arrow">-</span>$0</span>';
            if (change > 0) {
                changeHtml = `<span class="trend-up"><span class="trend-arrow">▲</span>+$${Math.abs(Math.round(change))} ${pctStr}</span>`;
            } else if (change < 0) {
                changeHtml = `<span class="trend-down"><span class="trend-arrow">▼</span>-$${Math.abs(Math.round(change))} ${pctStr}</span>`;
            }

            const priceStr = row.agg_lowest_price ? `$${row.agg_lowest_price.toLocaleString()}` : 'N/A';
            const noteStr = row.trend_note ? row.trend_note : '-';
            const matchHtml = getFlagEmoji(row.match);
            
            // Platform Source Badge
            let sourceBadge = '';
            if(row.agg_source === 'TickPick') {
                sourceBadge = `<span style="color:#0ea5e9; font-weight:600;">TickPick</span>`;
            } else if (row.agg_source === 'SeatGeek') {
                sourceBadge = `<span style="color:#002147; font-weight:600;">SeatGeek</span>`;
            } else if (row.agg_source === 'Both') {
                sourceBadge = `<span style="color:#8b5cf6; font-weight:600;">Both</span>`;
            } else {
                sourceBadge = `<span style="color:#94a3b8;">N/A</span>`;
            }

            // Face Value Logic
            const fv = getFaceValue(row.stage);
            const multiplier = row.agg_lowest_price ? (row.agg_lowest_price / fv).toFixed(1) : 0;
            const fvBadge = row.agg_lowest_price ? `<br><span class="countdown-badge" style="background:#e2e8f0; color:#334155; margin-top:5px;">${multiplier}x Face Value</span>` : '';

            let recHtml = '<span class="badge badge-monitor">Monitor</span>';
            
            if (!row.agg_lowest_price) {
                recHtml = '<span class="badge badge-monitor">Unknown</span>';
            } else if (multiplier <= 3.0) {
                recHtml = `<span class="badge badge-buy">Good Value (< 3x)</span>`;
            } else if (multiplier <= 5.0) {
                recHtml = `<span class="badge badge-buy" style="background-color:#fef08a; color:#854d0e; border-color:#fde047;">Fair Price</span>`;
            } else if (multiplier >= 10.0) {
                recHtml = '<span class="badge badge-wait">Highly Overpriced</span>';
            } else {
                recHtml = '<span class="badge badge-wait">Above Market</span>';
            }

            tr.innerHTML = `
                <td><strong>${matchHtml}</strong><br><small style="color:#666">${row.stage}</small></td>
                <td>${row.date_time}</td>
                <td>${row.venue}<br><small style="color:#666">${row.host_city}</small></td>
                <td>${sourceBadge}</td>
                <td class="price-cell">${priceStr}${fvBadge}</td>
                <td>${changeHtml}</td>
                <td style="font-size:0.8rem; color:#666; max-width:200px;">${noteStr}</td>
                <td>${recHtml}</td>
                <td><a href="${row.agg_best_url}" target="_blank" class="btn-link">Buy</a></td>
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
                    borderColor: '#38bdf8',
                    backgroundColor: 'rgba(56, 189, 248, 0.15)',
                    borderWidth: 3,
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

        const chartHeader = document.querySelector('.chart-section .section-header h2');
        if (chartHeader) {
            chartHeader.textContent = filtered.length <= 1
                ? '📈 Hourly Price Trend (collecting…)'
                : '📈 Hourly Price Trend';
        }
    }
});
