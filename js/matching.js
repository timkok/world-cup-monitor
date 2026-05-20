// Match Mapping and Normalization Engines

import { MONTH_MAP } from './config.js';

export function normalizeString(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function extractMatchNumber(str) {
    if (!str) return null;
    const m = str.match(/match\s+(\d+)/i);
    return m ? m[1] : null;
}

export function applyAliases(s, teamAliasPairs = []) {
    if (!s || !teamAliasPairs.length) return s;
    let out = s;
    for (const [variant, canonical] of teamAliasPairs) {
        if (variant === canonical) continue;
        if (out.indexOf(variant) !== -1) out = out.split(variant).join(canonical);
    }
    return out;
}

export function extractTeams(str, teamAliasPairs = []) {
    if (!str) return [];
    const parts = str.toLowerCase().split(/vs\.?/);
    if (parts.length === 2) {
        return [
            applyAliases(normalizeString(parts[0]), teamAliasPairs),
            applyAliases(normalizeString(parts[1]), teamAliasPairs),
        ];
    }
    return [];
}

export function getMatchDateString(dateTimeStr) {
    if (!dateTimeStr) return null;
    const m = dateTimeStr.match(/,\s*([A-Za-z]+)\s*(\d+)/);
    if (!m) return null;
    const month = MONTH_MAP[m[1].substring(0, 3)];
    const day = String(m[2]).padStart(2, '0');
    return `2026-${month}-${day}`;
}

export function matchByDateAndTeams(sgRow, candidateRows, nameField, venueField, teamAliasPairs = []) {
    const sgDateStr = getMatchDateString(sgRow.date_time);
    if (!sgDateStr) return null;

    const sgTeams = extractTeams(sgRow.match, teamAliasPairs);
    const sgMatchNum = extractMatchNumber(sgRow.match);

    for (const r of candidateRows) {
        if (!r.start_date || !String(r.start_date).startsWith(sgDateStr)) continue;

        const rName = r[nameField] || '';
        
        // 1. Match Number
        const rMatchNum = extractMatchNumber(rName);
        if (sgMatchNum && rMatchNum && sgMatchNum === rMatchNum) {
            return { matchedRow: r, method: 'Match Number', confidence: 'High' };
        }

        // 2. Teams
        if (sgTeams.length === 2) {
            const norm = applyAliases(normalizeString(rName), teamAliasPairs);
            if (norm.includes(sgTeams[0]) && norm.includes(sgTeams[1])) {
                return { matchedRow: r, method: 'Teams', confidence: 'High' };
            }
        }

        // 3. Venue
        const sgV = normalizeString(sgRow.venue);
        const rV = normalizeString(r[venueField]);
        if (sgV && rV && (sgV.includes(rV) || rV.includes(sgV))) {
            return { matchedRow: r, method: 'Venue', confidence: 'Medium' };
        }
    }

    return null;
}

export function getMappingMetadata(row, tpMatchResult, vsMatchResult) {
    const matchedSources = ['SeatGeek'];
    const missingSources = [];
    let method = 'N/A';
    let confidence = 'Low';

    if (tpMatchResult) {
        matchedSources.push('TickPick');
        method = tpMatchResult.method;
        if (tpMatchResult.confidence === 'High') confidence = 'High';
        else if (confidence !== 'High') confidence = 'Medium';
    } else {
        missingSources.push('TickPick');
    }

    if (vsMatchResult) {
        matchedSources.push('Vivid');
        method = vsMatchResult.method;
        if (vsMatchResult.confidence === 'High') confidence = 'High';
        else if (confidence !== 'High') confidence = 'Medium';
    } else {
        missingSources.push('Vivid');
    }

    if (!tpMatchResult && !vsMatchResult) {
        method = 'None';
        confidence = 'Low';
    }

    return {
        matchedSources,
        missingSources,
        mappingMethod: method,
        mappingConfidence: confidence
    };
}
