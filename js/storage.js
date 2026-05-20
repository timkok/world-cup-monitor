// LocalStorage and Import/Export Utilities

const TARGETS_KEY = 'wcm.userTargets.v1';
const SEEN_KEY = 'wcm.seenHits.v1';
const PINS_KEY = 'wcm.pinned.v2';
const NOTES_KEY = 'wcm.notes.v1';
const FIFA_KEY = 'wcm.fifaData.v1';
const CHK_KEY = 'wcm.checklist.v1';
const THEME_KEY = 'wcm.theme';
const PREFS_KEY = 'wcm.preferences.v1';

export function loadUserTargets() {
    try { return JSON.parse(localStorage.getItem(TARGETS_KEY) || '{}'); } catch { return {}; }
}
export function saveUserTargets(t) {
    localStorage.setItem(TARGETS_KEY, JSON.stringify(t));
}

export function loadSeen() {
    try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}
export function saveSeen(s) {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
}

export function loadPins() {
    try {
        const raw = JSON.parse(localStorage.getItem(PINS_KEY) || '{}');
        if (Array.isArray(raw)) {
            const map = {};
            raw.forEach(id => map[id] = '');
            return map;
        }
        return raw;
    } catch { return {}; }
}
export function savePins(p) {
    localStorage.setItem(PINS_KEY, JSON.stringify(p));
}

export function loadNotes() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch { return {}; }
}
export function saveNotes(n) {
    localStorage.setItem(NOTES_KEY, JSON.stringify(n));
}

export function loadFifaData() {
    try { return JSON.parse(localStorage.getItem(FIFA_KEY) || '[]'); } catch { return []; }
}
export function saveFifaData(d) {
    localStorage.setItem(FIFA_KEY, JSON.stringify(d));
}

export function loadChecklist() {
    try { return JSON.parse(localStorage.getItem(CHK_KEY) || '{}'); } catch { return {}; }
}
export function saveChecklist(c) {
    localStorage.setItem(CHK_KEY, JSON.stringify(c));
}

export function loadTheme() {
    return localStorage.getItem(THEME_KEY) || 'light';
}
export function saveTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
}

export function loadPreferences() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}
export function savePreferences(prefs) {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export function exportSettings() {
    return {
        notes: localStorage.getItem(NOTES_KEY),
        pins: localStorage.getItem(PINS_KEY),
        targets: localStorage.getItem(TARGETS_KEY),
        fcTickets: localStorage.getItem('fcTickets'),
        fcParking: localStorage.getItem('fcParking'),
        fcFood: localStorage.getItem('fcFood'),
        budget: localStorage.getItem('wcm.budget'),
        preferences: localStorage.getItem(PREFS_KEY)
    };
}

export function validateAndImportSettings(jsonString) {
    try {
        const data = JSON.parse(jsonString);
        if (typeof data !== 'object' || data === null) {
            return { success: false, error: 'Settings data must be a valid JSON object.' };
        }
        
        // Simple schema validation
        const allowedKeys = ['notes', 'pins', 'targets', 'fcTickets', 'fcParking', 'fcFood', 'budget', 'preferences'];
        for (const key of Object.keys(data)) {
            if (!allowedKeys.includes(key)) {
                return { success: false, error: `Unexpected settings key: ${key}` };
            }
        }
        
        // Validation: Verify if inner contents are parseable (where applicable)
        if (data.notes) JSON.parse(data.notes);
        if (data.pins) JSON.parse(data.pins);
        if (data.targets) JSON.parse(data.targets);
        if (data.preferences) JSON.parse(data.preferences);

        // Apply to localStorage
        if (data.notes) localStorage.setItem(NOTES_KEY, data.notes);
        if (data.pins) localStorage.setItem(PINS_KEY, data.pins);
        if (data.targets) localStorage.setItem(TARGETS_KEY, data.targets);
        if (data.fcTickets) localStorage.setItem('fcTickets', data.fcTickets);
        if (data.fcParking) localStorage.setItem('fcParking', data.fcParking);
        if (data.fcFood) localStorage.setItem('fcFood', data.fcFood);
        if (data.budget) localStorage.setItem('wcm.budget', data.budget);
        if (data.preferences) localStorage.setItem(PREFS_KEY, data.preferences);

        return { success: true };
    } catch (e) {
        return { success: false, error: `Failed to import settings: ${e.message}` };
    }
}
