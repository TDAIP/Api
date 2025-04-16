const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createCanvas } = require('canvas');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Store active boards information
const boards = {
  // boardId: { isPublic: true/false, createdAt: timestamp, strokes: [], admin: userId }
};

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Board page
app.get('/board/:id', (req, res) => {
  const boardId = req.params.id;
  
  // If board doesn't exist, redirect to main page
  if (!boards[boardId]) {
    return res.redirect('/');
  }

  // Đọc file board.html
  const fs = require('fs');
  const boardHtmlPath = path.join(__dirname, 'public', 'board.html');
  let boardHtml = fs.readFileSync(boardHtmlPath, 'utf8');
  
  // Tạo URL snapshot cho meta tags
  const protocol = req.protocol;
  const host = req.get('host');
  const snapshotUrl = `${protocol}://${host}/snapshot?diagram=${boardId}&thumbnail=true`;
  
  // Thay thế các placeholder trong HTML
  boardHtml = boardHtml.replace(/{{SNAPSHOT_URL}}/g, snapshotUrl);
  
  // Gửi nội dung HTML đã được thay thế
  res.send(boardHtml);
});

// Create a new board
app.post('/api/boards', express.json(), (req, res) => {
  const { isPublic, userId, expiresIn } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }
  
  // Create a numeric UUID (only numbers)
  const boardId = uuidv4().replace(/[^0-9]/g, '').substring(0, 16);
  
  // Calculate expiration date based on expiresIn parameter
  const expirationDate = calculateExpirationDate(expiresIn);
  
  // Store the original expiresIn setting so we can recover it if needed
  boards[boardId] = {
    isPublic: isPublic === true,
    createdAt: Date.now(),
    expirationDate: expirationDate,
    expiresIn: expiresIn, // Lưu giá trị ban đầu của expiresIn
    strokes: [],
    admin: userId,
    users: {},
    blockedUsers: {}
  };
  
  res.json({ boardId });
});

// Get public boards for lobby
app.get('/api/boards/public', (req, res) => {
  const publicBoards = Object.entries(boards)
    .filter(([_, board]) => board.isPublic)
    .map(([id, board]) => ({
      id,
      createdAt: board.createdAt,
      expirationDate: board.expirationDate,
      userCount: Object.keys(board.users || {}).length
    }));
  
  res.json(publicBoards);
});

// Generate snapshot image of a board for social media previews
app.get('/snapshot', (req, res) => {
  const { diagram, thumbnail } = req.query;
  
  // Check if board exists
  if (!diagram || !boards[diagram]) {
    return res.status(404).send('Board not found');
  }
  
  // Cài đặt kích thước cố định cho hình ảnh
  const fixedWidth = 600;
  const fixedHeight = 400;
  
  // Generate snapshot image
  const boardData = boards[diagram];
  const strokes = boardData.strokes;
  
  // If no strokes, return a default image
  if (!strokes || strokes.length === 0) {
    const defaultCanvas = createCanvas(fixedWidth, fixedHeight);
    const ctx = defaultCanvas.getContext('2d');
    
    // Draw a simple default image
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(0, 0, fixedWidth, fixedHeight);
    ctx.font = '24px Arial';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.fillText('Empty Whiteboard', fixedWidth / 2, fixedHeight / 2);
    
    res.setHeader('Content-Type', 'image/png');
    res.send(defaultCanvas.toBuffer());
    return;
  }
  
  // Calculate bounds of all strokes to determine canvas scaling
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  strokes.forEach(stroke => {
    if (stroke.points && stroke.points.length > 0) {
      stroke.points.forEach(point => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
    }
  });
  
  // Add padding to ensure strokes don't touch the edge
  const padding = 40;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = maxX + padding;
  maxY = maxY + padding;
  
  // Calculate the content width and height
  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;
  
  // Create canvas with fixed dimensions
  const canvas = createCanvas(fixedWidth, fixedHeight);
  const ctx = canvas.getContext('2d');
  
  // Fill background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, fixedWidth, fixedHeight);
  
  // Calculate scaling to fit all content within the fixed canvas size
  // Maintain aspect ratio while ensuring all content is visible
  let scale = 1;
  if (contentWidth > 0 && contentHeight > 0) {
    const scaleX = (fixedWidth - 20) / contentWidth; // -20 for inner margin
    const scaleY = (fixedHeight - 20) / contentHeight;
    scale = Math.min(scaleX, scaleY);
  }
  
  // Calculate centering offsets
  const offsetX = (fixedWidth - contentWidth * scale) / 2;
  const offsetY = (fixedHeight - contentHeight * scale) / 2;
  
  // Apply transformations to center and scale the content
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-minX, -minY);
  
  // Draw all strokes
  strokes.forEach(stroke => {
    if (!stroke.points || stroke.points.length < 2) return;
    
    const points = stroke.points;
    const color = stroke.color || '#000';
    const width = stroke.width || 2;
    
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
  
  // Generate and send image
  res.setHeader('Content-Type', 'image/png');
  res.send(canvas.toBuffer());
});

// Socket.IO events
io.on('connection', (socket) => {
  let currentBoardId = null;
  let userId = null;

  // Join a board
  socket.on('join-board', (data) => {
    const { boardId, user, clientInfo } = data;
    userId = user.id;
    
    if (!boards[boardId]) {
      socket.emit('error', { message: 'Board not found' });
      return;
    }
    
    // Check if the user is blocked by ID
    if (boards[boardId].blockedUsers && boards[boardId].blockedUsers[userId]) {
      socket.emit('blocked', {
        reason: boards[boardId].blockedUsers[userId].reason
      });
      return;
    }
    
    // Check if the user is blocked by fingerprint (IP + user agent hash)
    if (clientInfo && clientInfo.fingerprint) {
      const isBlockedByFingerprint = Object.values(boards[boardId].blockedUsers || {}).some(
        blockedUser => blockedUser.fingerprint === clientInfo.fingerprint
      );
      
      if (isBlockedByFingerprint) {
        socket.emit('blocked', {
          reason: 'You are blocked from this board.'
        });
        return;
      }
    }
    
    currentBoardId = boardId;
    socket.join(boardId);
    
    // Store boardId and userId in the socket object for blocking purposes
    socket.boardId = boardId;
    socket.userId = userId;
    
    // Add user to the board's users
    if (!boards[boardId].users) {
      boards[boardId].users = {};
    }
    
    boards[boardId].users[userId] = {
      id: userId,
      joinedAt: Date.now(),
      lastActive: Date.now(),
      fingerprint: clientInfo ? clientInfo.fingerprint : null,
      clientInfo: clientInfo || null
    };
    
    // Send the current board state to the user
    socket.emit('board-state', {
      strokes: boards[boardId].strokes,
      users: boards[boardId].users,
      blockedUsers: boards[boardId].blockedUsers,
      isAdmin: userId === boards[boardId].admin,
      expirationDate: boards[boardId].expirationDate,
      expiresIn: boards[boardId].expiresIn, // Gửi cả thông tin expiresIn
      createdAt: boards[boardId].createdAt
    });
    
    // Notify others about the new user
    socket.to(boardId).emit('user-joined', {
      user: boards[boardId].users[userId]
    });
  });

  // Handle drawing strokes
  socket.on('draw-stroke', (stroke) => {
    if (!currentBoardId || !boards[currentBoardId]) return;
    
    // Check if user is blocked
    if (boards[currentBoardId].blockedUsers[userId]) {
      socket.emit('blocked', {
        reason: boards[currentBoardId].blockedUsers[userId].reason
      });
      return;
    }
    
    // Generate a unique ID for each stroke if not provided
    const strokeId = stroke.id || uuidv4();
    
    // Add stroke to the board
    boards[currentBoardId].strokes.push({
      ...stroke,
      id: strokeId,
      userId
    });
    
    // Broadcast stroke to other users
    socket.to(currentBoardId).emit('stroke-received', {
      ...stroke,
      id: strokeId,
      userId
    });
    
    // Update user's last active time
    if (boards[currentBoardId].users[userId]) {
      boards[currentBoardId].users[userId].lastActive = Date.now();
    }
  });

  // Admin actions: block user
  socket.on('block-user', (data) => {
    const { targetUserId, reason } = data;
    
    if (!currentBoardId || !boards[currentBoardId]) return;
    
    // Check if requester is admin
    if (userId !== boards[currentBoardId].admin) {
      socket.emit('error', { message: 'Permission denied' });
      return;
    }
    
    // Get target user's fingerprint if available
    let fingerprint = null;
    let clientInfo = null;
    
    if (boards[currentBoardId].users && boards[currentBoardId].users[targetUserId]) {
      fingerprint = boards[currentBoardId].users[targetUserId].fingerprint;
      clientInfo = boards[currentBoardId].users[targetUserId].clientInfo;
    }
    
    // Block user with fingerprint for cross-browser blocking
    boards[currentBoardId].blockedUsers[targetUserId] = {
      blockedAt: Date.now(),
      reason: reason || 'No reason provided',
      fingerprint: fingerprint,
      clientInfo: clientInfo
    };
    
    // Notify the blocked user through all clients in the room
    // This is a Socket.IO v4 compatible approach
    io.to(currentBoardId).emit('check-block-status', {
      userId: targetUserId,
      reason: boards[currentBoardId].blockedUsers[targetUserId].reason
    });
    
    // Notify all users in the room
    io.to(currentBoardId).emit('user-blocked', {
      userId: targetUserId,
      reason: boards[currentBoardId].blockedUsers[targetUserId].reason
    });
  });

  // Admin actions: unblock user
  socket.on('unblock-user', (data) => {
    const { targetUserId } = data;
    
    if (!currentBoardId || !boards[currentBoardId]) return;
    
    // Check if requester is admin
    if (userId !== boards[currentBoardId].admin) {
      socket.emit('error', { message: 'Permission denied' });
      return;
    }
    
    // Unblock user
    delete boards[currentBoardId].blockedUsers[targetUserId];
    
    // Notify all users in the room
    io.to(currentBoardId).emit('user-unblocked', {
      userId: targetUserId
    });
  });

  // Admin actions: clear strokes
  socket.on('clear-board', () => {
    if (!currentBoardId || !boards[currentBoardId]) return;
    
    // Check if requester is admin
    if (userId !== boards[currentBoardId].admin) {
      socket.emit('error', { message: 'Permission denied' });
      return;
    }
    
    // Clear strokes
    boards[currentBoardId].strokes = [];
    
    // Notify all users in the room
    io.to(currentBoardId).emit('board-cleared');
  });
  
  // Handle erasing strokes
  socket.on('erase-strokes', (data) => {
    if (!currentBoardId || !boards[currentBoardId]) return;
    
    // Check if user is blocked
    if (boards[currentBoardId].blockedUsers[userId]) {
      socket.emit('blocked', {
        reason: boards[currentBoardId].blockedUsers[userId].reason
      });
      return;
    }
    
    // Get indices of strokes to remove
    const { indices } = data;
    
    if (!indices || !Array.isArray(indices) || indices.length === 0) return;
    
    // Save a copy of the erased strokes for broadcasting their IDs
    const erasedStrokes = indices.map(idx => {
      if (idx >= 0 && idx < boards[currentBoardId].strokes.length) {
        return boards[currentBoardId].strokes[idx];
      }
      return null;
    }).filter(stroke => stroke !== null);
    
    // Extract IDs of erased strokes
    const erasedIds = erasedStrokes.map(stroke => stroke.id);
    
    // Create a new array without the erased strokes
    boards[currentBoardId].strokes = boards[currentBoardId].strokes.filter((stroke, idx) => !indices.includes(idx));
    
    // Notify other users about the erased strokes using IDs instead of indices
    socket.to(currentBoardId).emit('strokes-erased-by-id', { strokeIds: erasedIds });
    
    // Update user's last active time
    if (boards[currentBoardId].users[userId]) {
      boards[currentBoardId].users[userId].lastActive = Date.now();
    }
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    if (currentBoardId && boards[currentBoardId] && userId) {
      // Remove user from the board
      if (boards[currentBoardId].users && boards[currentBoardId].users[userId]) {
        delete boards[currentBoardId].users[userId];
        
        // Notify others about the user leaving
        socket.to(currentBoardId).emit('user-left', { userId });
        
        // If no users left and it's not a public board, remove the board
        const userCount = Object.keys(boards[currentBoardId].users).length;
        if (userCount === 0 && !boards[currentBoardId].isPublic) {
          delete boards[currentBoardId];
        }
      }
    }
  });
});

// Cleanup expired boards periodically
setInterval(() => {
  const now = Date.now();
  const dayInMs = 24 * 60 * 60 * 1000;
  
  Object.entries(boards).forEach(([id, board]) => {
    // Check for expiration based on expirationDate if it exists
    if (board.expirationDate && now > board.expirationDate) {
      // Board has expired based on its expirationDate
      delete boards[id];
      console.log(`Board ${id} deleted due to expiration date`);
      return;
    }
    
    // Fallback cleanup for boards without expiration that are inactive
    if (!board.expirationDate && (now - board.createdAt > dayInMs)) {
      // Check if any users are still active
      const hasActiveUsers = board.users && Object.keys(board.users).length > 0;
      
      if (!hasActiveUsers) {
        delete boards[id];
        console.log(`Board ${id} deleted due to inactivity`);
      }
    }
  });
}, 60 * 60 * 1000); // Check every hour

// Tiện ích để tính thời gian hết hạn từ giá trị expiresIn
function calculateExpirationDate(expiresIn) {
  if (!expiresIn || expiresIn === 'never') {
    return null;
  }
  
  const now = Date.now();
  
  switch(expiresIn) {
    case '14days':
      return now + (14 * 24 * 60 * 60 * 1000);
    case '30days':
      return now + (30 * 24 * 60 * 60 * 1000);
    case '3months':
      return now + (90 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});