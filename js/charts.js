// Chart.js Trends Visualization Engine

let trendChartInstance = null;

export function updateChart(row, historySeries, period = 'all') {
    if (!row) return;

    const series = historySeries || [];

    let filtered = series;
    if (period === '1w') {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        filtered = series.filter(p => p.t.getTime() >= cutoff);
    } else if (period === '1m') {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        filtered = series.filter(p => p.t.getTime() >= cutoff);
    }

    const labels = filtered.map(p => p.t.toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }));
    const dataPoints = filtered.map(p => p.price);
    const fullTimestamps = filtered.map(p => p.t.toLocaleString());

    const canvas = document.getElementById('trendChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (trendChartInstance) {
        trendChartInstance.destroy();
    }

    // Vertical gradient fill for the area under the line
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 250);
    grad.addColorStop(0, 'rgba(37, 99, 235, 0.28)');
    grad.addColorStop(1, 'rgba(37, 99, 235, 0.02)');

    // Source color per point
    const srcToColor = src => {
        if (src === 'TickPick') return '#0d4c8a';
        if (src === 'Vivid') return '#9d174d';
        return '#b45309'; // SeatGeek or others
    };
    const pointColors = filtered.map(p => srcToColor(p.src));

    if (typeof Chart === 'undefined') {
        console.error('Chart.js library is not loaded');
        return;
    }

    trendChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Get-in Price ($)',
                data: dataPoints,
                borderColor: '#0b3d7a',
                backgroundColor: grad,
                borderWidth: 2.5,
                pointBackgroundColor: pointColors,
                pointBorderColor: '#fff',
                pointBorderWidth: 1.5,
                pointRadius: 3.5,
                pointHoverRadius: 6,
                fill: true,
                tension: 0.4,
                cubicInterpolationMode: 'monotone',
                spanGaps: true,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            animation: { duration: 350, easing: 'easeOutQuart' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#0f172a',
                    titleColor: '#fff',
                    titleFont: { size: 12, family: 'Inter', weight: '600' },
                    bodyFont: { size: 13, family: 'Inter' },
                    padding: 10,
                    cornerRadius: 6,
                    displayColors: false,
                    callbacks: {
                        title: ctx => fullTimestamps[ctx[0].dataIndex] || '',
                        label: ctx => {
                            const src = filtered[ctx.dataIndex] && filtered[ctx.dataIndex].src;
                            const label = src ? ` (${src})` : '';
                            return '$' + ctx.parsed.y.toLocaleString() + label;
                        },
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#64748b', font: { family: 'Inter', size: 11 }, maxTicksLimit: 8, autoSkip: true }
                },
                y: {
                    grid: { color: 'rgba(226,232,240,0.6)', drawBorder: false },
                    ticks: { color: '#64748b', font: { family: 'Inter', size: 11 }, callback: v => '$' + Number(v).toLocaleString() }
                }
            }
        }
    });
}
