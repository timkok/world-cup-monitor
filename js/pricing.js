// Pricing Logic, Decision Engines, and Target Price Math

import { STRONG_TEAMS, LOCAL_CITIES } from './config.js';

export function getFaceValue(stage) {
    const s = (stage || '').toLowerCase();
    if (s.includes('final') && !s.includes('semi') && !s.includes('quarter')) return 600;
    if (s.includes('semi')) return 400;
    if (s.includes('quarter')) return 250;
    if (s.includes('16') || s.includes('32')) return 175;
    return 175; // Group stage
}

export function getStageWeight(stage) {
    const s = (stage || '').toLowerCase();
    if (s.includes('final') && !s.includes('semi') && !s.includes('quarter')) return 2.5;
    if (s.includes('semi')) return 2.0;
    if (s.includes('quarter')) return 1.5;
    if (s.includes('16') || s.includes('32')) return 1.2;
    return 1.0;
}

export function getTeamDemandWeight(matchName) {
    if (!matchName) return 1.0;
    let matchesCount = 0;
    for (const team of STRONG_TEAMS) {
        if (matchName.includes(team)) {
            matchesCount++;
        }
    }
    if (matchesCount >= 2) return 1.6;
    if (matchesCount === 1) return 1.3;
    return 1.0;
}

export function getLocationWeight(hostCity, preferences) {
    if (!hostCity || !preferences) return 1.0;
    
    const cityLower = hostCity.toLowerCase();
    const homeLower = (preferences.homeBaseCity || '').toLowerCase();
    
    // Exact match to home base city
    if (homeLower && cityLower.includes(homeLower)) {
        return 1.20; // 20% higher target because local
    }
    
    // Driveable city match (default within local driveable cities)
    const isLocalCity = LOCAL_CITIES.some(c => cityLower.includes(c.toLowerCase()));
    if (isLocalCity) {
        return 1.15; // 15% higher target
    }
    
    // Far city weight penalty
    return 0.85; // Lower target price for flight cities
}

export function getFamilyPenalty(row, preferences) {
    if (!row || !row.date_time || !preferences) return 1.0;
    if (!preferences.avoidLateGames) return 1.0;
    
    try {
        const match = row.date_time.match(/^([A-Za-z]+),.+·\s*(\d+):(\d+)([ap]m)/i);
        if (!match) return 1.0;
        
        let hour = parseInt(match[2], 10);
        const ampm = match[4].toLowerCase();
        if (ampm === 'pm' && hour !== 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        
        const isLate = hour >= 21; // 9pm or later
        if (isLate) {
            return 0.85; // 15% penalty to target price since kids cannot attend easily
        }
    } catch {
        // Fallback on parse failure
    }
    return 1.0;
}

export function getTargetPrice(row, currentPrice, faceValue, preferences) {
    if (!currentPrice || !row) return 0;
    
    let targetMultiplier = 1.0;
    targetMultiplier *= getLocationWeight(row.host_city, preferences);
    targetMultiplier *= getFamilyPenalty(row, preferences);
    
    // Tolerance adjustments
    const tolerance = preferences ? preferences.strongTeamPremiumTolerance : 'medium';
    if (tolerance === 'high') targetMultiplier *= 1.10;
    if (tolerance === 'low') targetMultiplier *= 0.90;

    const s = (row.stage || '').toLowerCase();
    const isSemiOrFinal = s.includes('final') || s.includes('semi');
    const isKnockout = s.includes('16') || s.includes('32') || s.includes('quarter');
    const isStrong = STRONG_TEAMS.some(team => (row.match || '').includes(team));

    if (isSemiOrFinal) {
        return currentPrice * 0.9 * targetMultiplier;
    } else if (isKnockout || isStrong) {
        return Math.min(currentPrice * 0.85 * targetMultiplier, faceValue * 6 * targetMultiplier);
    } else {
        return Math.min(currentPrice * 0.75 * targetMultiplier, faceValue * 4 * targetMultiplier);
    }
}

export function getDecision(currentPrice, targetPrice, signal) {
    if (!currentPrice) return 'Unknown';
    if (currentPrice <= targetPrice) {
        return 'Buy';
    }
    if (currentPrice <= targetPrice * 1.15) {
        if (signal === 'Declining') return 'Wait';
        return 'Watch';
    }
    if (currentPrice <= targetPrice * 1.5) {
        return 'Watch';
    }
    return 'Avoid';
}

export function computeConfidenceScore(row, historySeries) {
    let score = 0;

    // 1. Source coverage (max 45 points)
    const sources = [row.sg_price, row.tp_price, row.vs_price].filter(p => p != null);
    if (sources.length === 3) score += 45;
    else if (sources.length === 2) score += 30;
    else if (sources.length === 1) score += 15;

    // 2. Data Freshness (max 25 points)
    if (row.latest_observed_at) {
        const lastUpdated = new Date(row.latest_observed_at).getTime();
        const ageHours = (Date.now() - lastUpdated) / (1000 * 60 * 60);
        if (ageHours <= 6) score += 25;
        else if (ageHours <= 24) score += 15;
        else if (ageHours <= 48) score += 5;
    }

    // 3. Price History Length (max 20 points)
    const historyCount = historySeries ? historySeries.length : 0;
    if (historyCount >= 10) score += 20;
    else if (historyCount >= 5) score += 15;
    else if (historyCount >= 2) score += 10;

    // 4. Volatility (max 10 points)
    if (historySeries && historySeries.length >= 3) {
        const prices = historySeries.map(h => h.price);
        const mean = prices.reduce((s, v) => s + v, 0) / prices.length;
        const variance = prices.reduce((s, v) => s + (v - mean) * (v - mean), 0) / prices.length;
        const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
        
        if (cv <= 0.05) score += 10;
        else if (cv <= 0.15) score += 5;
    }

    // Deductions: Low mapping method quality
    if (row.mapping_metadata && row.mapping_metadata.mappingMethod === 'Venue') {
        score = Math.max(0, score - 10);
    }

    let label = 'Low';
    if (score >= 80) label = 'High';
    else if (score >= 50) label = 'Medium';

    return { score, label };
}

export function detectAnomalies(row, historySeries) {
    const anomalies = [];
    const currentPrice = row.agg_lowest_price;
    if (!currentPrice) return anomalies;

    // 1. Bargain Detection (>= 30% below 7d average)
    if (historySeries && historySeries.length >= 3) {
        const now = Date.now();
        const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
        const weekPrices = historySeries
            .filter(h => (now - h.t.getTime()) <= oneWeekMs)
            .map(h => h.price);
        
        if (weekPrices.length >= 2) {
            const avg7d = weekPrices.reduce((s, v) => s + v, 0) / weekPrices.length;
            if (currentPrice <= avg7d * 0.70) {
                anomalies.push('Bargain');
            }
        }
    }

    // 2. Spike Detection (>= 50% increase vs previous)
    if (historySeries && historySeries.length >= 2) {
        const prevPrice = historySeries[historySeries.length - 2].price;
        if (prevPrice > 0 && currentPrice >= prevPrice * 1.50) {
            anomalies.push('Spike');
        }
    }

    // 3. Cross-Market Outlier (one source >= 25% cheaper than the second cheapest source)
    const prices = [
        { src: 'SeatGeek', p: row.sg_price },
        { src: 'TickPick', p: row.tp_price },
        { src: 'Vivid',    p: row.vs_price }
    ].filter(x => x.p != null).sort((a, b) => a.p - b.p);

    if (prices.length >= 2) {
        const cheapest = prices[0].p;
        const secondCheapest = prices[1].p;
        if (secondCheapest > 0 && cheapest <= secondCheapest * 0.75) {
            anomalies.push('Outlier');
        }
    }

    // 4. FIFA Resale Opportunity (unverified/manual entry is way lower than secondary market)
    // Handled based on the comparison of resale records in final aggregations

    return anomalies;
}
