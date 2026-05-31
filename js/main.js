// Main Application Controller and Event Orchestrator

import { getPreferences, savePreferences } from './preferences.js?v=20260531-realtime';
import { loadAllData } from './data.js?v=20260531-realtime';
import { 
    renderFreshness, 
    populateVenueCheckboxes, 
    renderMetrics, 
    renderWatchlist, 
    renderAllMatchesTable, 
    openDetailsModal,
    getFlagEmoji,
    escapeHtml
} from './render.js?v=20260531-realtime';
import { updateChart } from './charts.js?v=20260531-realtime';
import { initNotifications, checkAndNotifyHits } from './notifications.js?v=20260531-realtime';
import { saveUserTargets, loadUserTargets } from './storage.js?v=20260531-realtime';

// Application Global State
const state = {
    allData: [],
    historyByEvent: new Map(),
    freshness: null,
    aliases: null,
    filters: {
        search: '',
        stage: 'All',
        region: 'All',
        venues: [],
        quickFilter: 'all'
    },
    sortConfig: {
        column: 'match',
        order: 'asc'
    },
    currentChartIndex: 0,
    countdownSeconds: 300,
    fifaEntries: []
};

// 1. Data reload orchestrator
function fetchAndLoad() {
    loadAllData().then(({ snapshot, historyByEvent, freshness, aliases }) => {
        state.allData = snapshot;
        state.historyByEvent = historyByEvent;
        state.freshness = freshness;
        state.aliases = aliases;

        // Render data source age indicators
        renderFreshness(state.freshness);

        // Populate dynamic drop-down selectors
        populateMatchSelector();
        populateFifaMatchSelector();

        // Populate venue checkboxes under Preferences
        const prefs = getPreferences();
        populateVenueCheckboxes(state.allData, prefs.preferredVenues || [], (venues) => {
            prefs.preferredVenues = venues;
            savePreferences(prefs);
            // Trigger recalculation on venue change
            fetchAndLoad();
        });

        // Refresh dynamic widgets
        refreshDashboard();
        state.countdownSeconds = 300; // Reset reload timer
    }).catch(err => {
        console.error('Error loading dashboard data:', err);
        const tbody = document.getElementById('all-matches-body');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="10" class="text-center" style="color:red; font-weight:600;">Failed to sync data: ${escapeHtml(err.message)}</td></tr>`;
        }
    });
}

function refreshDashboard() {
    const prefs = getPreferences();

    // Update Top Action Summary Banner
    renderActionSummaryBanner();

    // Render Metrics cards
    renderMetrics(state.allData, prefs);

    // Render Pinned + Auto Watchlist
    renderWatchlist(state.allData, state.historyByEvent, handleSelectMatch);

    // Render All Matches Table
    renderAllMatchesTable(state.allData, state.filters, state.sortConfig, handleSelectMatch, () => {
        // Callback on settings/notes changes
        fetchAndLoad();
    });

    // Update active chart view
    renderChartView();

    // Render FIFA Table & drop alert
    renderFifaTable();
    checkMassDrop();

    // Check and fire browser target notifications
    const hits = state.allData.filter(r => r.agg_lowest_price && r.target_price && r.agg_lowest_price <= r.target_price);
    checkAndNotifyHits(hits);

    // Update Sync date label
    const syncTimeLabel = document.getElementById('last-updated-time');
    if (syncTimeLabel && state.allData.length) {
        const aggregateDate = state.freshness?.Aggregate?.date;
        if (aggregateDate && !isNaN(aggregateDate.getTime())) {
            syncTimeLabel.textContent = aggregateDate.toLocaleString();
        } else {
            const timestamps = state.allData
                .map(d => d.latest_source_observed_at || d.agg_observed_at || d.latest_observed_at)
                .filter(Boolean)
                .map(t => new Date(t).getTime())
                .filter(t => !isNaN(t));
            if (timestamps.length) {
                syncTimeLabel.textContent = new Date(Math.max(...timestamps)).toLocaleString();
            }
        }
    }
}

// 2. Event Handlers
function handleSelectMatch(row) {
    const historySeries = state.historyByEvent.get(String(row.event_id)) || [];
    openDetailsModal(row, historySeries, (eventId, customTarget) => {
        const targets = loadUserTargets();
        if (customTarget == null) {
            delete targets[eventId];
        } else {
            targets[eventId] = customTarget;
        }
        saveUserTargets(targets);
        // Refresh
        fetchAndLoad();
    });
}

function renderActionSummaryBanner() {
    const banner = document.getElementById('action-summary');
    const bannerText = document.getElementById('action-summary-text');
    if (!banner || !bannerText) return;

    const buys = state.allData.filter(r => r.agg_lowest_price && r.decision === 'Buy');
    if (buys.length > 0) {
        banner.className = 'action-summary action-buy';
        bannerText.innerHTML = `🎯 <strong>Buying Opportunity:</strong> ${buys.length} match(es) have fallen below target thresholds! Check your watchlist.`;
    } else {
        banner.className = 'action-summary action-none';
        bannerText.textContent = '🛡️ No active purchase signals triggered. Monitor prices or set custom thresholds below.';
    }
}

function populateMatchSelector() {
    const selector = document.getElementById('match-selector');
    if (!selector) return;
    selector.innerHTML = '';
    state.allData.forEach((row, index) => {
        const opt = document.createElement('option');
        opt.value = index;
        opt.textContent = `${row.match} (${row.host_city.split(',')[0]})`;
        selector.appendChild(opt);
    });
    // Restore selection index if bounds are correct
    if (state.currentChartIndex < state.allData.length) {
        selector.value = state.currentChartIndex;
    }
}

function renderChartView() {
    const row = state.allData[state.currentChartIndex];
    if (!row) return;

    // Delta calculations
    const calcDelta = (days) => {
        const currentPrice = row.agg_lowest_price;
        if (!currentPrice) return '-';
        const series = state.historyByEvent.get(String(row.event_id)) || [];
        if (series.length <= 1) return '-';

        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        let comparePoint = series[0];
        for (const p of series) {
            if (p.t.getTime() <= cutoff) comparePoint = p;
            else break;
        }
        const delta = currentPrice - comparePoint.price;
        return delta === 0 ? '-' : (delta > 0 ? `+$${Math.round(delta)}` : `-$${Math.abs(Math.round(delta))}`);
    };

    const delta24h = calcDelta(1);
    const delta7d = calcDelta(7);

    const distLabel = document.getElementById('chart-target-dist');
    const d24hLabel = document.getElementById('chart-24h');
    const d7dLabel = document.getElementById('chart-7d');
    const signalLabel = document.getElementById('chart-signal');

    if (d24hLabel) {
        d24hLabel.textContent = delta24h;
        d24hLabel.style.color = delta24h.startsWith('+') ? '#dc2626' : (delta24h.startsWith('-') ? '#16a34a' : '#64748b');
    }
    if (d7dLabel) {
        d7dLabel.textContent = delta7d;
        d7dLabel.style.color = delta7d.startsWith('+') ? '#dc2626' : (delta7d.startsWith('-') ? '#16a34a' : '#64748b');
    }
    if (distLabel) {
        if (row.agg_lowest_price && row.target_price) {
            const diff = row.agg_lowest_price - row.target_price;
            distLabel.textContent = diff <= 0 ? `$${Math.abs(Math.round(diff))} BELOW target` : `$${Math.round(diff)} above target`;
            distLabel.style.color = diff <= 0 ? '#16a34a' : '#dc2626';
        } else {
            distLabel.textContent = '-';
        }
    }
    if (signalLabel) {
        signalLabel.className = `badge signal-${(row.signal || 'stable').toLowerCase().replace(' ', '')}`;
        signalLabel.textContent = row.signal || 'Stable';
    }

    const activePeriod = document.querySelector('.chart-toggle.active')?.dataset.period || 'all';
    updateChart(row, state.historyByEvent.get(String(row.event_id)), activePeriod);
}

// 3. FIFA drop logic
function loadFifaEntries() {
    try {
        state.fifaEntries = JSON.parse(localStorage.getItem('wcm.fifaData.v1') || '[]');
    } catch {
        state.fifaEntries = [];
    }
}
function saveFifaEntries() {
    localStorage.setItem('wcm.fifaData.v1', JSON.stringify(state.fifaEntries));
}

function populateFifaMatchSelector() {
    const selector = document.getElementById('fifa-match-select');
    if (!selector) return;
    selector.innerHTML = '';
    state.allData.forEach(row => {
        const opt = document.createElement('option');
        opt.value = row.event_id;
        opt.textContent = `${row.match} (${row.host_city.split(',')[0]})`;
        selector.appendChild(opt);
    });
}

function getTripRisk(row) {
    const city = (row.host_city || '').toLowerCase();
    if (city.includes('jersey') || city.includes('east rutherford')) {
        return { label: 'Low', cls: 'trip-risk-low', detail: 'MetLife - Drive' };
    }
    if (city.includes('philadelphia')) {
        return { label: 'Medium', cls: 'trip-risk-med', detail: 'Philly - 1.5h Drive' };
    }
    if (city.includes('boston') || city.includes('foxborough')) {
        return { label: 'High', cls: 'trip-risk-high', detail: 'Boston - 3.5h Drive' };
    }
    if (city.includes('toronto')) {
        return { label: 'High', cls: 'trip-risk-high', detail: 'Toronto - Border Crossing' };
    }
    return { label: 'Very High', cls: 'trip-risk-vhigh', detail: 'Flight Required' };
}

function computeFifaPattern(entries) {
    if (entries.length <= 1) return 'Unknown';
    const available = entries.filter(e => e.status === 'available' || e.status === 'limited');
    const soldOut = entries.filter(e => e.status === 'sold_out');
    if (available.length === 0) return 'Long Sold Out';
    if (soldOut.length === 0 && available.length >= 3) return 'Stable';
    if (available.length === 1) return 'One-off';
    
    const recent = available.filter(e => Date.now() - new Date(e.timestamp).getTime() < 30 * 60000);
    if (recent.length >= 3) return 'Mass Drop';
    return 'Volatile';
}

function computeFifaAction(latestEntry, pattern) {
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

function renderFifaTable() {
    const tbody = document.getElementById('fifa-table-body');
    if (!tbody) return;

    const byEvent = new Map();
    state.fifaEntries.forEach(entry => {
        const key = String(entry.event_id);
        if (!byEvent.has(key)) byEvent.set(key, []);
        byEvent.get(key).push(entry);
    });

    if (byEvent.size === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="color:#94a3b8;">No FIFA availability logs. Sightings logged via form below.</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    for (const [eid, entries] of byEvent) {
        entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const latest = entries[0];
        const pattern = computeFifaPattern(entries);
        const action = computeFifaAction(latest, pattern);

        const sgRow = state.allData.find(r => String(r.event_id) === String(eid));
        const risk = sgRow ? getTripRisk(sgRow) : { label: 'Unknown', cls: '', detail: '' };

        const actionClasses = {
            'Buy': 'badge-buy',
            'Queue Now': 'badge-buy',
            'Login Now': 'badge-monitor',
            'Watch': 'badge-monitor',
            'Backup Only': 'badge-wait',
            'Ignore': 'badge-wait'
        };

        const statusLabel = latest.status === 'available' 
            ? '<span class="fifa-available">Available</span>'
            : (latest.status === 'sold_out' ? '<span class="fifa-sold-out">Sold Out</span>' : '<span class="fifa-limited">Limited</span>');

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(latest.match_name)}</strong></td>
            <td>${statusLabel}</td>
            <td>${(latest.categories || []).join(', ') || '-'}</td>
            <td>${escapeHtml(latest.quality.replace('_', ' '))}</td>
            <td>${pattern}</td>
            <td><small>${new Date(latest.timestamp).toLocaleString()}</small></td>
            <td><span class="badge ${actionClasses[action]}">${action}</span></td>
            <td><span class="${risk.cls}">${risk.label}</span><br><small style="color:#94a3b8;">${escapeHtml(risk.detail)}</small></td>
        `;
        tbody.appendChild(tr);
    }
}

function checkMassDrop() {
    const banner = document.getElementById('mass-drop-banner');
    const details = document.getElementById('mass-drop-details');
    if (!banner || !details) return;

    const now = Date.now();
    const window30m = 30 * 60000;
    const window10m = 10 * 60000;
    const recent = state.fifaEntries.filter(e => 
        (e.status === 'available' || e.status === 'limited') &&
        (now - new Date(e.timestamp).getTime()) < window30m
    );

    const uniqueMatches = new Set(recent.map(e => e.event_id));
    const recent10 = recent.filter(e => (now - new Date(e.timestamp).getTime()) < window10m);
    const unique10 = new Set(recent10.map(e => e.event_id));
    const uniqueCats = new Set(recent.flatMap(e => e.categories || []));

    let confidence = '';
    let show = false;

    if (unique10.size >= 5 || (uniqueMatches.size >= 5 && uniqueCats.size >= 3)) {
        confidence = '🟢 High Confidence — Mass Drop Active';
        show = true;
    } else if (unique10.size >= 3 || uniqueMatches.size >= 3) {
        confidence = '🟡 Medium Confidence — Dropping Feed';
        show = true;
    } else if (uniqueMatches.size >= 1) {
        const latest = recent.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
        if (latest && (now - new Date(latest.timestamp).getTime()) < 3 * 60000) {
            confidence = '🟠 Low Confidence — Individual Return';
            show = true;
        }
    }

    if (show) {
        banner.style.display = 'block';
        details.textContent = `Availability confirmed for ${uniqueMatches.size} matches. Status: ${confidence}. `;
        // Expand content
        const fifaContent = document.getElementById('fifa-content');
        const arrow = document.getElementById('fifa-toggle-arrow');
        if (fifaContent) fifaContent.style.display = 'block';
        if (arrow) arrow.textContent = '▲';
    } else {
        banner.style.display = 'none';
    }
}

// 4. Initial setup on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    // Enable browser notifications
    initNotifications();

    // Load FIFA entries from local storage
    loadFifaEntries();

    // 4.1 Collapsible Settings Panel
    const prefsHeader = document.getElementById('prefs-toggle-header');
    const prefsContainer = document.getElementById('preferences-form-container');
    const prefsArrow = document.getElementById('prefs-toggle-arrow');
    if (prefsHeader && prefsContainer) {
        prefsHeader.addEventListener('click', () => {
            const shown = prefsContainer.style.display !== 'none';
            prefsContainer.style.display = shown ? 'none' : 'grid';
            prefsArrow.textContent = shown ? '▼' : '▲';
        });
    }

    // 4.2 Populate Settings Panel Inputs from LocalStorage
    const prefs = getPreferences();
    const homeCityInput = document.getElementById('pref-home-city');
    const maxDriveInput = document.getElementById('pref-max-drive');
    const ticketsInput = document.getElementById('pref-tickets-count');
    const maxBudgetInput = document.getElementById('pref-max-budget');
    const teamPremiumInput = document.getElementById('pref-team-premium');
    const fifaPrefInput = document.getElementById('pref-fifa-pref');
    const avoidLateInput = document.getElementById('pref-avoid-late');

    if (homeCityInput) homeCityInput.value = prefs.homeBaseCity;
    if (maxDriveInput) maxDriveInput.value = prefs.maxDrivingHours;
    if (ticketsInput) ticketsInput.value = prefs.ticketsCount;
    if (maxBudgetInput) maxBudgetInput.value = prefs.maxBudget;
    if (teamPremiumInput) teamPremiumInput.value = prefs.teamPremiumTolerance;
    if (fifaPrefInput) fifaPrefInput.value = prefs.fifaResalePreference;
    if (avoidLateInput) avoidLateInput.checked = prefs.avoidLateGames;

    // 4.3 Setup input change reactive listeners
    const triggerPrefsSave = () => {
        const updatedPrefs = {
            homeBaseCity: homeCityInput.value,
            maxDrivingHours: parseInt(maxDriveInput.value, 10) || 4,
            ticketsCount: parseInt(ticketsInput.value, 10) || 4,
            maxBudget: parseInt(maxBudgetInput.value, 10) || 1000,
            teamPremiumTolerance: teamPremiumInput.value,
            fifaResalePreference: fifaPrefInput.value,
            avoidLateGames: avoidLateInput.checked,
            preferredVenues: prefs.preferredVenues // preserve venue checks
        };
        savePreferences(updatedPrefs);
        // Refresh with new target formulas
        fetchAndLoad();
    };

    [homeCityInput, maxDriveInput, ticketsInput, maxBudgetInput, teamPremiumInput, fifaPrefInput, avoidLateInput].forEach(el => {
        if (el) el.addEventListener('change', triggerPrefsSave);
    });

    // 4.4 Table Filter Listeners
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            state.filters.search = searchInput.value;
            refreshDashboard();
        });
    }

    const stageFilter = document.getElementById('stage-filter');
    if (stageFilter) {
        stageFilter.addEventListener('change', () => {
            state.filters.stage = stageFilter.value;
            refreshDashboard();
        });
    }

    const regionFilter = document.getElementById('region-filter');
    if (regionFilter) {
        regionFilter.addEventListener('change', () => {
            state.filters.region = regionFilter.value;
            refreshDashboard();
        });
    }

    // Setup stages list
    stageFilter.innerHTML = '<option value="All">All Stages</option>';
    const stages = ['Group Stage', 'Round of 32', 'Round of 16', 'Quarterfinals', 'Semifinals', 'Final'];
    stages.forEach(stg => {
        const opt = document.createElement('option');
        opt.value = stg;
        opt.textContent = stg;
        stageFilter.appendChild(opt);
    });

    // 4.5 Quick filters buttons listener
    const quickFilters = document.querySelectorAll('.quick-filter');
    quickFilters.forEach(btn => {
        btn.addEventListener('click', () => {
            quickFilters.forEach(b => b.style.backgroundColor = '#64748b'); // reset bg colors
            const f = btn.dataset.filter;
            if (f === 'all' || state.filters.quickFilter === f) {
                state.filters.quickFilter = null;
                document.querySelector('.quick-filter[data-filter="all"]').style.backgroundColor = '#3b82f6';
            } else {
                state.filters.quickFilter = f;
                btn.style.backgroundColor = '#3b82f6';
            }
            refreshDashboard();
        });
    });

    // 4.6 Sort header click listeners
    const sortHeaders = document.querySelectorAll('.data-table th[data-sort]');
    sortHeaders.forEach(th => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (state.sortConfig.column === col) {
                state.sortConfig.order = state.sortConfig.order === 'asc' ? 'desc' : 'asc';
            } else {
                state.sortConfig.column = col;
                state.sortConfig.order = 'asc';
            }
            refreshDashboard();
        });
    });

    // 4.7 Chart Selectors listener
    const matchSelector = document.getElementById('match-selector');
    if (matchSelector) {
        matchSelector.addEventListener('change', (e) => {
            state.currentChartIndex = parseInt(e.target.value, 10);
            renderChartView();
        });
    }

    const chartToggles = document.querySelectorAll('.chart-toggle');
    chartToggles.forEach(toggle => {
        toggle.addEventListener('click', () => {
            chartToggles.forEach(t => t.classList.remove('active'));
            toggle.classList.add('active');
            renderChartView();
        });
    });

    // 4.8 Dark Mode Toggle
    const darkModeToggle = document.getElementById('dark-mode-toggle');
    if (darkModeToggle) {
        const savedTheme = localStorage.getItem('wcm.theme');
        if (savedTheme === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
            darkModeToggle.textContent = '☀️ Light Mode';
        }
        darkModeToggle.addEventListener('click', () => {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            if (isDark) {
                document.documentElement.removeAttribute('data-theme');
                localStorage.setItem('wcm.theme', 'light');
                darkModeToggle.textContent = '🌙 Dark Mode';
            } else {
                document.documentElement.setAttribute('data-theme', 'dark');
                localStorage.setItem('wcm.theme', 'dark');
                darkModeToggle.textContent = '☀️ Light Mode';
            }
        });
    }

    // 4.9 Export / Import Profiles
    const exportBtn = document.getElementById('export-settings');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const exp = {
                preferences: localStorage.getItem('wcm.preferences.v1'),
                userTargets: localStorage.getItem('wcm.userTargets.v1'),
                notes: localStorage.getItem('wcm.notes.v1'),
                pinned: localStorage.getItem('wcm.pinned.v2'),
                fifaSightings: localStorage.getItem('wcm.fifaData.v1')
            };
            const blob = new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `world_cup_buying_profile_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const importBtn = document.getElementById('import-settings');
    if (importBtn) {
        importBtn.addEventListener('click', () => {
            const raw = prompt('Paste your exported purchasing profile JSON:');
            if (!raw) return;
            try {
                const data = JSON.parse(raw);
                if (data.preferences) localStorage.setItem('wcm.preferences.v1', data.preferences);
                if (data.userTargets) localStorage.setItem('wcm.userTargets.v1', data.userTargets);
                if (data.notes) localStorage.setItem('wcm.notes.v1', data.notes);
                if (data.pinned) localStorage.setItem('wcm.pinned.v2', data.pinned);
                if (data.fifaSightings) localStorage.setItem('wcm.fifaData.v1', data.fifaSightings);
                alert('Profile imported successfully! Reloading...');
                window.location.reload();
            } catch {
                alert('Invalid profile JSON structure.');
            }
        });
    }

    // 4.10 Pre-drop checklists
    const checklistKeys = ['chk-card', 'chk-visa', 'chk-fraud', 'chk-backup', 'chk-login'];
    const checklistState = JSON.parse(localStorage.getItem('wcm.checklist.v1') || '{}');
    checklistKeys.forEach(id => {
        const chk = document.getElementById(id);
        if (!chk) return;
        chk.checked = !!checklistState[id];
        chk.addEventListener('change', () => {
            checklistState[id] = chk.checked;
            localStorage.setItem('wcm.checklist.v1', JSON.stringify(checklistState));
        });
    });

    // 4.11 Manual FIFA Drop Logger Form
    const fifaLogBtn = document.getElementById('fifa-log-btn');
    if (fifaLogBtn) {
        fifaLogBtn.addEventListener('click', () => {
            const matchSel = document.getElementById('fifa-match-select');
            const statusSel = document.getElementById('fifa-status-select');
            const qualitySel = document.getElementById('fifa-quality-select');
            const qtyEl = document.getElementById('fifa-qty');
            
            const cats = [];
            ['fifa-cat1', 'fifa-cat2', 'fifa-cat3', 'fifa-cat4'].forEach((catId, index) => {
                if (document.getElementById(catId).checked) {
                    cats.push(`CAT${index + 1}`);
                }
            });

            if (!matchSel.value) return;

            const newEntry = {
                event_id: matchSel.value,
                match_name: matchSel.options[matchSel.selectedIndex].textContent,
                status: statusSel.value,
                categories: cats,
                quality: qualitySel.value,
                qty: parseInt(qtyEl.value, 10) || 2,
                timestamp: new Date().toISOString()
            };

            state.fifaEntries.push(newEntry);
            saveFifaEntries();
            renderFifaTable();
            checkMassDrop();
        });
    }

    const fifaToggleHeader = document.getElementById('fifa-toggle-header');
    const fifaToggleArrow = document.getElementById('fifa-toggle-arrow');
    const fifaContent = document.getElementById('fifa-content');
    if (fifaToggleHeader && fifaContent) {
        fifaToggleHeader.addEventListener('click', () => {
            const isHidden = fifaContent.style.display === 'none';
            fifaContent.style.display = isHidden ? 'block' : 'none';
            fifaToggleArrow.textContent = isHidden ? '▲' : '▼';
        });
    }

    // Hide family columns button toggle helper
    const toggleFamilyBtn = document.getElementById('toggle-family-btn');
    if (toggleFamilyBtn) {
        toggleFamilyBtn.addEventListener('click', () => {
            const table = document.getElementById('all-matches-table');
            table.classList.toggle('hide-family-cols');
            const hidden = table.classList.contains('hide-family-cols');
            toggleFamilyBtn.textContent = hidden ? 'Show Family Cols' : 'Hide Family Cols';
            toggleFamilyBtn.style.backgroundColor = hidden ? '#3b82f6' : '#64748b';
        });
    }

    // Hide/Remove family settings since it is integrated in preferences profile!
    const familyCostSettingsContainer = document.getElementById('update-family-cost')?.parentElement;
    if (familyCostSettingsContainer) {
        familyCostSettingsContainer.style.display = 'none'; // hide old redundant layout
    }

    // 4.12 Load data first sync
    fetchAndLoad();

    // 4.13 Reload countdown timer update
    setInterval(() => {
        state.countdownSeconds--;
        if (state.countdownSeconds <= 0) {
            fetchAndLoad();
        } else {
            const label = document.getElementById('update-countdown');
            if (label) {
                const m = Math.floor(state.countdownSeconds / 60);
                const s = state.countdownSeconds % 60;
                label.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            }
        }
    }, 1000);
});
