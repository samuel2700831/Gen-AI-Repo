import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Activity, ArrowDownToLine, BarChart3, ChevronRight, CircleHelp,
  CloudUpload, DollarSign, FileSpreadsheet, Filter, MousePointer2, Search,
  ShoppingCart, Target, TrendingUp, Wallet, X,
} from 'lucide-react';
import {
  CartesianGrid, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area,
} from 'recharts';
import { aggregate, filterRows, groupRows, parseCSV, sampleRows, timeSeries, toCSV } from './lib/analytics';
import type { CampaignRow, Filters, Metrics } from './lib/analytics';

type View = 'overview' | 'platforms' | 'campaigns' | 'timeseries';
type SortKey = 'name' | 'spend' | 'clicks' | 'conversions' | 'revenue' | 'roi' | 'cpa';
type MetricChoice = 'spend' | 'clicks' | 'conversions' | 'revenue' | 'roi' | 'conversionRate';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 50000;

const views: { id: View; label: string; icon: typeof BarChart3; eyebrow: string; title: string; description: string }[] = [
  { id: 'overview', label: 'Overview', icon: Activity, eyebrow: 'Performance snapshot', title: 'Your spend, in perspective.', description: 'A clear read on what your campaigns are returning.' },
  { id: 'platforms', label: 'Platform comparison', icon: BarChart3, eyebrow: 'Channel efficiency', title: 'Compare your channels.', description: 'See where each platform is turning budget into outcomes.' },
  { id: 'campaigns', label: 'Campaign details', icon: FileSpreadsheet, eyebrow: 'Campaign register', title: 'Every campaign, accounted for.', description: 'Search and sort campaign-level performance across your selection.' },
  { id: 'timeseries', label: 'Time series', icon: TrendingUp, eyebrow: 'Performance over time', title: 'Find the shape of your results.', description: 'Change the interval and metric to read your performance over time.' },
];
const palette = ['#bf6541', '#427e6c', '#d3a044', '#617fa0', '#aa6e8a', '#849550', '#786caa'];
const money = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'N/A' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const number = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'N/A' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'N/A' : `${value.toFixed(1)}%`;
const shortDate = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
const extent = (rows: CampaignRow[]) => {
  const dates = rows.map((row) => row.date).sort();
  return { start: dates[0] ?? '', end: dates[dates.length - 1] ?? '' };
};
const metricTitle: Record<MetricChoice, string> = { spend: 'Spend', clicks: 'Clicks', conversions: 'Conversions', revenue: 'Revenue', roi: 'ROI', conversionRate: 'Conversion rate' };
const metricValue = (metrics: Metrics, key: MetricChoice) => metrics[key];
const fmtMetric = (value: number | null, key: MetricChoice) => key === 'spend' || key === 'revenue' ? money(value) : key === 'roi' || key === 'conversionRate' ? percent(value) : number(value);

function MetricCard({ label, value, icon: Icon, caption }: { label: string; value: string; icon: typeof Wallet; caption: string }) {
  return <article className="metric-card" data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
    <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon /></span></div>
    <div className="metric-value">{value}</div><div className="metric-caption">{caption}</div>
  </article>;
}

function EmptyState({ reset }: { reset: () => void }) {
  return <div className="empty-state" data-testid="empty-filter-results"><div className="empty-mark"><Filter size={19} /></div>
    <h3>No results in this slice.</h3><p>Try widening the date range or clearing one of the active filters to bring campaigns back into view.</p>
    <button className="button" onClick={reset} data-testid="button-reset-empty"><X size={14} /> Clear filters</button>
  </div>;
}

function MetricTooltip({ active, payload, label, mode }: { active?: boolean; payload?: Array<{ name: string; value: number | null; color?: string; dataKey?: string }>; label?: string | number; mode?: 'dual' | MetricChoice }) {
  if (!active || !payload?.length) return null;
  const title = typeof label === 'number' ? shortDate(new Date(label).toISOString().slice(0, 10)) : label;
  return <div style={{ background: '#252f3d', border: '1px solid #48515d', borderRadius: 7, padding: '10px 12px', color: '#f6f0e5', fontSize: 11, boxShadow: '0 8px 24px #1d253322' }}>
    <div style={{ color: '#bdc2c3', marginBottom: 7 }}>{title}</div>
    {payload.map((entry, i) => {
      const key = String(entry.dataKey ?? entry.name);
      const kind: MetricChoice = key === 'value' && mode && mode !== 'dual' ? mode : (key === 'spend' || key === 'revenue' || key === 'roi' || key === 'clicks' || key === 'conversions') ? key : 'spend';
      return <div key={`${key}-${i}`} style={{ display: 'flex', gap: 18, justifyContent: 'space-between', minWidth: 145, marginTop: 4 }}>
        <span style={{ color: entry.color }}>{entry.name}</span><strong>{fmtMetric(entry.value, kind)}</strong>
      </div>;
    })}
  </div>;
}

function App() {
  const initialRows = useMemo(() => sampleRows(), []);
  const [rows, setRows] = useState<CampaignRow[]>(initialRows);
  const [isSample, setIsSample] = useState(true);
  const [view, setView] = useState<View>('overview');
  const [filters, setFilters] = useState<Filters>(() => ({ ...extent(initialRows), channels: [], audiences: [], goals: [] }));
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('spend');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [interval, setInterval] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [metric, setMetric] = useState<MetricChoice>('spend');
  const [helpOpen, setHelpOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredRows = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const stats = useMemo(() => aggregate(filteredRows), [filteredRows]);
  const bounds = useMemo(() => extent(rows), [rows]);
  const channels = useMemo(() => Array.from(new Set(rows.map((row) => row.channel))).sort(), [rows]);
  const audiences = useMemo(() => Array.from(new Set(rows.map((row) => row.audience))).sort(), [rows]);
  const goals = useMemo(() => Array.from(new Set(rows.map((row) => row.goal))).sort(), [rows]);
  const current = views.find((item) => item.id === view) ?? views[0];
  const resetFilters = () => setFilters({ ...bounds, channels: [], audiences: [], goals: [] });

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) { setError('This file is larger than 5 MB. Choose a smaller CSV and try again.'); return; }
    try {
      const parsed = parseCSV(await file.text());
      if (!parsed.length) throw new Error('The CSV contains no campaign records.');
      if (parsed.length > MAX_ROWS) throw new Error('This CSV has more than 50,000 rows. Split it into smaller files and try again.');
      setRows(parsed); setIsSample(false); setFilters({ ...extent(parsed), channels: [], audiences: [], goals: [] });
      setError(''); setSearch(''); setView('overview');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'We could not read that CSV. Check the schema and try again.');
    }
  };
  const download = (filename: string, content: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
  };
  const exportFiltered = () => download('adscope-filtered-campaigns.csv', toCSV(filteredRows));
  const downloadSample = () => download('adscope-sample.csv', toCSV(sampleRows()));
  const setFilter = (key: 'start' | 'end', value: string) => setFilters((old) => ({ ...old, [key]: value }));
  const toggleMulti = (key: 'channels' | 'audiences' | 'goals', value: string) => setFilters((old) => ({
    ...old, [key]: old[key].includes(value) ? old[key].filter((item) => item !== value) : [...old[key], value],
  }));
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDirection('desc'); }
  };

  const groupedCampaigns = useMemo(() => {
    const grouped = groupRows(filteredRows, 'campaign');
    const q = search.trim().toLowerCase();
    return grouped.map((item) => {
      const sources = filteredRows.filter((row) => row.campaign === item.name && row.channel === item.channel);
      return { ...item, audience: [...new Set(sources.map(row => row.audience))].join(', '), goal: [...new Set(sources.map(row => row.goal))].join(', ') };
    })
      .filter((item) => `${item.name} ${item.channel} ${item.audience} ${item.goal}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const av = sortKey === 'name' ? a.name.toLowerCase() : a[sortKey] ?? -Infinity;
        const bv = sortKey === 'name' ? b.name.toLowerCase() : b[sortKey] ?? -Infinity;
        const result = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av) - Number(bv);
        return result * (sortDirection === 'asc' ? 1 : -1);
      });
  }, [filteredRows, search, sortKey, sortDirection]);
  const platforms = useMemo(() => groupRows(filteredRows, 'channel').sort((a, b) => b.spend - a.spend), [filteredRows]);
  const trend = useMemo(() => timeSeries(filteredRows, interval), [filteredRows, interval]);
  const chartTrend = useMemo(() => timeSeries(filteredRows, 'daily').map((entry) => ({ ...entry, x: entry.timestamp, spend: entry.spend, conversions: entry.conversions })), [filteredRows]);
  const metricSeries = useMemo(() => trend.map((entry) => ({ ...entry, x: entry.timestamp, value: metricValue(entry, metric) })), [trend, metric]);
  const activeCount = filters.channels.length + filters.audiences.length + filters.goals.length +
    (filters.start !== bounds.start ? 1 : 0) + (filters.end !== bounds.end ? 1 : 0);

  const renderCampaignTable = (compact = false) => <div className="table-wrap"><table>
    <thead><tr>
      <th><button className="sort-button" onClick={() => toggleSort('name')}>Campaign {sortKey === 'name' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</button></th>
      {!compact && <th>Channel</th>}
      {!compact && <th>Audience</th>}
      {!compact && <th>Goal</th>}
      <th><button className="sort-button" onClick={() => toggleSort('spend')}>Spend {sortKey === 'spend' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</button></th>
      <th><button className="sort-button" onClick={() => toggleSort('clicks')}>Clicks {sortKey === 'clicks' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</button></th>
      <th><button className="sort-button" onClick={() => toggleSort('conversions')}>Conversions {sortKey === 'conversions' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</button></th>
      {!compact && <th>Revenue</th>}
      <th><button className="sort-button" onClick={() => toggleSort('roi')}>ROI {sortKey === 'roi' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</button></th>
      {!compact && <th><button className="sort-button" onClick={() => toggleSort('cpa')}>CPA {sortKey === 'cpa' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</button></th>}
    </tr></thead>
    <tbody>{(compact ? groupedCampaigns.slice(0, 5) : groupedCampaigns).map((item) => <tr key={`${item.channel}-${item.name}`} data-testid={`row-campaign-${`${item.channel}-${item.name}`.replaceAll(/[^a-z0-9]+/gi, '-')}`}>
      <td className="campaign-name">{item.name}</td>{!compact && <><td><span className="channel-dot" style={{ background: palette[channels.indexOf(item.channel) % palette.length] }} />{item.channel}</td><td>{item.audience}</td><td>{item.goal}</td></>}
      <td className="number">{money(item.spend)}</td><td className="number">{number(item.clicks)}</td><td className="number">{number(item.conversions)}</td>
      {!compact && <td className="number">{money(item.revenue)}</td>}<td className="number">{percent(item.roi)}</td>{!compact && <td className="number">{money(item.cpa)}</td>}
    </tr>)}</tbody>
  </table></div>;

  const renderChart = () => <div className="panel">
    <div className="panel-head"><div><h2 className="panel-title">Spend against conversions</h2><p className="panel-description">Daily totals across the selected period</p></div><span className="pill">USD + conversions</span></div>
    {filteredRows.length ? <>
      <div className="series-key"><span><i className="key-dot" style={{ background: '#bf6541' }} />Spend · USD</span><span><i className="key-dot" style={{ background: '#427e6c' }} />Conversions · count</span></div>
      <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={chartTrend} margin={{ top: 4, right: 14, left: 5, bottom: 3 }}>
        <CartesianGrid strokeDasharray="3 5" vertical={false} /><XAxis dataKey="timestamp" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(v))} minTickGap={28} />
        <YAxis yAxisId="usd" orientation="left" tickFormatter={(v) => `$${v}`} domain={[0, 'auto']} axisLine={false} tickLine={false} label={{ value: 'USD', angle: -90, position: 'insideLeft', fill: '#8b8f8b', fontSize: 10 }} />
        <YAxis yAxisId="count" orientation="right" domain={[0, 'auto']} axisLine={false} tickLine={false} label={{ value: 'Conversions · count', angle: 90, position: 'insideRight', fill: '#8b8f8b', fontSize: 10 }} />
        <Tooltip content={<MetricTooltip mode="dual" />} />
        <Bar yAxisId="usd" dataKey="spend" name="Spend" fill="#bf6541" radius={[3, 3, 0, 0]} maxBarSize={22} />
        <Line yAxisId="count" dataKey="conversions" name="Conversions" stroke="#427e6c" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
      </ComposedChart></ResponsiveContainer></div>
    </> : <EmptyState reset={resetFilters} />}
  </div>;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNavOpen ? 'mobile-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Activity size={19} strokeWidth={2.4} /></div><div><div className="brand-name">AdScope</div><div className="brand-sub">Campaign intelligence</div></div><button className="mobile-close" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><X size={16} /></button></div>
      <div className="nav-label">Workspace</div>
      <nav className="nav-list" aria-label="Main navigation">{views.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => { setView(id); setMobileNavOpen(false); }} aria-current={view === id ? 'page' : undefined} data-testid={`nav-${id}`}><Icon />{label}</button>)}</nav>
      <div className="side-bottom"><div className="privacy-note"><strong>Private by design</strong>Your CSV stays in this browser session. Nothing is uploaded to a server.</div><div className="side-foot">ADSCOPE · LOCAL ANALYSIS</div></div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <div className="crumb"><button className="button mobile-menu" onClick={() => setMobileNavOpen((open) => !open)} aria-label="Open navigation" data-testid="button-mobile-menu"><BarChart3 size={15} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{current.label}</strong></div>
        <div className="top-actions"><span className="session-tag">Session-only dataset</span>{isSample && <span className="badge-sample" data-testid="badge-sample-data">Sample dataset</span>}
          <button className="button" onClick={() => setHelpOpen((open) => !open)} aria-expanded={helpOpen} data-testid="button-schema-help"><CircleHelp size={15} />CSV schema</button>
          <button className="button primary" onClick={() => inputRef.current?.click()} data-testid="button-upload"><CloudUpload size={15} />Upload CSV</button>
          <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={onUpload} hidden data-testid="input-upload-csv" />
        </div>
      </header>
      <div className="content">
        <div className="page-heading"><div><div className="eyebrow">{current.eyebrow}</div><h1>{current.title}</h1><p className="page-subtitle">{current.description}</p></div>
          <button className="button" onClick={exportFiltered} disabled={!filteredRows.length} data-testid="button-export"><ArrowDownToLine size={15} />Export filtered CSV</button>
        </div>
        {error && <div className="alert" role="alert" data-testid="status-upload-error">{error}</div>}
        {filteredRows.length > 0 && stats.revenue === null && <div className="alert" role="status">Revenue and ROI are unavailable for this selection because one or more rows have no revenue. Add complete revenue data to your CSV to calculate ROI: (revenue − spend) ÷ spend × 100%.</div>}
        {filteredRows.length > 0 && stats.spend === 0 && stats.revenue !== null && <div className="alert" role="status">ROI is unavailable because total spend is zero.</div>}
        {helpOpen && <section className="upload-help" aria-label="CSV upload schema"><h3>Bring your campaign data</h3><p>CSV uploads are parsed in your browser. Keep files under 5 MB and 50,000 data rows. A failed import never replaces the current dataset.</p><div className="schema">date, campaign, channel, audience, goal, spend, clicks, conversions, revenue</div><p style={{ marginTop: 8 }}>Use ISO dates (YYYY-MM-DD), numeric spend/clicks/conversions, and leave revenue blank when unknown. Currency is interpreted as USD.</p><button className="button" onClick={downloadSample} data-testid="button-download-sample"><ArrowDownToLine size={14} />Download sample CSV</button></section>}
        <section className="filters" aria-label="Shared performance filters">
          <div className="filter-date"><label htmlFor="filter-start">From · inclusive</label><input id="filter-start" type="date" min={bounds.start} max={filters.end || bounds.end} value={filters.start} onChange={(e) => setFilter('start', e.target.value)} data-testid="input-filter-start" /></div>
          <div className="filter-date"><label htmlFor="filter-end">Through · inclusive</label><input id="filter-end" type="date" min={filters.start || bounds.start} max={bounds.end} value={filters.end} onChange={(e) => setFilter('end', e.target.value)} data-testid="input-filter-end" /></div>
          <div className="filter-select"><label htmlFor="filter-channel">Channel</label><select id="filter-channel" value="" onChange={(e) => e.target.value && toggleMulti('channels', e.target.value)} data-testid="select-filter-channel"><option value="">{filters.channels.length ? `${filters.channels.length} selected` : 'All channels'}</option>{channels.map((item) => <option key={item} value={item}>{filters.channels.includes(item) ? '✓ ' : ''}{item}</option>)}</select></div>
          <div className="filter-select"><label htmlFor="filter-audience">Audience</label><select id="filter-audience" value="" onChange={(e) => e.target.value && toggleMulti('audiences', e.target.value)} data-testid="select-filter-audience"><option value="">{filters.audiences.length ? `${filters.audiences.length} selected` : 'All audiences'}</option>{audiences.map((item) => <option key={item} value={item}>{filters.audiences.includes(item) ? '✓ ' : ''}{item}</option>)}</select></div>
          <div className="filter-select"><label htmlFor="filter-goal">Goal</label><select id="filter-goal" value="" onChange={(e) => e.target.value && toggleMulti('goals', e.target.value)} data-testid="select-filter-goal"><option value="">{filters.goals.length ? `${filters.goals.length} selected` : 'All goals'}</option>{goals.map((item) => <option key={item} value={item}>{filters.goals.includes(item) ? '✓ ' : ''}{item}</option>)}</select></div>
          <span className="filters-help">{filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()} records</span>
        </section>
        {activeCount > 0 && <div className="active-filters">
          {filters.start !== bounds.start && <span className="filter-chip">From {filters.start}</span>}{filters.end !== bounds.end && <span className="filter-chip">Through {filters.end}</span>}
          {filters.channels.map((v) => <span className="filter-chip" key={`c${v}`}>{v}</span>)}{filters.audiences.map((v) => <span className="filter-chip" key={`a${v}`}>{v}</span>)}{filters.goals.map((v) => <span className="filter-chip" key={`g${v}`}>{v}</span>)}
          <button className="subtle-link" onClick={resetFilters} data-testid="button-clear-filters">Clear filters</button>
        </div>}
        {view === 'overview' && <div data-testid="view-overview">
          <div className="metric-grid">
            <MetricCard label="Spend" value={money(stats.spend)} caption="Total paid media investment" icon={Wallet} />
            <MetricCard label="Conversions" value={number(stats.conversions)} caption="Attributed outcomes" icon={Target} />
            <MetricCard label="Cost per conversion" value={money(stats.cpa)} caption="Spend ÷ conversions" icon={DollarSign} />
            <MetricCard label="ROI" value={percent(stats.roi)} caption="Revenue less spend ÷ spend" icon={TrendingUp} />
          </div>
          {renderChart()}
          <div className="overview-lower">
            <div className="panel"><div className="panel-head"><div><h2 className="panel-title">Campaign leaders</h2><p className="panel-description">Sorted by spend · top five in your current selection</p></div><button className="subtle-link" onClick={() => setView('campaigns')}>View all campaigns →</button></div>
              {filteredRows.length ? renderCampaignTable(true) : <EmptyState reset={resetFilters} />}
            </div>
            <div className="panel insight-card"><div className="insight-kicker">Selection at a glance</div><div className="insight-number">{stats.campaigns}</div><div className="insight-copy">campaigns in view across {new Set(filteredRows.map((r) => r.channel)).size} channels. {stats.cpc == null ? 'Click cost is N/A without clicks.' : `Average click cost is ${money(stats.cpc)}.`}</div>
              <div style={{ borderTop: '1px solid #e9e3d9', marginTop: 17, paddingTop: 15 }}><div className="insight-kicker">Attributed revenue</div><div style={{ font: '500 17px var(--app-font-mono)', marginTop: 8, color: '#35404b' }}>{money(stats.revenue)}</div><div className="insight-copy" style={{ marginTop: 5 }}>Reported total for this filtered selection.</div></div>
            </div>
          </div>
        </div>}
        {view === 'platforms' && <div data-testid="view-platforms">
          <div className="metric-grid"><MetricCard label="Channels" value={number(platforms.length)} caption="Platforms in current view" icon={BarChart3} /><MetricCard label="Spend" value={money(stats.spend)} caption="Across selected channels" icon={Wallet} /><MetricCard label="Clicks" value={number(stats.clicks)} caption="Paid traffic delivered" icon={MousePointer2} /><MetricCard label="Conversions" value={number(stats.conversions)} caption="Attributed outcomes" icon={ShoppingCart} /></div>
          {platforms.length ? <div className="platform-grid"><div className="platform-row" style={{ paddingTop: 6, paddingBottom: 1, color: '#858985', font: '500 9px var(--app-font-mono)', textTransform: 'uppercase' }}><div>Channel</div><div>Spend · USD</div><div>Clicks · count</div><div>Conversions · count</div><div>ROI · %</div></div>
            {platforms.map((platform, i) => <article className="panel platform-row" key={platform.name} data-testid={`platform-row-${platform.name.replaceAll(/[^a-z0-9]+/gi, '-')}`}>
              <div><div className="platform-name"><span className="channel-dot" style={{ background: palette[i % palette.length] }} />{platform.name}</div><div className="platform-meta">{platform.campaigns} campaigns · CPA {money(platform.cpa)}</div></div>
              <div><div className="platform-stat-label">Spend · USD</div><div className="platform-stat-value">{money(platform.spend)}</div><div className="barline"><span style={{ width: `${stats.spend ? Math.max(2, platform.spend / stats.spend * 100) : 0}%` }} /></div></div>
              <div><div className="platform-stat-label">Clicks · count</div><div className="platform-stat-value">{number(platform.clicks)}</div></div>
              <div><div className="platform-stat-label">Conversions · count</div><div className="platform-stat-value">{number(platform.conversions)}</div></div>
              <div><div className="platform-stat-label">ROI · %</div><div className="platform-stat-value">{percent(platform.roi)}</div></div>
            </article>)}
          </div> : <div className="panel"><EmptyState reset={resetFilters} /></div>}
          {platforms.length > 1 && <div className="panel" style={{ marginTop: 15 }}><div className="panel-head"><div><h2 className="panel-title">Spend mix</h2><p className="panel-description">Share of investment by channel</p></div></div><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={platforms} layout="vertical" margin={{ left: 12, right: 25, top: 4, bottom: 4 }}><CartesianGrid strokeDasharray="3 5" horizontal={false} /><XAxis type="number" domain={[0, 'auto']} tickFormatter={(v) => `$${v}`} /><YAxis type="category" dataKey="name" width={110} /><Tooltip content={<MetricTooltip mode="dual" />} /><Bar dataKey="spend" name="Spend" fill="#bf6541" radius={[0, 4, 4, 0]} /></ComposedChart></ResponsiveContainer></div></div>}
        </div>}
        {view === 'campaigns' && <div data-testid="view-campaigns">
          <div className="metric-grid"><MetricCard label="Campaigns" value={number(stats.campaigns)} caption="Unique campaigns in selection" icon={FileSpreadsheet} /><MetricCard label="Spend" value={money(stats.spend)} caption="Aggregate campaign spend · USD" icon={Wallet} /><MetricCard label="Conversions" value={number(stats.conversions)} caption="Aggregate outcomes · count" icon={Target} /><MetricCard label="ROI" value={percent(stats.roi)} caption="Revenue less spend ÷ spend" icon={TrendingUp} /></div>
          <div className="panel"><div className="data-toolbar"><div><div className="panel-title">Campaign register</div><div className="panel-description">{groupedCampaigns.length} campaigns · rolled up across selected dates</div></div><div className="search-box"><Search /><input className="search-input" type="search" placeholder="Search campaign, channel..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search campaigns" data-testid="input-search-campaigns" /></div></div>
            {groupedCampaigns.length ? renderCampaignTable() : filteredRows.length ? <div className="empty-state"><div className="empty-mark"><Search size={19} /></div><h3>No campaign matches.</h3><p>Try another name, channel, audience, or goal.</p><button className="button" onClick={() => setSearch('')}>Clear search</button></div> : <EmptyState reset={resetFilters} />}
            <div className="table-footer"><span>Sorted by {sortKey}, {sortDirection === 'desc' ? 'descending' : 'ascending'}</span><span>{groupedCampaigns.length} rows</span></div>
          </div>
        </div>}
        {view === 'timeseries' && <div data-testid="view-timeseries">
          <div className="metric-grid"><MetricCard label="Spend" value={money(stats.spend)} caption="Selected period total" icon={Wallet} /><MetricCard label="Clicks" value={number(stats.clicks)} caption="Selected period total" icon={MousePointer2} /><MetricCard label="Conversions" value={number(stats.conversions)} caption="Selected period total" icon={Target} /><MetricCard label="ROI" value={percent(stats.roi)} caption="Selected period return" icon={TrendingUp} /></div>
          <div className="panel"><div className="panel-head"><div><h2 className="panel-title">{metricTitle[metric]} by time</h2><p className="panel-description">Grouped totals; dates on the axis are spaced by actual elapsed time</p></div><div className="chart-controls"><label htmlFor="time-interval" className="sr-only">Time interval</label><select id="time-interval" value={interval} onChange={(e) => setInterval(e.target.value as typeof interval)} data-testid="select-time-interval"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select><label htmlFor="time-metric" className="sr-only">Metric</label><select id="time-metric" value={metric} onChange={(e) => setMetric(e.target.value as MetricChoice)} data-testid="select-time-metric">{(['spend', 'clicks', 'conversions', 'revenue', 'roi', 'conversionRate'] as MetricChoice[]).map((key) => <option key={key} value={key}>{metricTitle[key]}</option>)}</select></div></div>
            {filteredRows.length ? <><div className="series-key"><span><i className="key-dot" style={{ background: '#bf6541' }} />{metricTitle[metric]} · {metric === 'spend' || metric === 'revenue' ? 'USD' : metric === 'roi' || metric === 'conversionRate' ? '%' : 'count'}</span></div><div className="chart-wrap" style={{ height: 360 }}><ResponsiveContainer width="100%" height="100%"><AreaChart data={metricSeries} margin={{ top: 6, right: 20, left: 8, bottom: 4 }}><defs><linearGradient id="scopeTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#bf6541" stopOpacity={0.2} /><stop offset="95%" stopColor="#bf6541" stopOpacity={0.01} /></linearGradient></defs><CartesianGrid strokeDasharray="3 5" vertical={false} /><XAxis dataKey="timestamp" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(v))} minTickGap={25} /><YAxis domain={[0, 'auto']} tickFormatter={(v) => metric === 'spend' || metric === 'revenue' ? `$${v}` : metric === 'roi' || metric === 'conversionRate' ? `${v}%` : number(v)} axisLine={false} tickLine={false} label={{ value: metric === 'spend' || metric === 'revenue' ? 'USD' : metric === 'roi' || metric === 'conversionRate' ? 'Percent' : 'Count', angle: -90, position: 'insideLeft', fill: '#8b8f8b', fontSize: 10 }} /><Tooltip content={<MetricTooltip mode={metric} />} /><Area type="monotone" dataKey="value" name={metricTitle[metric]} stroke="#bf6541" fill="url(#scopeTrend)" strokeWidth={2.5} activeDot={{ r: 4 }} /></AreaChart></ResponsiveContainer></div></> : <EmptyState reset={resetFilters} />}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#858985', fontSize: 10, margin: '11px 4px' }}><span>Period: {filters.start ? shortDate(filters.start) : '—'} – {filters.end ? shortDate(filters.end) : '—'}</span><span>{trend.length} {interval} intervals · no comparison period implied</span></div>
        </div>}
        <footer style={{ marginTop: 31, display: 'flex', justifyContent: 'space-between', color: '#8d918d', fontSize: 10, borderTop: '1px solid #e5dfd4', paddingTop: 14 }}><span>AdScope analyzes locally. Imported records live only for this browser session.</span><span>{shortDate(bounds.start || '2024-01-01')} — {shortDate(bounds.end || '2024-01-01')}</span></footer>
      </div>
    </main>
  </div>;
}

export default App;
