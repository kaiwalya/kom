import { google } from 'googleapis';
import { parseArgs } from 'node:util';

const { GOOGLE_SERVICE_ACCOUNT_FILE, SITE_URL } = process.env;
if (!GOOGLE_SERVICE_ACCOUNT_FILE) throw new Error('GOOGLE_SERVICE_ACCOUNT_FILE is not set');
if (!SITE_URL) throw new Error('SITE_URL is not set');

const gscSiteUrl = `sc-domain:${new URL(SITE_URL).hostname}`;

const { values: args } = parseArgs({
  options: {
    'start-date': { type: 'string' },
    'end-date': { type: 'string' },
    report: { type: 'string', default: 'all' },
    limit: { type: 'string', default: '100' },
  },
});

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const startDate = args['start-date'] ?? daysAgo(28);
const endDate = args['end-date'] ?? yesterday();
const limit = parseInt(args.limit, 10);

const DIMENSIONS = {
  queries: ['query'],
  pages: ['page'],
  'query-page': ['query', 'page'],
  device: ['device'],
  country: ['country'],
};

const auth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_SERVICE_ACCOUNT_FILE,
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});

const searchconsole = google.searchconsole({ version: 'v1', auth });

async function fetchReport(dimensions) {
  const res = await searchconsole.searchanalytics.query({
    siteUrl: gscSiteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions,
      rowLimit: limit,
    },
  });
  return res.data.rows ?? [];
}

async function fetchSitemapUrls(sitemapUrl) {
  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(`Failed to fetch sitemap ${sitemapUrl}: ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (xml.includes('<sitemapindex')) {
    const nested = await Promise.all(locs.map(fetchSitemapUrls));
    return nested.flat();
  }
  return locs;
}

async function inspectUrl(url) {
  const res = await searchconsole.urlInspection.index.inspect({
    requestBody: { inspectionUrl: url, siteUrl: gscSiteUrl },
  });
  return { url, result: res.data.inspectionResult ?? null };
}

async function fetchDiagnostics() {
  const sitemapsRes = await searchconsole.sitemaps.list({ siteUrl: gscSiteUrl });
  const sitemaps = sitemapsRes.data.sitemap ?? [];

  const allUrls = (await Promise.all(sitemaps.map((s) => fetchSitemapUrls(s.path)))).flat();
  const uniqueUrls = [...new Set(allUrls)];
  const urlInspections = [];
  for (const url of uniqueUrls) {
    urlInspections.push(await inspectUrl(url));
  }

  return { sitemaps, urlInspections };
}

async function main() {
  const reportName = args.report;
  const output = { siteUrl: gscSiteUrl };

  if (reportName === 'diagnostics') {
    output.diagnostics = await fetchDiagnostics();
  } else if (reportName === 'all') {
    output.startDate = startDate;
    output.endDate = endDate;
    output.diagnostics = await fetchDiagnostics();
    output.reports = {};
    for (const [name, dimensions] of Object.entries(DIMENSIONS)) {
      output.reports[name] = await fetchReport(dimensions);
    }
  } else {
    if (!DIMENSIONS[reportName]) {
      process.stderr.write(`Unknown report: ${reportName}\n`);
      process.exit(1);
    }
    output.startDate = startDate;
    output.endDate = endDate;
    output.reports = { [reportName]: await fetchReport(DIMENSIONS[reportName]) };
  }

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(err.message + '\n');
  process.exit(1);
});
