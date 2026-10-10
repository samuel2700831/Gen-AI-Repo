export interface CampaignRow {
  date: string;
  campaign: string;
  channel: string;
  audience: string;
  goal: string;
  spend: number;
  clicks: number;
  conversions: number;
  revenue: number | null;
}

export interface Filters {
  start: string;
  end: string;
  channels: string[];
  audiences: string[];
  goals: string[];
}

export interface Metrics {
  spend: number;
  clicks: number;
  conversions: number;
  revenue: number | null;
  roi: number | null;
  cpc: number | null;
  cpa: number | null;
  conversionRate: number | null;
  campaigns: number;
}

export function aggregate(rows: CampaignRow[]): Metrics {
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const conversions = rows.reduce((s, r) => s + r.conversions, 0);
  const revenue = rows.length && rows.every(r => r.revenue !== null)
    ? rows.reduce((s, r) => s + r.revenue!, 0) : null;
  return {
    spend, clicks, conversions, revenue,
    roi: revenue !== null && spend > 0 ? (revenue - spend) / spend * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpa: conversions > 0 ? spend / conversions : null,
    conversionRate: clicks > 0 ? conversions / clicks * 100 : null,
    campaigns: new Set(rows.map(r => `${r.channel}\0${r.campaign}`)).size,
  };
}

export function filterRows(rows: CampaignRow[], filters: Filters): CampaignRow[] {
  return rows.filter(r =>
    (!filters.start || r.date >= filters.start) &&
    (!filters.end || r.date <= filters.end) &&
    (!filters.channels.length || filters.channels.includes(r.channel)) &&
    (!filters.audiences.length || filters.audiences.includes(r.audience)) &&
    (!filters.goals.length || filters.goals.includes(r.goal)),
  );
}

export function groupRows(rows: CampaignRow[], key: 'channel' | 'campaign') {
  const groups = new Map<string, CampaignRow[]>();
  for (const row of rows) {
    // A same-named campaign on separate platforms must not be merged.
    const id = key === 'campaign' ? `${row.channel}\0${row.campaign}` : row.channel;
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return [...groups.values()].map(group => ({
    name: group[0][key], channel: group[0].channel, ...aggregate(group),
  }));
}

export function timeSeries(rows: CampaignRow[], interval: 'daily' | 'weekly' | 'monthly') {
  const groups = new Map<string, CampaignRow[]>();
  for (const row of rows) {
    const date = new Date(`${row.date}T00:00:00Z`);
    if (interval === 'monthly') date.setUTCDate(1);
    if (interval === 'weekly') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const key = date.toISOString().slice(0, 10);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, group]) => ({
    date, timestamp: Date.parse(`${date}T00:00:00Z`), ...aggregate(group),
  }));
}

// Handles commas, multiline quoted fields, and escaped double quotes.
function readRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [], field = '', quoted = false, afterQuote = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else field += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      record.push(field.trim()); field = ''; afterQuote = false;
      if (c !== ',') {
        if (record.some(Boolean)) records.push(record);
        record = [];
        if (c === '\r' && input[i + 1] === '\n') i++;
      }
    } else if (c === '"' && !field.trim() && !afterQuote) {
      field = ''; quoted = true;
    } else {
      if ((afterQuote && c.trim()) || c === '"') throw new Error('Malformed CSV: unexpected quote or text after a quoted field.');
      field += c;
    }
  }
  if (quoted) throw new Error('Malformed CSV: an unclosed quoted field was found.');
  record.push(field.trim());
  if (record.some(Boolean)) records.push(record);
  return records;
}

const aliases: Record<string, string[]> = {
  date: ['date', 'day', 'report_date'],
  campaign: ['campaign', 'campaign_name'],
  channel: ['channel', 'platform'],
  audience: ['audience', 'target_audience', 'audience_segment'],
  goal: ['goal', 'campaign_goal', 'objective'],
  spend: ['spend', 'cost', 'ad_spend', 'amount_spent'],
  clicks: ['clicks', 'total_clicks'],
  conversions: ['conversions', 'total_conversions'],
  revenue: ['revenue', 'conversion_value', 'sales'],
};

export function parseCSV(text: string): CampaignRow[] {
  if (new Blob([text]).size > 5 * 1024 * 1024) throw new Error('CSV must be 5 MB or smaller.');
  const records = readRecords(text);
  if (records.length < 2) throw new Error('CSV needs a header and at least one data row.');
  if (records.length > 50001) throw new Error('CSV must contain no more than 50,000 data rows.');
  const headers = records[0].map(h => h.toLowerCase().trim().replace(/[\s-]+/g, '_'));
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate column names.');
  const columns: Record<string, number> = {};
  for (const [key, names] of Object.entries(aliases)) {
    columns[key] = headers.findIndex(h => names.includes(h));
  }
  const missing = Object.keys(aliases).filter(key => key !== 'revenue' && columns[key] === -1);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}. Revenue is optional.`);
  return records.slice(1).map((values, i) => {
    const line = i + 2;
    if (values.length !== headers.length) throw new Error(`Row ${line}: expected ${headers.length} columns, found ${values.length}.`);
    const get = (key: string) => values[columns[key]] ?? '';
    const required = (key: string) => {
      const value = get(key);
      if (!value) throw new Error(`Row ${line}: ${key} cannot be blank.`);
      return value;
    };
    const number = (key: string, optional = false): number | null => {
      const raw = get(key);
      if (optional && !raw) return null;
      const cleaned = raw.replace(/[$,\s]/g, '');
      if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`Row ${line}: ${key} must be a non-negative number.`);
      const n = Number(cleaned);
      if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) throw new Error(`Row ${line}: ${key} is too large.`);
      if ((key === 'clicks' || key === 'conversions') && !Number.isInteger(n)) throw new Error(`Row ${line}: ${key} must be a whole-number count.`);
      return n;
    };
    const date = required('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw new Error(`Row ${line}: date must be a valid YYYY-MM-DD date.`);
    }
    const rawChannel = required('channel').toLowerCase();
    const channelNames: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', pinterest: 'Pinterest', twitter: 'Twitter', x: 'Twitter' };
    const channel = channelNames[rawChannel];
    if (!channel) throw new Error(`Row ${line}: channel must be Facebook, Instagram, Pinterest, or Twitter (X).`);
    return {
      date, channel, campaign: required('campaign'), audience: required('audience'), goal: required('goal'),
      spend: number('spend')!, clicks: number('clicks')!, conversions: number('conversions')!,
      revenue: number('revenue', true),
    };
  });
}

export function toCSV(rows: CampaignRow[]): string {
  const keys: (keyof CampaignRow)[] = ['date', 'campaign', 'channel', 'audience', 'goal', 'spend', 'clicks', 'conversions', 'revenue'];
  const escape = (value: string | number | null) => {
    let text = value === null ? '' : String(value);
    // Neutralize spreadsheet formulas when exporting user-provided text.
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => escape(r[k])).join(','))].join('\r\n');
}

export function sampleRows(): CampaignRow[] {
  const rows: CampaignRow[] = [];
  const platforms = ['Facebook', 'Instagram', 'Pinterest', 'Twitter'];
  const names = ['Summer collection', 'Always-on retargeting', 'New customer discovery'];
  for (let day = 0; day < 60; day++) {
    for (let platform = 0; platform < platforms.length; platform++) {
      for (let campaign = 0; campaign < names.length; campaign++) {
        const date = new Date(Date.UTC(2026, 7, 1 + day)).toISOString().slice(0, 10);
        const wave = 1 + 0.18 * Math.sin(day / 5 + platform) + day * 0.005;
        const spend = Math.round((110 + platform * 27 + campaign * 40) * wave * 100) / 100;
        const clicks = Math.round(spend * (3.7 - platform * .45) + ((day * 19 + campaign * 11) % 47));
        const conversions = Math.round(clicks * [.041, .048, .033, .022][platform] * (campaign === 1 ? 1.4 : 1));
        rows.push({
          date, campaign: names[campaign], channel: platforms[platform],
          audience: ['Adults 25–44', 'Returning customers', 'Adults 18–34'][campaign],
          goal: ['Sales', 'Sales', 'Lead generation'][campaign],
          spend, clicks, conversions, revenue: conversions * (32 + campaign * 7),
        });
      }
    }
  }
  return rows;
}
