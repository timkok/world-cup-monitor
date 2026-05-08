document.addEventListener('DOMContentLoaded', () => {
    let allData = [];
    let historyByEvent = new Map(); // event_id -> [{observed_at: Date, low_usd: number}, ...]
    let trendChartInstance = null;
    
    // Nearby cities configuration
    const localCities = ['New York / New Jersey', 'Philadelphia, PA', 'Boston, MA'];

    // DOM Elements
    const searchInput = document.getElementById('search-input');
    const stageFilter = document.getElementById('stage-filter');
    const regionFilter = document.getElementById('region-filter');

    const RELOAD_INTERVAL_MS = 60 * 60 * 1000; // hourly
    let initialized = false;

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

    function loadData() {
        Promise.all([
            fetchCsv('seatgeek_data.csv'),
            fetchCsv('price_history.csv').catch(() => []), // history may not exist yet
        ])
            .then(([snapshot, history]) => {
                allData = snapshot;

                // Index history by event_id with parsed dates, sorted ascending
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

                if (!initialized) {
                    initDashboard();
                    initialized = true;
                } else {
                    refreshDashboard();
                }
                updateLastUpdatedLabel();
            })
            .catch(err => {
                document.getElementById('all-matches-body').innerHTML = `<tr><td colspan="8" class="text-center" style="color:red">Error loading data: ${err.message}</td></tr>`;
            });
    }

    loadData();
    setInterval(loadData, RELOAD_INTERVAL_MS);

    function initDashboard() {
        populateFilters();
        renderMetrics();
        renderPriorityDeals();
        populateMatchSelector();

        // Initial Table Render
        applyFilters();

        // Initial Chart Render
        if (allData.length > 0) {
            document.getElementById('match-selector').value = 0;
            updateChart(0);
        }

        // Event Listeners for Filters
        searchInput.addEventListener('input', applyFilters);
        stageFilter.addEventListener('change', applyFilters);
        regionFilter.addEventListener('change', applyFilters);
    }

    function refreshDashboard() {
        renderMetrics();
        renderPriorityDeals();
        applyFilters();

        const selector = document.getElementById('match-selector');
        const currentIndex = selector.value;
        if (allData[currentIndex]) {
            updateChart(currentIndex);
        }
    }

    function updateLastUpdatedLabel() {
        const timestamps = allData
            .map(d => d.latest_observed_at)
            .filter(Boolean)
            .map(t => new Date(t).getTime())
            .filter(t => !isNaN(t));

        const label = document.getElementById('last-updated-time');
        if (timestamps.length === 0) {
            label.textContent = "Unknown";
            return;
        }
        const latest = new Date(Math.max(...timestamps));
        label.textContent = latest.toLocaleString();
    }

    function renderMetrics() {
        const totalMatches = allData.length;
        
        const validPrices = allData.map(d => d.latest_low_usd).filter(p => p != null && !isNaN(p));
        const cheapestPrice = validPrices.length > 0 ? Math.min(...validPrices) : 0;
        const avgPrice = validPrices.length > 0 ? (validPrices.reduce((a, b) => a + b, 0) / validPrices.length) : 0;
        
        const localMatches = allData.filter(row => 
            localCities.some(city => row.host_city && row.host_city.includes(city))
        ).length;

        document.getElementById('metric-total-matches').textContent = totalMatches;
        document.getElementById('metric-cheapest-price').textContent = `$${cheapestPrice.toLocaleString()}`;
        document.getElementById('metric-avg-price').textContent = `$${Math.round(avgPrice).toLocaleString()}`;
        document.getElementById('metric-nj-matches').textContent = localMatches;
    }

    function renderPriorityDeals() {
        const tbody = document.querySelector('#priority-deals-table tbody');
        tbody.innerHTML = '';
        
        const localData = allData.filter(row => 
            localCities.some(city => row.host_city && row.host_city.includes(city))
        );

        const sorted = [...localData].sort((a, b) => (a.latest_low_usd || 999999) - (b.latest_low_usd || 999999)).slice(0, 5);
        
        if(sorted.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center">No local deals found.</td></tr>';
            return;
        }

        sorted.forEach(row => {
            const tr = document.createElement('tr');
            const priceStr = row.latest_low_usd ? `$${row.latest_low_usd.toLocaleString()}` : 'N/A';
            tr.innerHTML = `
                <td><strong>${row.match}</strong><br><small style="color:#666">${row.stage}</small></td>
                <td>${row.host_city}</td>
                <td class="price-cell">${priceStr}</td>
                <td><a href="${row.url}" target="_blank" class="btn-link">Buy</a></td>
            `;
            tbody.appendChild(tr);
        });
    }

    function populateFilters() {
        // Populate Stage dropdown
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
            // Search filter
            const matchStr = (row.match || '').toLowerCase();
            const cityStr = (row.host_city || '').toLowerCase();
            const matchesSearch = matchStr.includes(searchTerm) || cityStr.includes(searchTerm);

            // Stage filter
            const matchesStage = (stage === 'All') || (row.stage === stage);

            // Region filter
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
            tbody.innerHTML = '<tr><td colspan="8" class="text-center">No matches found matching criteria.</td></tr>';
            return;
        }

        data.forEach(row => {
            const tr = document.createElement('tr');
            
            let changeHtml = '<span class="change-neutral">-</span>';
            const change = row.change_vs_previous_usd;
            const changePct = row.change_vs_previous_pct;
            const pctStr = changePct ? ` (${changePct}%)` : '';
            
            if (change > 0) {
                changeHtml = `<span class="change-up">+$${change}${pctStr}</span>`;
            } else if (change < 0) {
                changeHtml = `<span class="change-down">-$${Math.abs(change)}${pctStr}</span>`;
            } else if (change === 0) {
                changeHtml = `<span class="change-neutral">$0</span>`;
            }

            const priceStr = row.latest_low_usd ? `$${row.latest_low_usd.toLocaleString()}` : 'N/A';
            const noteStr = row.trend_note ? row.trend_note : '-';

            // Recommendation Logic based on Reasonable Price Thresholds
            let recHtml = '<span class="badge badge-monitor">Monitor</span>';
            const stageLower = (row.stage || '').toLowerCase();
            let reasonablePrice = 300; // Default for Group Stage
            
            if (stageLower.includes('final') && !stageLower.includes('semi') && !stageLower.includes('quarter')) {
                reasonablePrice = 2000;
            } else if (stageLower.includes('semi')) {
                reasonablePrice = 1200;
            } else if (stageLower.includes('quarter')) {
                reasonablePrice = 800;
            } else if (stageLower.includes('16') || stageLower.includes('32')) {
                reasonablePrice = 500;
            }

            const currentPrice = row.latest_low_usd;
            
            if (!currentPrice) {
                recHtml = '<span class="badge badge-monitor">Unknown</span>';
            } else if (currentPrice <= reasonablePrice) {
                recHtml = `<span class="badge badge-buy">Good Value (< $${reasonablePrice})</span>`;
            } else if (currentPrice <= reasonablePrice * 1.3) {
                recHtml = `<span class="badge badge-buy" style="background-color:#fef08a; color:#854d0e; border-color:#fde047;">Fair Price</span>`;
            } else if (currentPrice > reasonablePrice * 2) {
                recHtml = `<span class="badge badge-wait">Highly Overpriced</span>`;
            } else {
                recHtml = `<span class="badge badge-wait">Above Market</span>`;
            }

            tr.innerHTML = `
                <td><strong>${row.match}</strong><br><small style="color:#666">${row.stage}</small></td>
                <td>${row.date_time}</td>
                <td>${row.venue}<br><small style="color:#666">${row.host_city}</small></td>
                <td>${row.source}</td>
                <td class="price-cell">${priceStr}</td>
                <td>${changeHtml}</td>
                <td style="font-size:0.8rem; color:#666; max-width:200px;">${noteStr}</td>
                <td>${recHtml}</td>
                <td><a href="${row.url}" target="_blank" class="btn-link">Buy</a></td>
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

        selector.addEventListener('change', (e) => {
            updateChart(e.target.value);
        });
    }

    function updateChart(index) {
        const row = allData[index];
        if (!row) return;

        const eventKey = String(row.event_id);
        const series = historyByEvent.get(eventKey) || [];

        const labels = series.map(p => p.t.toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }));
        const dataPoints = series.map(p => p.price);
        const fullTimestamps = series.map(p => p.t.toLocaleString());

        const ctx = document.getElementById('trendChart').getContext('2d');

        if (trendChartInstance) {
            trendChartInstance.destroy();
        }

        trendChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Lowest Price ($)',
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
                            callback: value => '$' + value
                        }
                    }
                }
            }
        });

        // If this match has only one data point so far, hint the user
        const chartHeader = document.querySelector('.chart-section .section-header h2');
        if (chartHeader) {
            chartHeader.textContent = series.length <= 1
                ? '📈 Hourly Price Trend (collecting…)'
                : '📈 Hourly Price Trend';
        }
    }
});
