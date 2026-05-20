// User Preferences Module

import { loadPreferences, savePreferences } from './storage.js';

export const PREF_DEFAULTS = {
    homeBaseCity: 'New York / New Jersey',
    maxDriveHours: 4,
    ticketsCount: 4,
    maxTotalBudget: 1000,
    preferredVenues: [], // Empty means all venues are acceptable
    avoidLateGames: true,
    strongTeamPremiumTolerance: 'medium', // 'low', 'medium', 'high'
    officialFifaPreference: 'cheapest' // 'official' (Prefer official), 'trusted' (Any trusted), 'cheapest' (Cheapest)
};

export function getPreferences() {
    let prefs = loadPreferences();
    if (!prefs) {
        // Fallback to old keys for migration
        const oldTickets = localStorage.getItem('fcTickets');
        const oldBudget = localStorage.getItem('wcm.budget');
        const oldParking = localStorage.getItem('fcParking');
        const oldFood = localStorage.getItem('fcFood');

        prefs = { ...PREF_DEFAULTS };

        if (oldTickets) {
            const val = parseInt(oldTickets, 10);
            if (!isNaN(val)) prefs.ticketsCount = val;
        }
        if (oldBudget) {
            const val = parseInt(oldBudget, 10);
            if (!isNaN(val)) prefs.maxTotalBudget = val;
        }
        
        // Save initial migrated/default preferences
        savePreferences(prefs);
    } else {
        // Fill in missing default fields if user has an older prefs version
        let updated = false;
        for (const [key, value] of Object.entries(PREF_DEFAULTS)) {
            if (prefs[key] === undefined) {
                prefs[key] = value;
                updated = true;
            }
        }
        if (updated) {
            savePreferences(prefs);
        }
    }
    return prefs;
}

export function updatePreferences(newPrefs) {
    const current = getPreferences();
    const updated = { ...current, ...newPrefs };
    savePreferences(updated);

    // Keep legacy keys in sync for backward compatibility
    localStorage.setItem('fcTickets', updated.ticketsCount);
    localStorage.setItem('wcm.budget', updated.maxTotalBudget);
    
    return updated;
}
