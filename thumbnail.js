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

app.get('/thumbnail', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'Missing video URL' });

  try {
    const tmpVideo = tmp.fileSync({ postfix: '.mp4' });
    const tmpDir = tmp.dirSync();

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
  } catch (err) {
    res.status(500).json({ error: 'Failed to process video: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
