const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const axios = require('axios');
const tmp = require('tmp');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const PORT = process.env.PORT || 3000;

// Danh sách từ toxic (có thể mở rộng sau)
const toxicWords = [
  "sex", "nude", "fuck", "bitch", "nipples", "boobs", "porn", "dick", "pussy", "ass", "xxx", "slut", "horny", "naked"
];

/**
 * Endpoint /thumbnail?url={video_url}
 * Trích thumbnail từ video dưới dạng file MP4
 */
app.get('/thumbnail', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'Missing video URL' });

  try {
    const tmpVideo = tmp.fileSync({ postfix: '.mp4' });
    const tmpDir = tmp.dirSync();

    // Tải video về file tạm
    const videoStream = await axios({
      method: 'get',
      url: videoUrl,
      responseType: 'stream',
    });

    const writer = fs.createWriteStream(tmpVideo.name);
    videoStream.data.pipe(writer);

    writer.on('finish', () => {
      ffmpeg(tmpVideo.name)
        .on('end', () => {
          const thumbPath = path.join(tmpDir.name, 'thumb.jpg');
          const img = fs.readFileSync(thumbPath);
          res.setHeader('Content-Type', 'image/jpeg');
          res.send(img);

          // Xóa file tạm
          fs.unlinkSync(tmpVideo.name);
          fs.unlinkSync(thumbPath);
        })
        .on('error', (err) => {
          res.status(500).json({ error: 'FFmpeg error: ' + err.message });
        })
        .screenshots({
          count: 1,
          timemarks: ['00:00:01'],
          folder: tmpDir.name,
          filename: 'thumb.jpg',
        });
    });
    writer.on('error', (err) => {
      res.status(500).json({ error: 'Error writing video file: ' + err.message });
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process video: ' + err.message });
  }
});

/**
 * Endpoint /toxic/{text}
 * Kiểm tra và trả về các từ toxic nếu có trong text
 */
app.get('/toxic/:text', (req, res) => {
  const { text } = req.params;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  // Tách các từ bằng regex
  const words = text.toLowerCase().split(/[^a-zA-Z0-9]+/);
  const result = {};

  words.forEach(word => {
    if (toxicWords.includes(word)) {
      const id = Math.random().toString(36).substring(2, 18);
      result[id] = { Toxic: word.charAt(0).toUpperCase() + word.slice(1) };
    }
  });

  res.json({
    status: Object.keys(result).length > 0,
    data: result
  });
});

/**
 * Endpoint /dia/{url}
 * Chụp screenshot PNG của website được truyền qua URL.
 * Ví dụ: /dia/https%3A%2F%2Fexample.com
 */
app.get('/dia/:url', async (req, res) => {
  try {
    // URL được mã hóa trong route, cần decode lại
    let websiteUrl = decodeURIComponent(req.params.url);

    // Nếu chưa có http:// hoặc https:// thì thêm mặc định http://
    if (!/^https?:\/\//i.test(websiteUrl)) {
      websiteUrl = 'http://' + websiteUrl;
    }

    // Khởi chạy Puppeteer
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(websiteUrl, { waitUntil: 'networkidle2' });

    // Chụp ảnh với định dạng PNG
    const screenshotBuffer = await page.screenshot({ fullPage: true });

    await browser.close();

    res.setHeader('Content-Type', 'image/png');
    res.send(screenshotBuffer);
  } catch (err) {
    res.status(500).json({ error: 'Error taking screenshot: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
