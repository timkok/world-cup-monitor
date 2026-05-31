// DOM Rendering and UI Interaction Engine

import { savePins, isPinned, saveUserTargets } from './storage.js?v=20260531-realtime';
import { updateChart } from './charts.js?v=20260531-realtime';
import { LOCAL_CITIES } from './config.js?v=20260531-realtime';

export function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function getFlagEmoji(countryName) {
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

export function renderFreshness(freshness) {
    const renderPill = (id, data, label) => {
        const el = document.getElementById(id);
        if (!el || !data) return;
        const statusClass = String(data.status || 'unknown').toLowerCase().replace(/\s+/g, '-');
        el.className = `freshness-pill pill-${statusClass}`;
        if (data.status === 'Missing') {
            el.textContent = `${label}: N/A`;
            el.title = 'No recent updates or file missing';
        } else {
            const minAgo = Math.round(data.ageHours * 60);
            el.textContent = `${label}: ${data.status} (${minAgo}m ago)`;
            const rowCount = data.rows != null ? ` | rows: ${data.rows}` : '';
            el.title = `Last sync: ${data.date.toLocaleString()}${rowCount}`;
        }
    };

    renderPill('freshness-aggregate', freshness.Aggregate, 'Overall');
    renderPill('freshness-sg', freshness.SeatGeek, 'SeatGeek');
    renderPill('freshness-tp', freshness.TickPick, 'TickPick');
    renderPill('freshness-vs', freshness.Vivid, 'Vivid Seats');
    renderPill('freshness-fifa', freshness.FIFA, 'FIFA');
    renderPill('freshness-hist', freshness.History, 'History');
}

export function populateVenueCheckboxes(allData, selectedVenues, onChangeCallback) {
    const container = document.getElementById('pref-venues-checkboxes');
    if (!container) return;
    const activeVenues = Array.isArray(selectedVenues) ? selectedVenues : [];

    const venues = [...new Set(allData.map(d => d.venue))].filter(Boolean).sort();
    container.innerHTML = '';

    venues.forEach(venue => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = venue;
        input.checked = activeVenues.includes(venue);
        
        input.addEventListener('change', () => {
            const active = Array.from(container.querySelectorAll('input:checked')).map(i => i.value);
            onChangeCallback(active);
        });

        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + venue));
        container.appendChild(label);
    });
}

export function renderMetrics(allData, preferences) {
    const validRows = allData.filter(d => d.agg_lowest_price != null && !isNaN(d.agg_lowest_price));

    // Best Buy Today
    const buys = validRows.filter(r => r.decision === 'Buy');
    buys.sort((a, b) => (a.agg_lowest_price / a.target_price) - (b.agg_lowest_price / b.target_price));
    const bestBuy = buys[0];
    document.getElementById('metric-best-buy').innerHTML = bestBuy
        ? `<span style="font-size:0.85rem">${escapeHtml(bestBuy.match)}</span><br><span style="font-size:1.1rem;font-weight:700">$${bestBuy.agg_lowest_price}</span><br><small style="color:#64748b">Target $${Math.round(bestBuy.target_price)}</small>`
        : '<span style="color:#94a3b8">None today</span>';

    // Cheapest Driveable
    const locals = validRows.filter(r => LOCAL_CITIES.some(c => r.host_city && r.host_city.toLowerCase().includes(c.toLowerCase())));
    locals.sort((a, b) => a.agg_lowest_price - b.agg_lowest_price);
    const cheapLocal = locals[0];
    document.getElementById('metric-cheapest-local').innerHTML = cheapLocal
        ? `<span style="font-size:0.85rem">${escapeHtml(cheapLocal.match)}</span><br><span style="font-size:1.1rem;font-weight:700">$${cheapLocal.agg_lowest_price}</span><br><small style="color:#64748b">${escapeHtml(cheapLocal.host_city.split(',')[0])}</small>`
        : 'N/A';

    // Best MetLife
    const metlife = validRows.filter(r => (r.host_city || '').toLowerCase().includes('jersey'));
    metlife.sort((a, b) => (a.agg_lowest_price / a.target_price) - (b.agg_lowest_price / b.target_price));
    const bestML = metlife[0];
    document.getElementById('metric-best-metlife').innerHTML = bestML
        ? `<span style="font-size:0.85rem">${escapeHtml(bestML.match)}</span><br><span style="font-size:1.1rem;font-weight:700">$${bestML.agg_lowest_price}</span><br><small style="color:#64748b">Target $${Math.round(bestML.target_price)}</small>`
        : 'N/A';

    // Avoid count
    const avoids = validRows.filter(r => r.decision === 'Avoid').length;
    document.getElementById('metric-avoid-count').innerHTML = `<span style="font-size:1.5rem;font-weight:700">${avoids}</span><br><small style="color:#64748b">of ${validRows.length} matches</small>`;
}

export function renderWatchlist(allData, historyByEvent, onSelectMatchCallback) {
    const buyContainer = document.getElementById('watchlist-buy-cards');
    const watchContainer = document.getElementById('watchlist-watch-cards');
    const niceContainer = document.getElementById('watchlist-nice-cards');
    
    if (!buyContainer || !watchContainer || !niceContainer) return;

    buyContainer.innerHTML = '';
    watchContainer.innerHTML = '';
    niceContainer.innerHTML = '';

    let buyCount = 0, watchCount = 0, niceCount = 0;

    allData.forEach(row => {
        const hasLowPrice = row.agg_lowest_price != null;
        if (!hasLowPrice) return;

        const isPinnedMatch = isPinned(String(row.event_id));
        const hasCustomTarget = row.target_is_custom;
        const decision = row.decision;

        // Is it on the watchlist?
        // Pinned, Custom Target, Buy trigger, or Watch trigger
        const isBuy = decision === 'Buy';
        const isWatch = decision === 'Watch' || decision === 'Wait';
        const isNice = isPinnedMatch || hasCustomTarget;

        if (!isBuy && !isWatch && !isNice) return;

        const card = document.createElement('div');
        card.className = `watchlist-card card-${isBuy ? 'buy' : (isWatch ? 'watch' : 'nice')}`;
        
        const pinStar = isPinnedMatch ? '⭐' : '☆';
        const diff = row.agg_lowest_price - row.target_price;
        const diffText = diff <= 0 
            ? `$${Math.abs(Math.round(diff))} below target`
            : `$${Math.round(diff)} above target`;
        const diffColor = diff <= 0 ? '#16a34a' : '#dc2626';
        
        card.innerHTML = `
            <div class="card-header">
                <div>
                    <span class="card-match-title">${getFlagEmoji(row.match)}</span>
                    <div class="card-meta">${escapeHtml(row.stage)} · ${escapeHtml(row.host_city.split(',')[0])}</div>
                </div>
                <button class="card-pin-btn" data-eid="${row.event_id}" title="Pin/Unpin">${pinStar}</button>
            </div>
            <div class="card-price-block">
                <div>
                    <div class="card-price">$${row.agg_lowest_price}</div>
                    <small style="color: #64748b;">cheapest on ${escapeHtml(row.agg_source)}</small>
                </div>
                <div class="card-target">
                    <div>Target: $${Math.round(row.target_price)}</div>
                    <span class="card-difference" style="color: ${diffColor};">${diffText}</span>
                </div>
            </div>
            <div class="card-reason">
                <strong>Signal:</strong> ${escapeHtml(row.signal)}<br>
                ${escapeHtml(row.reason)}
            </div>
        `;

        // Click to open modal
        card.addEventListener('click', (e) => {
            if (e.target.closest('.card-pin-btn')) return; // ignore pin star clicks
            onSelectMatchCallback(row);
        });

        // Pin Button handler
        const pinBtn = card.querySelector('.card-pin-btn');
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const eid = String(row.event_id);
            const pins = JSON.parse(localStorage.getItem('wcm.pinned.v2') || '{}');
            if (pins[eid] !== undefined) {
                delete pins[eid];
            } else {
                const reason = prompt('Why watch this match? (optional)', '') || '';
                pins[eid] = reason;
            }
            savePins(pins);
            // Re-render
            renderWatchlist(allData, historyByEvent, onSelectMatchCallback);
        });

        // Distribute to sub groups
        if (isBuy) {
            buyContainer.appendChild(card);
            buyCount++;
        } else if (isWatch) {
            watchContainer.appendChild(card);
            watchCount++;
        } else {
            niceContainer.appendChild(card);
            niceCount++;
        }
    });

    document.getElementById('wl-buy-count').textContent = `(${buyCount})`;
    document.getElementById('wl-watch-count').textContent = `(${watchCount})`;
    document.getElementById('wl-nice-count').textContent = `(${niceCount})`;

    if (buyCount === 0) buyContainer.innerHTML = '<div class="empty-cards">No matches meet your buy triggers.</div>';
    if (watchCount === 0) watchContainer.innerHTML = '<div class="empty-cards">No matches are close to target prices.</div>';
    if (niceCount === 0) niceContainer.innerHTML = '<div class="empty-cards">Add pins or custom targets to watch here.</div>';
}

export function renderAllMatchesTable(allData, filters, sortConfig, onSelectMatchCallback, onSettingsUpdate) {
    const tbody = document.getElementById('all-matches-body');
    if (!tbody) return;

    // 1. Filter Data
    let filtered = allData.filter(row => {
        // Search filter
        if (filters.search) {
            const q = filters.search.toLowerCase();
            const matchName = (row.match || '').toLowerCase();
            const city = (row.host_city || '').toLowerCase();
            if (!matchName.includes(q) && !city.includes(q)) return false;
        }

        // Stage filter
        if (filters.stage && filters.stage !== 'All') {
            if (row.stage !== filters.stage) return false;
        }

        // Region filter
        if (filters.region && filters.region !== 'All') {
            const city = (row.host_city || '').toLowerCase();
            if (filters.region === 'MetLife') {
                if (!city.includes('jersey')) return false;
            } else if (filters.region === 'PhillyBoston') {
                if (!city.includes('philadelphia') && !city.includes('boston')) return false;
            } else if (filters.region === 'Toronto') {
                if (!city.includes('toronto')) return false;
            }
        }

        // Venues selection filter
        if (filters.venues && filters.venues.length > 0) {
            if (!filters.venues.includes(row.venue)) return false;
        }

        // Quick multiplier filter
        if (filters.quickFilter) {
            if (filters.quickFilter === 'fv3' && row.multiplier >= 3) return false;
            if (filters.quickFilter === 'east5') {
                const city = (row.host_city || '').toLowerCase();
                const isEast = city.includes('jersey') || city.includes('philadelphia') || city.includes('boston');
                if (!isEast || row.multiplier >= 5) return false;
            }
            if (filters.quickFilter === 'metlife8') {
                const city = (row.host_city || '').toLowerCase();
                if (!city.includes('jersey') || row.multiplier >= 8) return false;
            }
            if (filters.quickFilter === 'hide10' && row.multiplier >= 10) return false;
        }

        return true;
    });

    // 2. Sort Data
    if (sortConfig.column) {
        filtered.sort((a, b) => {
            let valA = a[sortConfig.column];
            let valB = b[sortConfig.column];

            // Specific overrides
            if (sortConfig.column === 'price') {
                valA = a.agg_lowest_price || Infinity;
                valB = b.agg_lowest_price || Infinity;
            } else if (sortConfig.column === 'cost') {
                valA = a.family_cost || Infinity;
                valB = b.family_cost || Infinity;
            }

            if (valA === valB) return 0;
            if (valA == null) return 1;
            if (valB == null) return -1;

            if (typeof valA === 'string') {
                return sortConfig.order === 'asc' 
                    ? valA.localeCompare(valB)
                    : valB.localeCompare(valA);
            } else {
                return sortConfig.order === 'asc'
                    ? valA - valB
                    : valB - valA;
            }
        });
    }

    // 3. Render DOM rows
    tbody.innerHTML = '';
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center">No matching records found.</td></tr>';
        return;
    }

    filtered.forEach(row => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        
        const isPinnedMatch = isPinned(String(row.event_id));
        const pinStar = isPinnedMatch ? '⭐' : '☆';
        const customMark = row.target_is_custom ? '<span class="custom-mark" title="Custom target set">★</span>' : '';
        
        const notes = JSON.parse(localStorage.getItem('wcm.notes.v1') || '{}')[row.event_id] || '';

        tr.innerHTML = `
            <td data-label="Match & Date">
                <button class="row-pin-btn" data-eid="${row.event_id}" style="background:none;border:none;cursor:pointer;font-size:1rem;margin-right:4px;">${pinStar}</button>
                <strong>${getFlagEmoji(row.match)}</strong><br>
                <small style="color: #64748b;">${escapeHtml(row.date_time)}</small>
            </td>
            <td data-label="Venue">${escapeHtml(row.venue)}<br><small style="color:#64748b">${escapeHtml(row.host_city)}</small></td>
            <td data-label="Price & Target" class="price-cell">
                $${row.agg_lowest_price || 'N/A'}<br>
                <small style="color:#64748b;">${customMark}Target: $${Math.round(row.target_price)}</small>
            </td>
            <td data-label="Signal"><span class="badge signal-${(row.signal || 'stable').toLowerCase().replace(' ', '')}">${escapeHtml(row.signal)}</span></td>
            <td data-label="Face Multiplier">${row.multiplier ? `${row.multiplier.toFixed(1)}x` : '-'}</td>
            <td data-label="Family Cost" class="family-col">$${Math.round(row.family_cost) || '-'}</td>
            <td data-label="Family Fit" class="family-col">${escapeHtml(row.confidence_label)} (${row.confidence_score}%)</td>
            <td data-label="Reason" style="font-size:0.8rem;color:#475569;">${escapeHtml(row.reason)}</td>
            <td data-label="Notes">
                <input type="text" class="note-input row-note" data-eid="${row.event_id}" value="${escapeHtml(notes)}" placeholder="Add note...">
            </td>
            <td data-label="Decision">
                ${getDecisionBadge(row.decision, row.agg_best_url)}
            </td>
        `;

        // Click on row (except inputs/buttons) opens details modal
        tr.addEventListener('click', (e) => {
            if (e.target.closest('.row-pin-btn') || e.target.closest('.note-input') || e.target.closest('.badge-buy') || e.target.closest('.badge-monitor')) {
                return;
            }
            onSelectMatchCallback(row);
        });

        // Pin button listener
        tr.querySelector('.row-pin-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const eid = String(row.event_id);
            const pins = JSON.parse(localStorage.getItem('wcm.pinned.v2') || '{}');
            if (pins[eid] !== undefined) {
                delete pins[eid];
            } else {
                const reason = prompt('Why pin this match? (optional)', '') || '';
                pins[eid] = reason;
            }
            savePins(pins);
            onSettingsUpdate();
        });

        // Note save listener
        const noteInput = tr.querySelector('.row-note');
        noteInput.addEventListener('change', () => {
            const eid = String(row.event_id);
            const notes = JSON.parse(localStorage.getItem('wcm.notes.v1') || '{}');
            notes[eid] = noteInput.value;
            localStorage.setItem('wcm.notes.v1', JSON.stringify(notes));
        });

        tbody.appendChild(tr);
    });
}

function getDecisionBadge(decision, url) {
    if (decision === 'Buy') return `<a href="${url}" target="_blank" class="badge badge-buy" style="display:inline-block; padding:8px 12px; text-decoration:none;">BUY NOW</a>`;
    if (decision === 'Watch' || decision === 'Wait') return `<a href="${url}" target="_blank" class="badge badge-monitor" style="display:inline-block; padding:6px 10px; text-decoration:none; background:#fef9c3; color:#854d0e; border:1px solid #fde047;">WATCH</a>`;
    return `<span class="badge badge-wait" style="background:#f1f5f9; color:#94a3b8; border:1px solid #e2e8f0;">AVOID</span>`;
}

export function openDetailsModal(row, historySeries, onSaveCustomTargetCallback) {
    const modal = document.getElementById('details-modal');
    const content = document.getElementById('modal-body-content');
    if (!modal || !content) return;

    const diff = row.agg_lowest_price - row.target_price;
    const diffText = diff <= 0 
        ? `$${Math.abs(Math.round(diff))} BELOW target threshold`
        : `$${Math.round(diff)} above target price`;
    const diffColor = diff <= 0 ? '#16a34a' : '#dc2626';

    const lastObs = row.latest_observed_at ? new Date(row.latest_observed_at).toLocaleString() : 'N/A';

    let checklistItems = '';
    // kids checklist
    try {
        const isLate = row.date_time.includes('9:00pm') || row.date_time.includes('10:00pm') || row.date_time.includes('11:00pm') || row.date_time.includes('21:') || row.date_time.includes('22:');
        if (isLate) {
            checklistItems += `<li><span class="checklist-icon-warn">⚠️</span> Late evening kickoff starts after 9 PM (challenging for young kids)</li>`;
        } else {
            checklistItems += `<li><span class="checklist-icon-ok">✅</span> Daytime or early evening schedule is kid-friendly</li>`;
        }
    } catch {
        // skip
    }

    // travel checklist
    const city = (row.host_city || '').toLowerCase();
    const isLocal = LOCAL_CITIES.some(c => city.includes(c.toLowerCase()));
    if (isLocal) {
        checklistItems += `<li><span class="checklist-icon-ok">✅</span> Local/Driveable venue (no flights/hotels required)</li>`;
    } else {
        checklistItems += `<li><span class="checklist-icon-warn">✈️</span> Flight destination city (adds travel & lodging overhead)</li>`;
    }

    // freshness checklist
    if (row.latest_observed_at) {
        const hrsOld = (Date.now() - new Date(row.latest_observed_at).getTime()) / (1000 * 60 * 60);
        if (hrsOld > 24) {
            checklistItems += `<li><span class="checklist-icon-err">❌</span> Stale secondary feed: data has not synced in over 24 hours</li>`;
        } else {
            checklistItems += `<li><span class="checklist-icon-ok">✅</span> Secondary feed updated recently</li>`;
        }
    }

    // anomalies checklist
    if (row.anomalies && row.anomalies.length > 0) {
        checklistItems += `<li><span class="checklist-icon-warn">⚠️</span> Price Anomaly Detected: ${escapeHtml(row.anomalies.join(', '))}</li>`;
    } else {
        checklistItems += `<li><span class="checklist-icon-ok">✅</span> Prices align normally across major feeds</li>`;
    }

    content.innerHTML = `
        <div class="modal-match-title">${getFlagEmoji(row.match)}</div>
        <div style="font-size: 0.9rem; color: #64748b; margin-bottom: 15px;">
            ${escapeHtml(row.stage)} · ${escapeHtml(row.venue)} (${escapeHtml(row.host_city)})
        </div>

        <div class="modal-meta-grid">
            <div><strong>Kickoff Time:</strong> ${escapeHtml(row.date_time)}</div>
            <div><strong>Data Freshness:</strong> ${lastObs}</div>
            <div><strong>Mapping Confidence:</strong> ${row.confidence_label} (${row.confidence_score}%)</div>
            <div><strong>Mapping Method:</strong> ${escapeHtml(row.mapping_metadata.mappingMethod)}</div>
        </div>

        <div class="modal-section-title">Current Listings Comparison</div>
        <table class="modal-prices-table">
            <thead>
                <tr>
                    <th>Source</th>
                    <th>Observed Price</th>
                    <th>Url Link</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>SeatGeek</td>
                    <td>${row.sg_price ? `$${row.sg_price}` : '<span style="color:#94a3b8">Unavailable</span>'}</td>
                    <td>${row.sg_url ? `<a href="${row.sg_url}" target="_blank">Open feed</a>` : '-'}</td>
                </tr>
                <tr>
                    <td>TickPick</td>
                    <td>${row.tp_price ? `$${row.tp_price}` : '<span style="color:#94a3b8">Unavailable</span>'}</td>
                    <td>${row.tp_url ? `<a href="${row.tp_url}" target="_blank">Open feed</a>` : '-'}</td>
                </tr>
                <tr>
                    <td>Vivid Seats</td>
                    <td>${row.vs_price ? `$${row.vs_price}` : '<span style="color:#94a3b8">Unavailable</span>'}</td>
                    <td>${row.vs_url ? `<a href="${row.vs_url}" target="_blank">Open feed</a>` : '-'}</td>
                </tr>
            </tbody>
        </table>

        <div class="modal-section-title">Purchase Recommendation & Threshold</div>
        <div class="modal-decision-banner ${row.decision.toLowerCase()}">
            <div>
                <strong style="font-size: 1.1rem; display: block;">Decision: ${row.decision}</strong>
                <span style="font-size: 0.85rem;">Reason: ${escapeHtml(row.reason)}</span>
            </div>
            <div style="text-align: right;">
                <span style="font-size: 1.25rem; font-weight: 800;">$${row.agg_lowest_price}</span><br>
                <small>cheapest</small>
            </div>
        </div>

        <div style="margin-bottom: 20px; font-size: 0.88rem;">
            <strong>Comparison vs Target Price:</strong>
            <div style="color: ${diffColor}; font-weight: 700; margin-top: 4px;">
                ${diffText}
            </div>
        </div>

        <div class="modal-section-title">Purchase Feasibility Checks</div>
        <ul class="modal-checklist">
            ${checklistItems}
        </ul>

        <div class="modal-section-title">Strategic Targets Settings</div>
        <div class="modal-custom-target-block">
            <label for="modal-target-input"><strong>Set Personal Target Limit ($):</strong></label>
            <input type="number" id="modal-target-input" value="${Math.round(row.target_price)}" min="10">
            <button id="modal-save-target-btn" class="btn-link" style="padding: 6px 14px; border-radius: 6px;">Save Target</button>
            ${row.target_is_custom ? `<button id="modal-reset-target-btn" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.8rem;">Reset</button>` : ''}
        </div>
    `;

    // Show modal
    modal.style.display = 'block';

    // Click backdrop to close
    const closeModal = () => {
        modal.style.display = 'none';
    };

    const closeBtn = document.getElementById('close-details-modal');
    closeBtn.onclick = closeModal;

    window.onclick = (e) => {
        if (e.target === modal) {
            closeModal();
        }
    };

    // Save custom target action
    const saveBtn = document.getElementById('modal-save-target-btn');
    saveBtn.onclick = () => {
        const val = parseInt(document.getElementById('modal-target-input').value, 10);
        if (isNaN(val) || val <= 0) {
            alert('Please enter a valid target price');
            return;
        }
        onSaveCustomTargetCallback(row.event_id, val);
        closeModal();
    };

    // Reset custom target action
    const resetBtn = document.getElementById('modal-reset-target-btn');
    if (resetBtn) {
        resetBtn.onclick = () => {
            onSaveCustomTargetCallback(row.event_id, null); // clear
            closeModal();
        };
    }
}
