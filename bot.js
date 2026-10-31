const { chromium } = require('playwright');
const { exec, spawn } = require('child_process');

(async () => {
  const ZOOM_LINK = process.env.ZOOM_LINK;
  const YT_RTMP = process.env.YT_RTMP;
  const SWITCH_TO = process.env.SWITCH_TO;

  console.log("Starting Cloud OBS...");
  const browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--start-maximized']
  });
  const page = await browser.newPage();
  await page.goto(ZOOM_LINK, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(15000);

  console.log("Starting 4H RTMP Stream - This will NOT cut on switch");
  // FFmpeg එක එක පාරයි start වෙන්නේ. යටින් browser එක මාරු උනත් RTMP එක නවත්තන්නේ නෑ
  const ffmpeg = spawn('ffmpeg', [
    '-f','x11grab','-video_size','1280x720','-i',':99',
    '-f','pulse','-ac','2','-i','default',
    '-c:v','libx264','-preset','veryfast','-b:v','3000k',
    '-c:a','aac','-b:a','128k','-f','flv', YT_RTMP
  ]);
  ffmpeg.stderr.on('data', d => console.log(d.toString()));

  // 4 hours wait
  await page.waitForTimeout(4 * 60 * 60 * 1000);
  await browser.close();
})();
