const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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
  
  res.sendFile(path.join(__dirname, 'public', 'board.html'));
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