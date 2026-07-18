/**
 * Record the Cloud-Surgeon demo video using Playwright.
 * Navigates to the preview URL, waits for one full loop (51s), saves WebM, converts to MP4.
 *
 * Usage: node scripts/record-video.mjs
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../assets');
const WEBM_PATH = path.join(OUTPUT_DIR, 'cloud-surgeon-demo.webm');
const MP4_PATH  = path.join(OUTPUT_DIR, 'cloud-surgeon-demo.mp4');

// Total duration of one full loop in ms (6+8+7+7+8+7+8 = 51s) + 2s buffer
const VIDEO_DURATION_MS = 53_000;

const PREVIEW_URL = 'http://localhost:8081/__mockup/preview/video/cloud-surgeon-demo';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

console.log('🎬 Starting headless Chromium...');
const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--allow-running-insecure-content',
  ],
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: {
    dir: OUTPUT_DIR,
    size: { width: 1280, height: 720 },
  },
});

const page = await context.newPage();

// Expose startRecording / stopRecording so the hook fires correctly
let recordingStarted = false;
await page.exposeFunction('__recordingStarted', () => { recordingStarted = true; });
await page.addInitScript(() => {
  window.startRecording = async () => { (window).__recordingStarted?.(); };
  window.stopRecording  = () => {};   // no-op; we use fixed duration
});

console.log(`📺 Opening: ${PREVIEW_URL}`);
await page.goto(PREVIEW_URL, { waitUntil: 'networkidle' });

// Wait for first scene to paint
await page.waitForTimeout(2000);

console.log(`⏳ Recording for ${VIDEO_DURATION_MS / 1000}s...`);
await page.waitForTimeout(VIDEO_DURATION_MS);

console.log('💾 Saving recording...');
const videoHandle = await page.video();
const savedPath = await videoHandle?.saveAs(WEBM_PATH);
await context.close();
await browser.close();

console.log(`✅ WebM saved: ${WEBM_PATH}`);

// Convert WebM → MP4 with ffmpeg
console.log('🔄 Converting to MP4...');
execSync(
  `ffmpeg -y -i "${WEBM_PATH}" -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart "${MP4_PATH}"`,
  { stdio: 'inherit' }
);

console.log(`\n✅ Done! Video saved to: ${MP4_PATH}`);
