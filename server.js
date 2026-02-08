require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { firefox } = require('playwright');


const app = express();
app.use(cors());
app.use(express.json());


/* ==========================
   M3U8 CACHE (1 HOUR)
========================== */
const m3u8Cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;


function getCached(key) {
    const cached = m3u8Cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.m3u8Url;
    }
    if (cached) m3u8Cache.delete(key);
    return null;
}


function setCache(key, m3u8Url) {
    m3u8Cache.set(key, { m3u8Url, timestamp: Date.now() });
}


/* ==========================
   VIDFAST URL BUILDER
========================== */
function buildVidfastUrl({ type, id, season, episode, server = 'Vfast', autoPlay = true }) {
    const params = new URLSearchParams();
    if (autoPlay) params.set('autoPlay', 'true');
    if (server) params.set('server', server);

    if (type === 'movie') {
        return `https://vidfast.pro/movie/${id}?${params.toString()}`;
    }

    if (type === 'tv') {
        return `https://vidfast.pro/tv/${id}/${season}/${episode}?${params.toString()}`;
    }

    throw new Error('Invalid type');
}


/* ==========================
   PLAYWRIGHT EXTRACTOR
========================== */
async function extractM3U8(embedUrl) {
    console.log(`[extract] Loading: ${embedUrl}`);

    const browser = await firefox.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
        locale: 'en-US',
    });

    const page = await context.newPage();
    let m3u8Url = null;

    page.on('response', (response) => {
        const responseUrl = response.url();
        if (responseUrl.includes('.m3u8') && !responseUrl.includes('ads') && !m3u8Url) {
            m3u8Url = responseUrl;
            console.log(`[extract] Found m3u8: ${m3u8Url}`);
        }
    });

    try {
        await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Human-like mouse movement
        await page.mouse.move(200, 300);
        await page.waitForTimeout(800);
        await page.mouse.move(600, 400);

        // Wait for FETCHING overlay to disappear
        await page.waitForFunction(() => !document.body.innerText.includes('FETCHING'), {
            timeout: 120000,
        }).catch(() => {});

        await page.waitForTimeout(2000);

        // Click play button if exists
        const buttonLocator = page.locator('div.MuiBox-root').locator('button').nth(0);
        await buttonLocator.waitFor({ state: 'visible', timeout: 30000 });

        for (let attempt = 0; attempt < 3 && !m3u8Url; attempt++) {
            const pagesBefore = context.pages().length;
            await page.waitForTimeout(500);
            await buttonLocator.click();
            await page.waitForTimeout(2500);

            // Close popups
            const pagesAfter = context.pages();
            if (pagesAfter.length > pagesBefore) {
                for (let i = 1; i < pagesAfter.length; i++) {
                    try { await pagesAfter[i].close(); } catch {}
                }
            }

            await page.waitForTimeout(1500);
        }

        if (!m3u8Url) {
            await page.waitForTimeout(10000);
        }
    } catch (err) {
        console.error('[extract] Error:', err.message);
    } finally {
        await browser.close();
    }

    return m3u8Url;
}


/* ==========================
   API ENDPOINTS
========================== */


// Movie endpoint
app.get('/movie/:id', async (req, res) => {
    const { id } = req.params;
    const server = 'Vfast'; // default automatic fallback
    const embedUrl = buildVidfastUrl({ type: 'movie', id, server });

    const cached = getCached(embedUrl);
    if (cached) return res.json({ success: true, m3u8Url: cached, server });

    try {
        const m3u8Url = await extractM3U8(embedUrl);
        if (!m3u8Url) return res.status(404).json({ error: 'm3u8 not found' });
        setCache(embedUrl, m3u8Url);
        res.json({ success: true, m3u8Url, server });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// TV episode endpoint
app.get('/tv/:id/:season/:episode', async (req, res) => {
    const { id, season, episode } = req.params;
    const server = 'Vfast'; // default automatic fallback
    const embedUrl = buildVidfastUrl({ type: 'tv', id, season, episode, server });

    const cached = getCached(embedUrl);
    if (cached) return res.json({ success: true, m3u8Url: cached, server });

    try {
        const m3u8Url = await extractM3U8(embedUrl);
        if (!m3u8Url) return res.status(404).json({ error: 'm3u8 not found' });
        setCache(embedUrl, m3u8Url);
        res.json({ success: true, m3u8Url, server });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`VidFast M3U8 Extractor Server running on http://localhost:${PORT}`);
    console.log('Endpoints:');
    console.log('  GET /movie/:id - Get movie M3U8 URL');
    console.log('  GET /tv/:id/:season/:episode - Get TV episode M3U8 URL');
});