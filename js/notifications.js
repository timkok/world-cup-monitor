// Browser Notifications Handler

import { loadSeen, saveSeen } from './storage.js?v=20260531-realtime';

export function initNotifications() {
    const notifyBtn = document.getElementById('enable-notifications');
    if (!notifyBtn) return;

    if (typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'granted') {
            notifyBtn.style.display = 'none';
        } else {
            notifyBtn.addEventListener('click', () => {
                Notification.requestPermission().then(permission => {
                    if (permission === 'granted') {
                        notifyBtn.style.display = 'none';
                        new Notification("Notifications enabled!", {
                            body: "You'll be alerted when prices drop below your targets.",
                            icon: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚽</text></svg>"
                        });
                    }
                });
            });
        }
    } else {
        notifyBtn.style.display = 'none';
    }
}

export function checkAndNotifyHits(hits) {
    if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') {
        return;
    }

    const seen = loadSeen();
    let updated = false;

    for (const r of hits) {
        const key = `${r.event_id}:${Math.round(r.target_price)}`;
        if (seen.has(key)) continue;
        
        try {
            new Notification(`🎯 Target hit: ${r.match}`, {
                body: `$${r.agg_lowest_price} on ${r.agg_source} — target: $${Math.round(r.target_price)}`,
                tag: String(r.event_id),
            });
            seen.add(key);
            updated = true;
        } catch (e) {
            // Ignore notification error
        }
    }

    if (updated) {
        saveSeen(seen);
    }
}
