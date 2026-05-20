// Data Loader, Merging and Freshness Orchestrator

import { getFaceValue, getTargetPrice, computeConfidenceScore, detectAnomalies, getDecision } from './pricing.js';
import { matchByDateAndTeams, getMappingMetadata } from './matching.js';
import { loadUserTargets } from './storage.js';
import { getPreferences } from './preferences.js';

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
    if (ageHours > 24) status = 'Stale';
    else if (ageHours > 6) status = 'Aging';
    return { ageHours, status, date };
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
    ]).then(([sgSnapshot, tpSnapshot, vsSnapshot, sgHistory, tpHistory, vsHistory, teamAliases]) => {
        
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
            const candidates = [
                { src: 'SeatGeek', price: sgPrice, url: row.url },
                { src: 'TickPick', price: tpPrice, url: tpMatch ? tpMatch.matchedRow.url : null },
                { src: 'Vivid',    price: vsPrice, url: vsMatch ? vsMatch.matchedRow.url : null },
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

        const freshness = {
            SeatGeek: calculateFreshnessAge(sgTimes.length ? sgTimes.sort().reverse()[0] : null),
            TickPick: calculateFreshnessAge(tpTimes.length ? tpTimes.sort().reverse()[0] : null),
            Vivid: calculateFreshnessAge(vsTimes.length ? vsTimes.sort().reverse()[0] : null),
            History: calculateFreshnessAge(histTimes.length ? histTimes.sort().reverse()[0] : null),
        };

        return {
            snapshot,
            historyByEvent,
            freshness,
            aliases: teamAliases
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
