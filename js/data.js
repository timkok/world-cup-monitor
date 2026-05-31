// Data Loader, Merging and Freshness Orchestrator

import { getFaceValue, getTargetPrice, computeConfidenceScore, detectAnomalies, getDecision } from './pricing.js?v=20260531-realtime';
import { matchByDateAndTeams, getMappingMetadata } from './matching.js?v=20260531-realtime';
import { loadUserTargets } from './storage.js?v=20260531-realtime';
import { getPreferences } from './preferences.js?v=20260531-realtime';
import { LOCAL_CITIES } from './config.js?v=20260531-realtime';

function fetchCsv(url) {
    return fetch(url)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error! status=${res.status}`);
            return res.text();
        })
        .then(text => {
            const parsed = Papa.parse(text, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true
            });
            return parsed.data || [];
        });
}

function fetchJson(url) {
    return fetch(url)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error! status=${res.status}`);
            return res.json();
        });
}

function fetchAliases() {
    return fetch('team_aliases.json')
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error! status=${res.status}`);
            return res.json();
        })
        .then(data => {
            const pairs = [];
            for (const canonical of Object.keys(data)) {
                if (canonical.startsWith('_')) continue;
                data[canonical].forEach(variant => {
                    pairs.push([variant, canonical]);
                });
            }
            // Sort longest variant first to prevent substring bugs
            pairs.sort((a, b) => b[0].length - a[0].length);
            return pairs;
        })
        .catch(() => []);
}

export function calculateFreshnessAge(observedAtStr) {
    if (!observedAtStr) return { ageHours: Infinity, status: 'Missing' };
    const date = new Date(observedAtStr);
    if (isNaN(date.getTime())) return { ageHours: Infinity, status: 'Missing' };
    const ageHours = (Date.now() - date.getTime()) / (1000 * 60 * 60);
    let status = 'Fresh';
    if (ageHours > 6) status = 'Very stale';
    else if (ageHours > 1.5) status = 'Stale';
    return { ageHours, status, date };
}

function statusEntryToFreshness(entry) {
    if (!entry) return calculateFreshnessAge(null);
    const base = calculateFreshnessAge(entry.latest_observed_at);
    return {
        ...base,
        status: entry.status || base.status,
        ageHours: entry.age_minutes != null ? entry.age_minutes / 60 : base.ageHours,
        rows: entry.rows,
        pricedRows: entry.priced_rows,
        generatedAt: entry.generated_at,
    };
}

function latestIso(values) {
    const timestamps = values
        .filter(Boolean)
        .map(value => new Date(value).getTime())
        .filter(value => !isNaN(value));
    if (!timestamps.length) return null;
    return new Date(Math.max(...timestamps)).toISOString();
}

export function loadAllData() {
    const preferences = getPreferences();
    const userTargets = loadUserTargets();

    return Promise.all([
        fetchCsv('seatgeek_data.csv'),
        fetchCsv('tickpick_data.csv').catch(() => []),
        fetchCsv('vivid_data.csv').catch(() => []),
        fetchCsv('price_history.csv').catch(() => []),
        fetchCsv('tickpick_history.csv').catch(() => []),
        fetchCsv('vivid_history.csv').catch(() => []),
        fetchAliases(),
        fetchJson('realtime_status.json').catch(() => null),
    ]).then(([sgSnapshot, tpSnapshot, vsSnapshot, sgHistory, tpHistory, vsHistory, teamAliases, realtimeStatus]) => {
        
        // 1. Core mapping & snapshots merge
        const snapshot = sgSnapshot.map(row => {
            const tpMatch = matchByDateAndTeams(row, tpSnapshot, 'name', 'venue', teamAliases);
            const vsMatch = matchByDateAndTeams(row, vsSnapshot, 'name', 'venue', teamAliases);
            
            const sgPrice = row.latest_low_usd != null && !isNaN(row.latest_low_usd) ? Number(row.latest_low_usd) : null;
            const tpPrice = tpMatch && tpMatch.matchedRow.low_price_usd != null ? Number(tpMatch.matchedRow.low_price_usd) : null;
            const vsPrice = vsMatch && vsMatch.matchedRow.low_price_usd != null ? Number(vsMatch.matchedRow.low_price_usd) : null;

            row.tp_event_id = tpMatch ? tpMatch.matchedRow.tickpick_event_id : null;
            row.vs_event_id = vsMatch ? vsMatch.matchedRow.vivid_event_id : null;

            // Pick cheapest across sources
            row.sg_observed_at = row.latest_observed_at || null;
            row.tp_observed_at = tpMatch ? tpMatch.matchedRow.observed_at : null;
            row.vs_observed_at = vsMatch ? vsMatch.matchedRow.observed_at : null;
            row.latest_source_observed_at = latestIso([row.sg_observed_at, row.tp_observed_at, row.vs_observed_at]);

            const candidates = [
                { src: 'SeatGeek', price: sgPrice, url: row.url, observedAt: row.sg_observed_at },
                { src: 'TickPick', price: tpPrice, url: tpMatch ? tpMatch.matchedRow.url : null, observedAt: row.tp_observed_at },
                { src: 'Vivid',    price: vsPrice, url: vsMatch ? vsMatch.matchedRow.url : null, observedAt: row.vs_observed_at },
            ].filter(c => c.price != null);

            let lowestPrice = null, bestUrl = row.url, bestSource = 'N/A', bestObservedAt = null;
            if (candidates.length) {
                candidates.sort((a, b) => a.price - b.price);
                lowestPrice = candidates[0].price;
                bestUrl = candidates[0].url;
                bestSource = candidates[0].src;
                bestObservedAt = candidates[0].observedAt;
            }

            row.agg_lowest_price = lowestPrice;
            row.agg_best_url = bestUrl;
            row.agg_source = bestSource;
            row.agg_observed_at = bestObservedAt;
            
            row.sg_price = sgPrice;
            row.sg_url = row.url;
            row.tp_price = tpPrice;
            row.tp_url = tpMatch ? tpMatch.matchedRow.url : null;
            row.vs_price = vsPrice;
            row.vs_url = vsMatch ? vsMatch.matchedRow.url : null;

            row.fv = getFaceValue(row.stage);
            row.multiplier = lowestPrice ? lowestPrice / row.fv : 0;
            
            const computedTarget = getTargetPrice(row, lowestPrice, row.fv, preferences);
            const userTarget = userTargets[row.event_id];
            row.target_price = (userTarget != null && !isNaN(userTarget) && userTarget > 0) ? Number(userTarget) : computedTarget;
            row.target_is_custom = userTarget != null && !isNaN(userTarget) && userTarget > 0;

            row.family_cost = lowestPrice ? (lowestPrice * preferences.ticketsCount) + 100 + (row.stage.includes('Group') ? 50 : 80) : 0; // fallback matching logic
            
            row.mapping_metadata = getMappingMetadata(row, tpMatch, vsMatch);

            return row;
        });

        // 2. Build merged history map
        const historyByEvent = new Map();
        
        const tpToSg = new Map();
        const vsToSg = new Map();
        snapshot.forEach(row => {
            if (row.tp_event_id != null) tpToSg.set(String(row.tp_event_id), String(row.event_id));
            if (row.vs_event_id != null) vsToSg.set(String(row.vs_event_id), String(row.event_id));
        });

        function addHist(sgId, observedAt, price, src) {
            if (sgId == null || price == null || isNaN(price)) return;
            const t = new Date(observedAt);
            if (isNaN(t.getTime())) return;
            const key = String(sgId);
            if (!historyByEvent.has(key)) historyByEvent.set(key, []);
            historyByEvent.get(key).push({ t, price: Number(price), src });
        }

        sgHistory.forEach(r => {
            if (r.event_id != null && r.low_usd != null) {
                addHist(r.event_id, r.observed_at, r.low_usd, 'SeatGeek');
            }
        });
        tpHistory.forEach(r => {
            if (r.tickpick_event_id != null && r.low_price_usd != null) {
                const sgId = tpToSg.get(String(r.tickpick_event_id));
                if (sgId) addHist(sgId, r.observed_at, r.low_price_usd, 'TickPick');
            }
        });
        vsHistory.forEach(r => {
            if (r.vivid_event_id != null && r.low_price_usd != null) {
                const sgId = vsToSg.get(String(r.vivid_event_id));
                if (sgId) addHist(sgId, r.observed_at, r.low_price_usd, 'Vivid');
            }
        });

        for (const arr of historyByEvent.values()) {
            arr.sort((a, b) => a.t - b.t);
        }

        // 3. Compute dynamic details post history mapping
        snapshot.forEach(row => {
            const historySeries = historyByEvent.get(String(row.event_id)) || [];
            
            // Trend computation
            let signal = 'Stable';
            let mean = null;
            let min = null;
            if (historySeries.length > 1 && row.agg_lowest_price) {
                const now = Date.now();
                const window = historySeries.filter(p => now - p.t.getTime() <= 7 * 24 * 60 * 60 * 1000);
                const activePoints = window.length >= 2 ? window : historySeries;
                const prices = activePoints.map(p => p.price);
                mean = prices.reduce((s, v) => s + v, 0) / prices.length;
                min = Math.min(...prices);
                const variance = prices.reduce((s, v) => s + (v - mean) * (v - mean), 0) / prices.length;
                const cv = mean ? Math.sqrt(variance) / mean : 0;

                if (cv > 0.08) signal = 'Volatile';
                else if (row.agg_lowest_price <= min * 1.05) signal = 'Near low';
                else if (row.agg_lowest_price < mean * 0.97) signal = 'Declining';
                else if (row.agg_lowest_price > mean * 1.03) signal = 'Rising';
            }

            row.signal = signal;
            row.signal_mean = mean;
            row.signal_min = min;
            row.decision = getDecision(row.agg_lowest_price, row.target_price, row.signal);

            // Anomaly detection
            row.anomalies = detectAnomalies(row, historySeries);

            // Confidence score calculation
            const conf = computeConfidenceScore(row, historySeries);
            row.confidence_score = conf.score;
            row.confidence_label = conf.label;

            // Re-evaluate target reason text based on preferences
            row.reason = generateDecisionReason(row, preferences);
        });

        // 4. Source freshness calculations
        const sgTimes = snapshot.map(r => r.latest_observed_at).filter(Boolean);
        const tpTimes = tpSnapshot.map(r => r.observed_at).filter(Boolean);
        const vsTimes = vsSnapshot.map(r => r.observed_at).filter(Boolean);
        const histTimes = sgHistory.map(r => r.observed_at).filter(Boolean);

        const aggregateTimes = [
            ...sgTimes,
            ...tpTimes,
            ...vsTimes,
        ];
        const latestHistory = [
            ...histTimes,
            ...tpHistory.map(r => r.observed_at).filter(Boolean),
            ...vsHistory.map(r => r.observed_at).filter(Boolean),
        ];

        const fallbackFreshness = {
            Aggregate: calculateFreshnessAge(latestIso(aggregateTimes)),
            SeatGeek: calculateFreshnessAge(latestIso(sgTimes)),
            TickPick: calculateFreshnessAge(latestIso(tpTimes)),
            Vivid: calculateFreshnessAge(latestIso(vsTimes)),
            History: calculateFreshnessAge(latestIso(latestHistory)),
        };

        const freshness = realtimeStatus ? {
            Aggregate: statusEntryToFreshness(realtimeStatus.aggregate),
            SeatGeek: statusEntryToFreshness(realtimeStatus.sources?.SeatGeek),
            TickPick: statusEntryToFreshness(realtimeStatus.sources?.TickPick),
            Vivid: statusEntryToFreshness(realtimeStatus.sources?.Vivid),
            FIFA: statusEntryToFreshness(realtimeStatus.sources?.FIFA),
            History: fallbackFreshness.History,
            generatedAt: realtimeStatus.generated_at,
        } : fallbackFreshness;

        return {
            snapshot,
            historyByEvent,
            freshness,
            aliases: teamAliases,
            realtimeStatus
        };
    });
}

function generateDecisionReason(row, preferences) {
    const parts = [];
    const currentPrice = row.agg_lowest_price;
    const targetPrice = row.target_price;

    if (row.decision === 'Avoid') {
        parts.push(row.multiplier > 10 ? `${Math.round(row.multiplier)}x face, avoid` : 'Price above target');
    } else if (row.decision === 'Buy') {
        if (row.confidence_label === 'Low') {
            parts.push('Buy candidate (low confidence, verify first)');
        } else {
            parts.push('Cheaper than target, buy now');
        }
    } else if (row.decision === 'Wait') {
        parts.push('Declining price trend, wait');
    } else {
        parts.push('Close to target, monitoring');
    }

    // driveable logic
    const city = (row.host_city || '').toLowerCase();
    const isLocal = LOCAL_CITIES.some(c => city.includes(c.toLowerCase()));
    if (isLocal) {
        parts.push('local/driveable');
    } else {
        parts.push('requires travel');
    }

    if (row.anomalies.length) {
        parts.push(`Anomalies: ${row.anomalies.join(', ')}`);
    }

    return parts.slice(0, 2).join('. ');
}
