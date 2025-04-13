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

// Danh sách từ "tục" – có thể cập nhật thêm nếu cần
const toxicWords = [
  "sex", "nude", "fuck", "bitch", "nipples", "boobs", "porn", "dick", "pussy", "ass", "xxx", "slut", "horny", "naked"
];

//
// 1. Route /thumbnail?url={video_url}
// Trích thumbnail từ video (ví dụ MP4)
//
app.get('/thumbnail', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'Missing video URL' });

  try {
    // Tạo file tạm cho video
    const tmpVideo = tmp.fileSync({ postfix: '.mp4' });
    // Tạo thư mục tạm để chứa thumbnail
    const tmpDir = tmp.dirSync();

    // Tải video từ URL và ghi vào file tạm
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

          // Dọn dẹp file tạm
          fs.unlinkSync(tmpVideo.name);
          fs.unlinkSync(thumbPath);
        })
        .on('error', (err) => {
          res.status(500).json({ error: 'FFmpeg error: ' + err.message });
        })
        .screenshots({
          count: 1,
          timemarks: ['00:00:01'], // Lấy ảnh tại giây thứ 1
          folder: tmpDir.name,
          filename: 'thumb.jpg'
        });
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process video: ' + err.message });
  }
});

//
// 2. Route /toxic/:text
// Kiểm tra văn bản có chứa từ ngữ tục tĩu/khiêu dâm không
//
app.get('/toxic/:text', (req, res) => {
  const { text } = req.params;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  // Tách các từ, chuyển về chữ thường để so sánh
  const words = text.toLowerCase().split(/[^a-zA-Z0-9]+/);
  const result = {};

  words.forEach(word => {
    if (toxicWords.includes(word)) {
      // Tạo ID ngẫu nhiên cho mỗi từ được tìm thấy
      const id = Math.random().toString(36).substring(2, 18);
      result[id] = { Toxic: word.charAt(0).toUpperCase() + word.slice(1) };
    }
  });

  res.json({
    status: Object.keys(result).length > 0,
    data: result
  });
});

//
// 3. Route /dia
// Giao diện để cấu hình số lượng bot và nút Start + Preview.
// Khi nhấn Start, sẽ mở các cửa sổ mới với URL: 
// https://r8.whiteboardfox.com/85955809-7162-9594 và cố gắng di chuyển ngẫu nhiên.
//
app.get('/dia', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Bot Controller Interface</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; }
      .container { max-width: 600px; margin: auto; }
      input[type="number"] { width: 60px; }
      button { margin: 5px; padding: 10px 20px; }
      #previewArea div { border: 1px solid #ccc; padding: 10px; margin: 5px 0; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Bot Controller Interface</h1>
      <p>Nhập số lượng bot muốn mở:</p>
      <label for="botCount">Số lượng bot: </label>
      <input type="number" id="botCount" value="3" min="1" />
      <br/>
      <button id="previewBtn">Preview</button>
      <button id="startBtn">Start</button>
      <div id="previewArea" style="margin-top:20px;"></div>
    </div>

    <script>
      // URL trắng của whiteboard
      const whiteboardUrl = "https://r8.whiteboardfox.com/85955809-7162-9594";
      const botWindows = [];

      document.getElementById('previewBtn').addEventListener('click', () => {
        const count = parseInt(document.getElementById('botCount').value, 10);
        const previewArea = document.getElementById('previewArea');
        previewArea.innerHTML = '';
        for(let i = 0; i < count; i++){
          const div = document.createElement('div');
          div.textContent = "Bot " + (i+1) + ": Sẽ mở cửa sổ với URL " + whiteboardUrl + " và thực hiện hành động ngẫu nhiên.";
          previewArea.appendChild(div);
        }
      });

      document.getElementById('startBtn').addEventListener('click', () => {
        const count = parseInt(document.getElementById('botCount').value, 10);
        for(let i = 0; i < count; i++){
          const botWin = window.open(whiteboardUrl, '_blank', 'width=800,height=600');
          if(botWin) {
            botWindows.push(botWin);
            // Cố gắng di chuyển cửa sổ theo hành động ngẫu nhiên (lưu ý: một số trình duyệt có thể chặn)
            setInterval(() => {
              const x = Math.floor(Math.random() * 200) - 100;
              const y = Math.floor(Math.random() * 200) - 100;
              try {
                botWin.moveBy(x, y);
              } catch (err) {
                console.log('Không thể di chuyển cửa sổ', err);
              }
            }, 3000);
            // Bạn có thể thêm các tác vụ khác như tự động "vẽ" bằng cách gửi event hoặc message nếu trang cho phép
          }
        }
      });
    </script>
  </body>
  </html>
  `;
  res.send(html);
});

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
