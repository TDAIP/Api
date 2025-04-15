// Script tạo bảng vẽ mới để kiểm tra
const { v4: uuidv4 } = require('uuid');

// Tạo ID bảng vẽ ngẫu nhiên
const boardId = uuidv4();
console.log('Board ID mới tạo:', boardId);
console.log(`URL bảng vẽ mới: http://localhost:3000/board/${boardId}`);
console.log('Hãy truy cập URL trên để kiểm tra các thay đổi về tùy chỉnh bút và chất lượng vẽ');