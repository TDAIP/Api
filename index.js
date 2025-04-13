const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const axios = require('axios');
const tmp = require('tmp');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const PORT = process.env.PORT || 3000;

// Danh sách từ tục tĩu/khiêu dâm
const toxicWords = [
  "sex", "nude", "fuck", "bitch", "nipples", "boobs", "porn", "dick", "pussy", "ass", "xxx", "slut", "horny", "naked"
];

/**
 * GET /thumbnail?url={video_url}
 * Trích thumbnail từ video. API sẽ tải file video về tạm và dùng ffmpeg để trích ảnh.
 */
app.get('/thumbnail', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'Missing video URL' });

  try {
    const tmpVideo = tmp.fileSync({ postfix: '.mp4' });
    const tmpDir = tmp.dirSync();

    // Tải video từ URL với stream
    const videoStream = await axios({
      method: 'get',
      url: videoUrl,
      responseType: 'stream'
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

          // Dọn dẹp file tạm
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
          filename: 'thumb.jpg'
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
 * GET /toxic/{text}
 * Kiểm tra xem có từ nào trong chuỗi text nằm trong danh sách từ tục không.
 * Nếu có, trả về status true và danh sách từ được phát hiện (với key ngẫu nhiên).
 */
app.get('/toxic/:text', (req, res) => {
  const { text } = req.params;
  if (!text) return res.status(400).json({ error: 'Missing text' });

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
 * GET /vfile?url={url}
 * Kiểm tra xem file từ URL có phải là video không.
 * API tải khoảng 1MB đầu file và dùng ffprobe (một phần của fluent-ffmpeg)
 * để xác định định dạng.
 */
app.get('/vfile', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing URL' });

  try {
    const tmpFile = tmp.fileSync();
    // Tải 1MB đầu tiên của file
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      headers: { Range: 'bytes=0-1048576' } // 1MB
    });

    const writer = fs.createWriteStream(tmpFile.name);
    response.data.pipe(writer);

    writer.on('finish', () => {
      ffmpeg.ffprobe(tmpFile.name, (err, metadata) => {
        if (err) {
          fs.unlinkSync(tmpFile.name);
          return res.json({ isVideo: false });
        }

        const isVideo = metadata.streams.some(stream => stream.codec_type === 'video');
        res.json({ isVideo });
        fs.unlinkSync(tmpFile.name);
      });
    });

    writer.on('error', (err) => {
      res.status(500).json({ isVideo: false, error: 'Stream error: ' + err.message });
    });

  } catch (err) {
    res.status(500).json({ isVideo: false, error: 'Failed to download file: ' + err.message });
  }
});

// Chạy server
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
