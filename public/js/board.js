// Get the board ID from the URL
const boardId = window.location.pathname.split('/').pop();
let socket;

// User information
let userId = localStorage.getItem('solarboard_user_id');
if (!userId) {
  userId = Math.random().toString(36).substring(2, 15);
  localStorage.setItem('solarboard_user_id', userId);
}

// Canvas setup
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const canvasContainer = document.getElementById('canvas-container');

// Whiteboard state
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let penColor = '#000000';
let penSize = 2;
let currentTool = 'pen';
let scale = 1;
let translateX = 0;
let translateY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let isAdmin = false;

// Drawing and notification state
let strokes = [];
let redoStack = [];
let currentStroke = null;
let isUpdating = false;
let updateTimeout = null;

// Board information
let boardInfo = {
  isPublic: false,
  users: {}
};

// Initialize the canvas
function initCanvas() {
  // Set canvas size
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    draw();
  }

  // Call initially and on window resize
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

// Drawing functions
function createDrawingEffect(x, y, type) {
  // Create effect element
  const effect = document.createElement('div');
  effect.className = `canvas-effect ${type}-effect`;
  document.body.appendChild(effect);
  
  // Position the effect
  effect.style.left = `${x}px`;
  effect.style.top = `${y}px`;
  
  // Remove after animation completes
  setTimeout(() => {
    effect.remove();
  }, 1000);
}

function startDrawing(e) {
  // Skip drawing if we're panning or using pan tool
  if (isPanning || currentTool === 'pan') return;
  
  const point = getCoordinates(e);
  isDrawing = true;
  lastX = point.x;
  lastY = point.y;
  
  // Get screen coordinates for visual effect
  let clientX, clientY;
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }
  
  // Create visual effect based on current tool
  createDrawingEffect(clientX, clientY, currentTool);
  
  if (currentTool === 'eraser') {
    eraseAt(point);
  } else if (currentTool === 'pen') {
    // Start new stroke with UUID
    currentStroke = {
      id: self.crypto.randomUUID(), // Generate client-side UUID
      tool: currentTool,
      color: penColor,
      size: penSize,
      points: [{ x: point.x, y: point.y }],
      userId
    };
    
    socket.emit('draw-stroke', currentStroke);
    strokes.push(currentStroke);
    redoStack = []; // Clear redo stack on new stroke
  }
}

// Create particle effect as user draws
function createParticle(x, y, color) {
  // Only create particles sometimes (performance reasons)
  if (Math.random() > 0.3) return;
  
  const particle = document.createElement('div');
  particle.style.position = 'absolute';
  particle.style.width = '3px';
  particle.style.height = '3px';
  particle.style.backgroundColor = color;
  particle.style.borderRadius = '50%';
  particle.style.left = `${x}px`;
  particle.style.top = `${y}px`;
  particle.style.pointerEvents = 'none';
  particle.style.opacity = '0.8';
  particle.style.zIndex = '5';
  particle.style.transition = 'all 0.5s ease';
  document.body.appendChild(particle);
  
  // Random direction and distance
  const angle = Math.random() * Math.PI * 2;
  const distance = 5 + Math.random() * 15;
  const destX = x + Math.cos(angle) * distance;
  const destY = y + Math.sin(angle) * distance;
  
  // Animate particle
  setTimeout(() => {
    particle.style.transform = `translate(${destX - x}px, ${destY - y}px)`;
    particle.style.opacity = '0';
  }, 10);
  
  // Remove particle after animation
  setTimeout(() => {
    particle.remove();
  }, 500);
}

function draw(e) {
  if (!isDrawing) return;
  
  const point = getCoordinates(e);
  
  // Get screen coordinates for visual effects
  let clientX, clientY;
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }
  
  if (currentTool === 'eraser') {
    eraseAt(point);
  } else {
    // Nếu điểm quá gần với điểm cuối cùng, bỏ qua để giảm số lượng điểm gửi đi
    // và tăng hiệu suất
    const points = currentStroke.points;
    const lastPoint = points[points.length - 1];
    const distanceToLastPoint = Math.hypot(lastPoint.x - point.x, lastPoint.y - point.y);
    
    // Chỉ thêm điểm mới nếu khoảng cách đủ lớn hoặc là điểm đầu tiên sau điểm bắt đầu
    if (distanceToLastPoint >= 2 / scale || points.length <= 1) {
      // Thêm điểm mới vào nét vẽ hiện tại 
      currentStroke.points.push({ x: point.x, y: point.y });
      
      // Vẽ đường cong Bézier mượt mà
      ctx.save();
      applyTransform();
      
      // Thiết lập thuộc tính vẽ
      ctx.strokeStyle = currentStroke.color;
      ctx.lineWidth = currentStroke.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      // Vẽ nét mới nhất
      const len = points.length;
      
      // Cải thiện hiệu suất bằng cách không xóa và vẽ lại toàn bộ nét
      // mà chỉ vẽ phần mới thêm vào (đường thẳng hoặc đường cong ngắn)
      if (len >= 3) {
        const startIdx = Math.max(0, len - 3);
        
        ctx.beginPath();
        ctx.moveTo(points[startIdx].x, points[startIdx].y);
        
        if (len - startIdx === 3) {
          // Vẽ đường cong quadratic cho 3 điểm
          ctx.quadraticCurveTo(
            points[startIdx + 1].x, points[startIdx + 1].y,
            points[startIdx + 2].x, points[startIdx + 2].y
          );
        } else {
          // Vẽ đoạn đường thẳng hoặc đường cong ngắn
          for (let i = startIdx + 1; i < len; i++) {
            ctx.lineTo(points[i].x, points[i].y);
          }
        }
        
        ctx.stroke();
      } else if (len === 2) {
        // Nếu chỉ có 2 điểm, vẽ đường thẳng
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
      }
      
      ctx.restore();
      
      // Thêm hiệu ứng hạt cho bút vẽ khi thực sự vẽ
      createParticle(clientX, clientY, currentStroke.color);
      
      // Cập nhật lên server - Cải thiện tần suất đồng bộ
      showUpdateNotification();
      
      // Thiết lập khoảng thời gian động cho việc đồng bộ dựa trên tốc độ vẽ và số lượng điểm
      const now = Date.now();
      const timeSinceLastEmit = now - (currentStroke.lastEmit || 0);
      const pointsSinceLastEmit = (currentStroke.lastEmitPointCount || 0);
      
      // Tăng số điểm đã thêm từ lần gửi cuối
      currentStroke.lastEmitPointCount = (currentStroke.lastEmitPointCount || 0) + 1;
      
      // Gửi dữ liệu trong các trường hợp sau:
      // 1. Đã vượt quá thời gian tối đa cho phép (20ms = 50 lần/giây)
      // 2. Đã tích lũy quá nhiều điểm (5 điểm)
      // 3. Điều kiện kết hợp thời gian và số điểm
      if (timeSinceLastEmit > 20 || 
          pointsSinceLastEmit >= 5 ||
          (timeSinceLastEmit > 10 && pointsSinceLastEmit >= 3)) {
        
        socket.emit('draw-stroke', currentStroke);
        currentStroke.lastEmit = now;
        currentStroke.lastEmitPointCount = 0;
      }
    }
  }
  
  lastX = point.x;
  lastY = point.y;
}

function stopDrawing() {
  isDrawing = false;
  currentStroke = null;
}

function eraseAt(point) {
  const eraseRadius = penSize * 5;
  let strokesToRemove = [];
  let strokesIds = [];
  
  // Find strokes that intersect with eraser
  strokes.forEach((stroke, idx) => {
    if (!stroke || !stroke.points || stroke.points.length < 2) return;
    
    for (let i = 1; i < stroke.points.length; i++) {
      const p1 = stroke.points[i - 1];
      const p2 = stroke.points[i];
      
      if (!p1 || !p2) continue;
      
      // Check if point is near line segment
      if (distToSegment(point, p1, p2) < eraseRadius) {
        strokesToRemove.push(idx);
        if (stroke.id) {
          strokesIds.push(stroke.id);
        }
        break;
      }
    }
  });
  
  // Không có đường vẽ nào bị xóa thì bỏ qua
  if (strokesToRemove.length === 0) return;
  
  // Hiển thị thông báo cập nhật
  showUpdateNotification();
  
  // Remove strokes (in reverse order to not affect indices)
  for (let i = strokesToRemove.length - 1; i >= 0; i--) {
    const idx = strokesToRemove[i];
    if (idx >= 0 && idx < strokes.length) {
      // Store the removed stroke in the redo stack for undo operation
      redoStack.push(strokes[idx]);
      // Remove the stroke from the array
      strokes.splice(idx, 1);
    }
  }
  
  // Redraw canvas
  redrawCanvas();
  
  // Thông báo cho server biết nét vẽ bị xóa theo ID và chỉ mục
  if (strokesIds.length > 0) {
    socket.emit('strokes-erased-by-id', { strokeIds: strokesIds });
  }
  
  socket.emit('erase-strokes', { indices: strokesToRemove });
}

// Utility functions
function getCoordinates(e) {
  let clientX, clientY;
  
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }
  
  // Apply inverse transform to get canvas coordinates
  const rect = canvas.getBoundingClientRect();
  const x = (clientX - rect.left - translateX) / scale;
  const y = (clientY - rect.top - translateY) / scale;
  
  return { x, y };
}

function applyTransform() {
  ctx.translate(translateX, translateY);
  ctx.scale(scale, scale);
}

function redrawCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  ctx.save();
  applyTransform();
  
  // Vẽ lại tất cả các nét vẽ
  strokes.forEach(stroke => {
    const points = stroke.points;
    if (!points || points.length < 2) return;
    
    // Thiết lập thuộc tính vẽ
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    const len = points.length;
    ctx.moveTo(points[0].x, points[0].y);
    
    // Áp dụng đường cong Bézier cho nét vẽ có nhiều hơn 2 điểm
    if (len > 2) {
      // Đối với 3 điểm, sử dụng đường cong quadratic đơn giản
      if (len === 3) {
        ctx.quadraticCurveTo(points[1].x, points[1].y, points[2].x, points[2].y);
      } else {
        // Sử dụng kỹ thuật Bézier mượt mà cho nhiều điểm
        for (let i = 1; i < len - 2; i++) {
          // Tính điểm trung bình giữa các điểm lân cận để làm điểm điều khiển
          const xc = (points[i].x + points[i+1].x) / 2;
          const yc = (points[i].y + points[i+1].y) / 2;
          
          // Vẽ đường cong từ điểm hiện tại đến điểm trung bình,
          // sử dụng điểm hiện tại làm điểm điều khiển
          ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
        }
        
        // Vẽ đoạn cuối cùng đến điểm cuối
        ctx.quadraticCurveTo(
          points[len-2].x, points[len-2].y,
          points[len-1].x, points[len-1].y
        );
      }
    } else {
      // Đối với 2 điểm, chỉ vẽ đường thẳng
      ctx.lineTo(points[1].x, points[1].y);
    }
    
    ctx.stroke();
  });
  
  ctx.restore();
}

// Math utility for eraser
function sqr(x) { return x * x; }
function dist2(v, w) { return sqr(v.x - w.x) + sqr(v.y - w.y); }
function distToSegmentSquared(p, v, w) {
  const l2 = dist2(v, w);
  if (l2 === 0) return dist2(p, v);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist2(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
}
function distToSegment(p, v, w) { return Math.sqrt(distToSegmentSquared(p, v, w)); }

// Pan and zoom functionality
function startPan(e) {
  // Middle mouse button, space + left mouse, or dedicated pan tool
  if (e.button === 1 || (e.button === 0 && (e.getModifierState('Space') || currentTool === 'pan'))) {
    isPanning = true;
    panStartX = e.clientX - translateX;
    panStartY = e.clientY - translateY;
    canvasContainer.style.cursor = 'grabbing';
    e.preventDefault();
    
    // Show pan indicator
    showPanIndicator(true);
  }
}

function pan(e) {
  if (!isPanning) return;
  
  translateX = e.clientX - panStartX;
  translateY = e.clientY - panStartY;
  redrawCanvas();
  e.preventDefault();
}

function endPan() {
  if (isPanning) {
    isPanning = false;
    canvasContainer.style.cursor = getCursorForTool(currentTool);
    
    // Hide pan indicator
    showPanIndicator(false);
  }
}

// Get appropriate cursor based on current tool
function getCursorForTool(tool) {
  switch(tool) {
    case 'eraser': return 'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2"><circle cx="12" cy="12" r="10" fill="rgba(255,255,255,0.2)" stroke-width="2"/></svg>\') 12 12, auto';
    case 'pen': return 'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2"><circle cx="12" cy="12" r="1" fill="black"/></svg>\') 1 22, crosshair';
    case 'pan': return 'grab';
    default: return 'crosshair';
  }
}

// Show/hide panning indicator
function showPanIndicator(show) {
  let indicator = document.getElementById('pan-indicator');
  
  // Create if it doesn't exist
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'pan-indicator';
    indicator.innerHTML = '<i class="fas fa-arrows-alt"></i> Di chuyển bản vẽ';
    document.body.appendChild(indicator);
  }
  
  // Show/hide
  if (show) {
    indicator.classList.add('active');
  } else {
    indicator.classList.remove('active');
  }
}

function handleZoom(e) {
  e.preventDefault();
  
  // Phát hiện nếu đang nhấn phím Shift để kích hoạt chế độ zoom + pan đồng thời
  const isShiftPressed = e.shiftKey; 
  
  // Calculate zoom factor - faster zooming for better experience
  const zoomIntensity = 0.15;
  const delta = e.deltaY > 0 ? -zoomIntensity : zoomIntensity;
  
  // Restrict zoom levels between 0.1 and 8 (wider range for infinite zoom)
  const newScale = Math.max(0.1, Math.min(8, scale * (1 + delta)));
  
  // Get mouse position
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  
  // Get coordinates before zoom
  const x1 = (mouseX - translateX) / scale;
  const y1 = (mouseY - translateY) / scale;
  
  // Calculate new translate values to zoom around cursor
  translateX = mouseX - x1 * newScale;
  translateY = mouseY - y1 * newScale;
  
  // Thêm hiệu ứng pan nhẹ theo hướng chuột khi đang nhấn Shift
  if (isShiftPressed) {
    // Tính toán lượng pan dựa theo vị trí chuột so với trung tâm canvas
    const canvasCenterX = canvas.width / 2;
    const canvasCenterY = canvas.height / 2;
    
    // Tính khoảng cách từ chuột đến trung tâm
    const distX = (mouseX - canvasCenterX) / canvas.width;
    const distY = (mouseY - canvasCenterY) / canvas.height;
    
    // Thêm pan theo hướng đó, lượng pan phụ thuộc vào khoảng cách
    translateX -= distX * 20;
    translateY -= distY * 20;
    
    // Hiển thị chỉ báo pan + zoom
    showZoomPanIndicator();
  } else {
    // Show zoom level indicator
    showZoomIndicator();
  }
  
  // Update scale and redraw
  scale = newScale;
  redrawCanvas();
}

// Hiển thị chỉ báo zoom + pan
function showZoomPanIndicator() {
  let indicator = document.getElementById('zoom-indicator');
  
  // Create if it doesn't exist
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'zoom-indicator';
    document.body.appendChild(indicator);
  }
  
  // Đảm bảo indicator luôn ở chính giữa phía dưới màn hình
  indicator.style.bottom = '25px';
  indicator.style.left = '50%';
  indicator.style.top = 'auto';
  indicator.style.right = 'auto';
  indicator.style.transform = 'translateX(-50%)';
  indicator.style.position = 'fixed';
  
  // Update content và thêm thông tin pan
  indicator.innerHTML = `<i class="fas fa-search-plus"></i> ${Math.round(scale * 100)}% <i class="fas fa-arrows-alt" style="margin-left: 8px;"></i>`;
  indicator.classList.add('active');
  
  // Clear existing timeout
  if (window.zoomTimeout) {
    clearTimeout(window.zoomTimeout);
  }
  
  // Hide after delay
  window.zoomTimeout = setTimeout(() => {
    indicator.classList.remove('active');
  }, 1500);
}

// Function to display zoom indicator
function showZoomIndicator() {
  let indicator = document.getElementById('zoom-indicator');
  
  // Create if it doesn't exist
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'zoom-indicator';
    document.body.appendChild(indicator);
  }
  
  // Đảm bảo indicator luôn ở chính giữa phía dưới màn hình
  indicator.style.bottom = '25px';
  indicator.style.left = '50%';
  indicator.style.top = 'auto';
  indicator.style.right = 'auto';
  indicator.style.transform = 'translateX(-50%)';
  indicator.style.position = 'fixed';
  
  // Update content với icon phóng to và %
  indicator.innerHTML = `<i class="fas fa-search-plus"></i> ${Math.round(scale * 100)}%`;
  indicator.classList.add('active');
  
  // Clear existing timeout
  if (window.zoomTimeout) {
    clearTimeout(window.zoomTimeout);
  }
  
  // Hide after delay
  window.zoomTimeout = setTimeout(() => {
    indicator.classList.remove('active');
  }, 1500);
}

// UI Event handlers
function setupUIEvents() {
  // Biến để theo dõi trạng thái của nút bút vẽ
  let isPenActive = false;
  
  // Tool selection
  document.getElementById('pen-button').addEventListener('click', () => {
    if (currentTool === 'pen') {
      // Nếu đã chọn bút vẽ, hiện/ẩn menu CustomPen
      const customPenModal = document.getElementById('custom-pen-menu');
      customPenModal.classList.toggle('active');
    } else {
      // Nếu chưa chọn, chọn bút vẽ
      setActiveTool('pen');
      isPenActive = true;
    }
  });
  
  document.getElementById('eraser-button').addEventListener('click', () => {
    setActiveTool('eraser');
    document.getElementById('custom-pen-menu').classList.remove('active');
  });
  
  document.getElementById('pan-button').addEventListener('click', () => {
    setActiveTool('pan');
    document.getElementById('custom-pen-menu').classList.remove('active');
  });
  
  // Tab switching trong menu CustomPen
  document.querySelectorAll('.tab-button').forEach(tab => {
    tab.addEventListener('click', () => {
      // Loại bỏ active class từ tất cả các tab và tab-content
      document.querySelectorAll('.tab-button').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      // Thêm active class cho tab được chọn
      tab.classList.add('active');
      
      // Hiển thị nội dung tab tương ứng
      const tabId = tab.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');
    });
  });
  
  // Đóng menu CustomPen khi nhấn nút đóng
  document.querySelector('#custom-pen-menu .close-button').addEventListener('click', () => {
    document.getElementById('custom-pen-menu').classList.remove('active');
  });
  
  // Undo / Redo
  document.getElementById('undo-button').addEventListener('click', undo);
  document.getElementById('redo-button').addEventListener('click', redo);
  
  // Clear canvas
  document.getElementById('clear-button').addEventListener('click', () => {
    if (isAdmin && confirm('Xóa tất cả nội dung trên bảng vẽ?')) {
      socket.emit('clear-board');
      strokes = [];
      redoStack = [];
      redrawCanvas();
    } else if (!isAdmin) {
      alert('Chỉ quản trị viên mới có thể xóa bảng vẽ.');
    }
  });
  
  // Home button
  document.getElementById('home-button').addEventListener('click', () => {
    window.location.href = '/';
  });
  
  // Download button
  document.getElementById('download-button').addEventListener('click', downloadCanvas);
  
  // Share button
  document.getElementById('share-button').addEventListener('click', () => {
    showShareModal();
  });
  
  // Users button
  document.getElementById('users-button').addEventListener('click', () => {
    showUsersModal();
  });
  
  // Color palette trong CustomPen
  const colorOptions = document.querySelectorAll('.color-option');
  colorOptions.forEach(option => {
    option.addEventListener('click', function() {
      // Cập nhật trạng thái active
      colorOptions.forEach(opt => opt.classList.remove('active'));
      this.classList.add('active');
      
      // Cập nhật màu bút
      penColor = this.dataset.color;
      
      // Đóng menu sau một khoảng thời gian ngắn để người dùng thấy được sự thay đổi
      setTimeout(() => {
        document.getElementById('custom-pen-menu').classList.remove('active');
      }, 300);
    });
  });
  
  // Pen size
  generateSizeGrid();
  
  // Modal close buttons
  document.querySelectorAll('.close-button').forEach(button => {
    button.addEventListener('click', function() {
      this.closest('.modal').classList.remove('active');
    });
  });
  
  // Copy share link
  document.getElementById('copy-link-btn').addEventListener('click', copyShareLink);
  
  // Go home button in not found overlay
  document.getElementById('go-home-btn').addEventListener('click', () => {
    window.location.href = '/';
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboardShortcuts);
}

function setActiveTool(tool) {
  currentTool = tool;
  
  // Update UI - remove active class from all tool buttons
  const toolButtons = document.querySelectorAll('#toolbar button[id$="-button"]');
  toolButtons.forEach(btn => {
    if (btn.id === `${tool}-button`) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  
  // Update cursor
  canvasContainer.style.cursor = getCursorForTool(tool);
  
  // Close CustomPen menu if tool is not pen
  if (tool !== 'pen') {
    document.getElementById('custom-pen-menu').classList.remove('active');
  }
}

function undo() {
  if (strokes.length === 0) return;
  
  redoStack.push(strokes.pop());
  redrawCanvas();
  socket.emit('undo');
}

function redo() {
  if (redoStack.length === 0) return;
  
  strokes.push(redoStack.pop());
  redrawCanvas();
  socket.emit('redo');
}

function downloadCanvas() {
  // Create a temporary canvas to render the whiteboard without UI elements
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tempCtx = tempCanvas.getContext('2d');
  
  // Fill with white background
  tempCtx.fillStyle = 'white';
  tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
  
  // Draw all strokes
  tempCtx.save();
  tempCtx.translate(translateX, translateY);
  tempCtx.scale(scale, scale);
  
  strokes.forEach(stroke => {
    const points = stroke.points;
    if (!points || points.length < 2) return;
    
    // Thiết lập thuộc tính vẽ
    tempCtx.beginPath();
    tempCtx.strokeStyle = stroke.color;
    tempCtx.lineWidth = stroke.size;
    tempCtx.lineCap = 'round';
    tempCtx.lineJoin = 'round';
    
    const len = points.length;
    tempCtx.moveTo(points[0].x, points[0].y);
    
    // Áp dụng đường cong Bézier cho nét vẽ có nhiều hơn 2 điểm
    if (len > 2) {
      // Đối với 3 điểm, sử dụng đường cong quadratic đơn giản
      if (len === 3) {
        tempCtx.quadraticCurveTo(points[1].x, points[1].y, points[2].x, points[2].y);
      } else {
        // Sử dụng kỹ thuật Bézier mượt mà cho nhiều điểm
        for (let i = 1; i < len - 2; i++) {
          // Tính điểm trung bình giữa các điểm lân cận để làm điểm điều khiển
          const xc = (points[i].x + points[i+1].x) / 2;
          const yc = (points[i].y + points[i+1].y) / 2;
          
          // Vẽ đường cong từ điểm hiện tại đến điểm trung bình,
          // sử dụng điểm hiện tại làm điểm điều khiển
          tempCtx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
        }
        
        // Vẽ đoạn cuối cùng đến điểm cuối
        tempCtx.quadraticCurveTo(
          points[len-2].x, points[len-2].y,
          points[len-1].x, points[len-1].y
        );
      }
    } else {
      // Đối với 2 điểm, chỉ vẽ đường thẳng
      tempCtx.lineTo(points[1].x, points[1].y);
    }
    
    tempCtx.stroke();
  });
  
  tempCtx.restore();
  
  // Add copyright watermark
  tempCtx.font = '12px Arial';
  tempCtx.fillStyle = 'rgba(0,0,0,0.3)';
  tempCtx.textAlign = 'right';
  tempCtx.fillText('© MT Studio/NoxUI - SolarBoard', tempCanvas.width - 10, tempCanvas.height - 10);
  
  // Create download link
  const link = document.createElement('a');
  link.download = `solarboard-${boardId}-${new Date().toISOString().slice(0, 10)}.png`;
  link.href = tempCanvas.toDataURL('image/png');
  link.click();
}

function showShareModal() {
  const modal = document.getElementById('share-modal');
  const shareLink = document.getElementById('share-link');
  const boardStatus = document.querySelector('.board-status .status');
  const expirationStatus = document.getElementById('expiration-status');
  const expirationCountdown = document.getElementById('expiration-countdown');
  
  // Set values
  shareLink.value = window.location.href;
  boardStatus.textContent = boardInfo.isPublic ? 'Công khai' : 'Riêng tư';
  boardStatus.className = 'status ' + (boardInfo.isPublic ? 'public' : 'private');
  
  // Hiển thị thông tin thời hạn
  if (boardInfo.expiresIn && boardInfo.expiresIn !== 'never') {
    const now = Date.now();
    
    // Nếu có expirationDate, sử dụng giá trị đó
    // Nếu không, tính toán lại từ expiresIn và createdAt
    let expirationDate = boardInfo.expirationDate;
    let expText = '';
    
    if (!expirationDate && boardInfo.createdAt) {
      // Tính toán expirationDate từ createdAt và expiresIn
      switch(boardInfo.expiresIn) {
        case '14days':
          expirationDate = boardInfo.createdAt + (14 * 24 * 60 * 60 * 1000);
          expText = '14 ngày';
          break;
        case '30days':
          expirationDate = boardInfo.createdAt + (30 * 24 * 60 * 60 * 1000);
          expText = '30 ngày';
          break;
        case '3months':
          expirationDate = boardInfo.createdAt + (90 * 24 * 60 * 60 * 1000);
          expText = '3 tháng';
          break;
      }
    }
    
    if (expirationDate) {
      const expDate = new Date(expirationDate);
      const timeLeft = expirationDate - now;
      
      // Kiểm tra nếu đã hết hạn
      if (timeLeft <= 0) {
        expirationStatus.textContent = 'Đã hết hạn';
        expirationCountdown.innerHTML = 'Board này đã quá hạn và có thể bị xóa bất kỳ lúc nào.';
      } else {
        // Định dạng thời gian còn lại
        const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
        const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        
        // Hiển thị thông tin thời hạn
        expirationStatus.textContent = `${expText} (hết hạn: ${expDate.toLocaleDateString('vi-VN')})`;
        
        // Hiển thị đếm ngược
        expirationCountdown.innerHTML = `<i class="fas fa-hourglass-half"></i> Còn lại: ${days} ngày ${hours} giờ ${minutes} phút`;
      }
      
      // Hiển thị phần đếm ngược
      expirationCountdown.style.display = 'block';
    }
  } else {
    // Không có thời hạn
    expirationStatus.textContent = 'Không giới hạn';
    expirationCountdown.style.display = 'none';
  }
  
  // Show modal
  modal.classList.add('active');
}

function copyShareLink() {
  const shareLink = document.getElementById('share-link');
  shareLink.select();
  document.execCommand('copy');
  
  // Show feedback
  const copyBtn = document.getElementById('copy-link-btn');
  const originalText = copyBtn.innerHTML;
  copyBtn.innerHTML = '<i class="fas fa-check"></i> Đã sao chép';
  
  setTimeout(() => {
    copyBtn.innerHTML = originalText;
  }, 2000);
}

function showUsersModal() {
  const modal = document.getElementById('users-modal');
  const usersList = document.getElementById('users-list');
  const adminControls = document.getElementById('admin-controls');
  const blockedUsersSection = document.getElementById('blocked-users-section');
  const onlineUserCount = document.getElementById('online-user-count');
  
  // Clear current list
  usersList.innerHTML = '';
  
  // Count online users and update counter
  const onlineUsers = Object.values(boardInfo.users);
  onlineUserCount.textContent = onlineUsers.length;
  
  // Add users
  onlineUsers.forEach(user => {
    const isCurrentUser = user.id === userId;
    const isAdminUser = user.id === boardInfo.admin;
    
    const li = document.createElement('li');
    li.className = 'user-item';
    
    // Store user ID as data attribute for reference
    li.dataset.userId = user.id;
    
    // Add CSS classes for special users
    if (isCurrentUser) li.classList.add('current-user');
    if (isAdminUser) li.classList.add('admin-user');
    
    // Create user avatar (initial letter in circle)
    const avatarLetter = user.id.substring(0, 1).toUpperCase();
    
    // Generate random but consistent color based on user ID
    const colorCode = generateColorFromString(user.id);
    
    li.innerHTML = `
      <div class="user-avatar" style="background-color: ${colorCode}">
        ${avatarLetter}
      </div>
      <div class="user-info">
        <span class="user-id">${user.id.substring(0, 8)}</span>
        <span class="user-status">
          ${isCurrentUser ? '<span class="status-badge self">Bạn</span>' : ''}
          ${isAdminUser ? '<span class="status-badge admin">Admin</span>' : ''}
        </span>
      </div>
      <div class="user-actions"></div>
    `;
    
    // Add block button if current user is admin and this is not the admin or current user
    if (isAdmin && !isAdminUser && !isCurrentUser) {
      const blockBtn = document.createElement('button');
      blockBtn.className = 'action-btn block-btn';
      blockBtn.innerHTML = '<i class="fas fa-ban"></i>';
      blockBtn.title = 'Chặn người dùng này';
      blockBtn.addEventListener('click', () => {
        const reason = prompt('Nhập lý do chặn người dùng này:', 'Vi phạm quy tắc');
        if (reason !== null) {
          socket.emit('block-user', { targetUserId: user.id, reason });
          
          // Add to blocked users list
          if (!boardInfo.blockedUsers) boardInfo.blockedUsers = {};
          boardInfo.blockedUsers[user.id] = { reason };
          
          // Update UI
          updateBlockedUsersList();
          
          // Remove from active users
          delete boardInfo.users[user.id];
          
          // Update the modal
          showUsersModal();
        }
      });
      
      // Promote to admin button (if implemented on server)
      const promoteBtn = document.createElement('button');
      promoteBtn.className = 'action-btn promote-btn';
      promoteBtn.innerHTML = '<i class="fas fa-crown"></i>';
      promoteBtn.title = 'Đặt làm quản trị viên';
      promoteBtn.addEventListener('click', () => {
        if (confirm(`Bạn có chắc muốn đặt người dùng ${user.id.substring(0, 8)} làm quản trị viên không?`)) {
          socket.emit('promote-user', { targetUserId: user.id });
        }
      });
      
      const actionDiv = li.querySelector('.user-actions');
      actionDiv.appendChild(promoteBtn);
      actionDiv.appendChild(blockBtn);
    }
    
    usersList.appendChild(li);
  });
  
  // Setup admin controls
  if (isAdmin) {
    document.getElementById('toggle-public-btn').textContent = 
      boardInfo.isPublic ? 
        '<i class="fas fa-lock"></i> Đặt riêng tư' : 
        '<i class="fas fa-globe"></i> Đặt công khai';
    
    document.getElementById('toggle-public-btn').addEventListener('click', () => {
      const newState = !boardInfo.isPublic;
      socket.emit('toggle-public', { isPublic: newState });
      boardInfo.isPublic = newState;
      
      // Update button text immediately for better UX
      document.getElementById('toggle-public-btn').innerHTML = 
        newState ? 
          '<i class="fas fa-lock"></i> Đặt riêng tư' : 
          '<i class="fas fa-globe"></i> Đặt công khai';
    });
    
    document.getElementById('clear-all-btn').addEventListener('click', () => {
      if (confirm('Bạn có chắc muốn xóa tất cả nội dung trên bảng vẽ không? Hành động này không thể hoàn tác.')) {
        socket.emit('clear-board');
        strokes = [];
        redoStack = [];
        redrawCanvas();
        modal.classList.remove('active');
      }
    });
  }
  
  // Show/hide admin controls and blocked users section
  adminControls.classList.toggle('active', isAdmin);
  blockedUsersSection.classList.toggle('active', isAdmin);
  
  // Update blocked users list if admin
  if (isAdmin) {
    updateBlockedUsersList();
  }
  
  // Show modal
  modal.classList.add('active');
}

// Update the blocked users list in the modal
function updateBlockedUsersList() {
  const blockedUsersList = document.getElementById('blocked-users-list');
  
  // Clear the list
  blockedUsersList.innerHTML = '';
  
  // Check if there are blocked users
  if (!boardInfo.blockedUsers || Object.keys(boardInfo.blockedUsers).length === 0) {
    blockedUsersList.innerHTML = '<li class="empty-list">Chưa có người dùng nào bị chặn.</li>';
    return;
  }
  
  // Add blocked users to the list
  Object.entries(boardInfo.blockedUsers).forEach(([userId, data]) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${userId.substring(0, 8)}</span>
      <button class="unblock-btn" title="Bỏ chặn người dùng này">
        <i class="fas fa-user-check"></i> Bỏ chặn
      </button>
    `;
    
    // Add unblock action
    li.querySelector('.unblock-btn').addEventListener('click', () => {
      if (confirm(`Bạn có chắc muốn bỏ chặn người dùng ${userId.substring(0, 8)}?`)) {
        socket.emit('unblock-user', { targetUserId: userId });
        delete boardInfo.blockedUsers[userId];
        updateBlockedUsersList();
      }
    });
    
    blockedUsersList.appendChild(li);
  });
}

// Helper function to generate consistent colors from user ID strings
function generateColorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // Create a palette of visually appealing colors (avoiding too dark or too light)
  const colors = [
    '#6363DF', '#6D87EA', '#7A99FA', '#767BD2', '#ff3366', 
    '#33cc99', '#ff9900', '#2196F3', '#E91E63', '#00ACC1',
    '#5E35B1', '#FF5722', '#43A047', '#FB8C00', '#7E57C2'
  ];
  
  // Use the hash to select a color
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

function generateSizeGrid() {
  // Tạo lưới kích thước hiển thị
  const sizeGrid = document.querySelector('.size-grid');
  sizeGrid.innerHTML = '';
  
  // Mảng các kích thước đa dạng
  const sizes = [1, 2, 3, 5, 8, 10, 15, 20, 25, 30];
  
  // Hiển thị ít kích thước hơn trên giao diện
  const displaySizes = [1, 3, 8, 15, 30];
  
  displaySizes.forEach(size => {
    const sizeOption = document.createElement('button');
    sizeOption.className = 'size-option' + (size === penSize ? ' active' : '');
    sizeOption.style.width = `${Math.min(size * 1.5, 30)}px`;
    sizeOption.style.height = `${Math.min(size * 1.5, 30)}px`;
    sizeOption.style.backgroundColor = '#000';
    sizeOption.setAttribute('data-size', size);
    
    sizeOption.addEventListener('click', () => {
      // Cập nhật trạng thái active
      document.querySelectorAll('.size-option').forEach(opt => {
        opt.classList.remove('active');
      });
      sizeOption.classList.add('active');
      
      // Cập nhật kích thước bút
      penSize = size;
      updateSizePreview();
      
      // Cập nhật vị trí thanh trượt
      const sizeSlider = document.getElementById('size-slider');
      if (sizeSlider) {
        sizeSlider.value = size;
      }
      
      // Cập nhật trạng thái của nút cài đặt trước
      document.querySelectorAll('.size-preset').forEach(preset => {
        preset.classList.remove('active');
        if (parseInt(preset.getAttribute('data-size'), 10) === size) {
          preset.classList.add('active');
        }
      });
    });
    
    sizeGrid.appendChild(sizeOption);
  });
  
  // Xử lý thanh trượt kích thước
  const sizeSlider = document.getElementById('size-slider');
  if (sizeSlider) {
    // Đặt giá trị hiện tại
    sizeSlider.value = penSize;
    
    // Xử lý sự kiện khi thanh trượt thay đổi
    sizeSlider.addEventListener('input', function() {
      penSize = parseInt(this.value, 10);
      updateSizePreview();
      
      // Cập nhật trạng thái của các tùy chọn kích thước
      document.querySelectorAll('.size-option').forEach(opt => {
        opt.classList.remove('active');
        if (parseInt(opt.getAttribute('data-size'), 10) === penSize) {
          opt.classList.add('active');
        }
      });
      
      // Cập nhật trạng thái của nút cài đặt trước
      document.querySelectorAll('.size-preset').forEach(preset => {
        preset.classList.remove('active');
        if (parseInt(preset.getAttribute('data-size'), 10) === penSize) {
          preset.classList.add('active');
        }
      });
    });
  }
  
  // Xử lý các nút cài đặt trước
  document.querySelectorAll('.size-preset').forEach(preset => {
    preset.addEventListener('click', function() {
      const size = parseInt(this.getAttribute('data-size'), 10);
      
      // Đánh dấu nút đang được chọn
      document.querySelectorAll('.size-preset').forEach(p => {
        p.classList.remove('active');
      });
      this.classList.add('active');
      
      // Cập nhật kích thước bút
      penSize = size;
      updateSizePreview();
      
      // Cập nhật thanh trượt
      if (sizeSlider) {
        sizeSlider.value = size;
      }
      
      // Cập nhật trạng thái của các tùy chọn kích thước
      document.querySelectorAll('.size-option').forEach(opt => {
        opt.classList.remove('active');
        if (parseInt(opt.getAttribute('data-size'), 10) === size) {
          opt.classList.add('active');
        }
      });
    });
  });
  
  // Khởi tạo hiển thị kích thước
  updateSizePreview();
}

// Cập nhật hiển thị xem trước kích thước bút
function updateSizePreview() {
  const sizePreviewDot = document.getElementById('size-preview-dot');
  const sizeValueDisplay = document.getElementById('selected-size-value');
  
  if (sizePreviewDot && sizeValueDisplay) {
    // Cập nhật kích thước chấm xem trước
    sizePreviewDot.style.width = `${penSize}px`;
    sizePreviewDot.style.height = `${penSize}px`;
    
    // Cập nhật nhãn hiển thị kích thước
    sizeValueDisplay.textContent = `${penSize}px`;
  }
}

function handleKeyboardShortcuts(e) {
  // Ctrl+Z: Undo
  if (e.ctrlKey && e.key === 'z') {
    e.preventDefault();
    undo();
  }
  
  // Ctrl+Y or Ctrl+Shift+Z: Redo
  if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) {
    e.preventDefault();
    redo();
  }
  
  // E: Eraser
  if (e.key === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    setActiveTool('eraser');
  }
  
  // P: Pen
  if (e.key === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    setActiveTool('pen');
  }
  
  // H: Hand (Pan tool)
  if (e.key === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    setActiveTool('pan');
  }
  
  // Spacebar: Temporary pan (press and hold)
  if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey && !isPanning) {
    // Store the previous tool to restore it later
    if (!window.prevTool) {
      window.prevTool = currentTool;
    }
    setActiveTool('pan');
    
    // Add event listener to restore the previous tool when spacebar is released
    const spacebarUpHandler = (upEvent) => {
      if (upEvent.code === 'Space') {
        if (window.prevTool) {
          setActiveTool(window.prevTool);
          window.prevTool = null;
        }
        document.removeEventListener('keyup', spacebarUpHandler);
      }
    };
    
    document.addEventListener('keyup', spacebarUpHandler);
  }
}

// Socket.IO functionality
// Tạo fingerprint cho người dùng dựa trên thông tin trình duyệt
function generateFingerprint() {
  const components = [
    navigator.userAgent,
    navigator.language,
    screen.colorDepth,
    (new Date()).getTimezoneOffset(),
    screen.width + 'x' + screen.height,
    navigator.platform
  ];
  
  // Tạo chuỗi và hash thành fingerprint
  const fingerprint = components.join('###');
  
  // Sử dụng một hash đơn giản
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i++) {
    hash = ((hash << 5) - hash) + fingerprint.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return 'fp_' + Math.abs(hash).toString(36);
}

function initSocket() {
  socket = io ? io() : null;
  
  if (!socket) {
    console.error('Socket.IO is not available');
    return;
  }
  
  // Connection events
  socket.on('connect', () => {
    console.log('Socket.IO connected successfully');
    
    // Generate client fingerprint
    const fingerprint = generateFingerprint();
    
    // Gather client info for cross-browser blocking
    const clientInfo = {
      fingerprint: fingerprint,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screenSize: screen.width + 'x' + screen.height
    };
    
    socket.emit('join-board', {
      boardId,
      user: { id: userId },
      clientInfo: clientInfo
    });
  });
  
  socket.on('connect_error', (error) => {
    console.error('Socket.IO connection error:', error);
  });

  // Get initial board state
  socket.on('board-state', (data) => {
    strokes = data.strokes || [];
    boardInfo.users = data.users || {};
    boardInfo.isPublic = data.isPublic;
    boardInfo.expirationDate = data.expirationDate;
    boardInfo.expiresIn = data.expiresIn || 'never'; // Lưu lại giá trị expiresIn
    boardInfo.createdAt = data.createdAt;
    isAdmin = data.isAdmin;
    
    // Đảm bảo mỗi stroke đều có ID để xóa dễ dàng
    strokes.forEach(stroke => {
      if (!stroke.id) {
        stroke.id = self.crypto.randomUUID();
      }
    });
    
    // Show/hide admin controls
    if (isAdmin) {
      document.getElementById('clear-button').style.display = 'flex';
    }
    
    redrawCanvas();
    
    // Hide loading if shown
    document.getElementById('not-found-overlay').classList.add('hidden');
  });
  
  // New stroke from other users
  socket.on('stroke-received', (stroke) => {
    // Only add if from another user
    if (stroke.userId !== userId) {
      strokes.push(stroke);
      redrawCanvas();
    }
  });
  
  // User blocked
  socket.on('user-blocked', (data) => {
    if (data.userId === userId) {
      document.getElementById('blocked-overlay').classList.remove('hidden');
      document.getElementById('blocked-reason').textContent = data.reason || 'Không có lý do được cung cấp.';
    }
  });
  
  // User unblocked
  socket.on('user-unblocked', (data) => {
    if (data.userId === userId) {
      document.getElementById('blocked-overlay').classList.add('hidden');
    }
  });
  
  // Board cleared
  socket.on('board-cleared', () => {
    strokes = [];
    redoStack = [];
    redrawCanvas();
  });
  
  // Strokes erased by another user
  socket.on('strokes-erased', (data) => {
    const { indices } = data;
    if (!indices || indices.length === 0) return;
    
    // Create a new array without the erased strokes
    let newStrokes = [];
    let erasedStrokes = [];
    
    strokes.forEach((stroke, idx) => {
      if (!indices.includes(idx)) {
        newStrokes.push(stroke);
      } else {
        // Store erased strokes in case we need to undo
        erasedStrokes.push(stroke);
      }
    });
    
    // Update the strokes array
    strokes = newStrokes;
    
    // Add removed strokes to redo stack for possible undo
    erasedStrokes.forEach(stroke => redoStack.push(stroke));
    
    // Redraw canvas
    redrawCanvas();
  });
  
  // Strokes erased by ID from another user (more reliable)
  socket.on('strokes-erased-by-id', (data) => {
    const { strokeIds } = data;
    if (!strokeIds || strokeIds.length === 0) return;
    
    // Ẩn thông báo khi hoàn thành
    hideUpdateNotification();
    
    // Create a new array without the erased strokes
    let newStrokes = [];
    let erasedStrokes = [];
    
    strokes.forEach(stroke => {
      if (!strokeIds.includes(stroke.id)) {
        newStrokes.push(stroke);
      } else {
        // Store erased strokes in case we need to undo
        erasedStrokes.push(stroke);
      }
    });
    
    // Update the strokes array
    strokes = newStrokes;
    
    // Add removed strokes to redo stack for possible undo
    erasedStrokes.forEach(stroke => redoStack.push(stroke));
    
    // Redraw canvas
    redrawCanvas();
  });
  
  // User joined
  socket.on('user-joined', (data) => {
    boardInfo.users[data.user.id] = data.user;
  });
  
  // User left
  socket.on('user-left', (data) => {
    delete boardInfo.users[data.userId];
  });
  
  // Error
  socket.on('error', (data) => {
    console.error('Socket error:', data.message);
    
    if (data.message === 'Board not found') {
      document.getElementById('not-found-overlay').classList.remove('hidden');
    }
  });
  
  // Blocked
  socket.on('blocked', (data) => {
    document.getElementById('blocked-overlay').classList.remove('hidden');
    document.getElementById('blocked-reason').textContent = data.reason || 'Không có lý do được cung cấp.';
  });
  
  // Check block status (sự kiện cho các client kiểm tra nếu họ bị chặn)
  socket.on('check-block-status', (data) => {
    // Kiểm tra nếu user ID hiện tại của client trùng với ID bị chặn
    if (data.userId === userId) {
      document.getElementById('blocked-overlay').classList.remove('hidden');
      document.getElementById('blocked-reason').textContent = data.reason || 'Không có lý do được cung cấp.';
      console.log('Bạn đã bị chặn khỏi bảng này.');
      
      // Ngắt kết nối socket để ngăn người dùng tiếp tục tương tác
      socket.disconnect();
    }
  });
}

// Drawing event listeners
function setupDrawingEvents() {
  // Mouse events
  canvasContainer.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.getModifierState('Space')) {
      startDrawing(e);
    } else {
      startPan(e);
    }
  });
  
  canvasContainer.addEventListener('mousemove', (e) => {
    if (isDrawing) {
      draw(e);
    } else if (isPanning) {
      pan(e);
    }
  });
  
  canvasContainer.addEventListener('mouseup', () => {
    stopDrawing();
    endPan();
  });
  
  canvasContainer.addEventListener('mouseleave', () => {
    stopDrawing();
    endPan();
  });
  
  // Touch events
  let lastTouches = null;
  let pinchDistance = 0;
  
  // Biến để theo dõi di chuyển của touch
  let touchStartTime = 0;
  let touchStartX = 0;
  let touchStartY = 0;
  let minMovementToStartDrawing = 5; // Số pixel tối thiểu để bắt đầu vẽ (phân biệt chạm và vẽ)
  let touchStarted = false; // Theo dõi xem đã thực sự bắt đầu vẽ chưa
  
  canvasContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      // Single touch - LƯU Ý: không bắt đầu vẽ ngay
      if (!e.target.closest('.toolbar-group, .modal, .side-panel')) {
        e.preventDefault();
        
        // Lưu thời điểm bắt đầu chạm
        touchStartTime = Date.now();
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStarted = false; // Chưa bắt đầu vẽ, chỉ đang chạm
        
        // Không gọi startDrawing() ở đây để tránh điểm vẽ khi chỉ chạm
      }
    } else if (e.touches.length === 2) {
      // Two fingers - pinch zoom or pan
      e.preventDefault();
      endPan();
      stopDrawing();
      
      // Store initial touch points for pinch zoom
      lastTouches = Array.from(e.touches);
      pinchDistance = getPinchDistance(e.touches);
      
      // Hiển thị chỉ báo zoom+pan khi bắt đầu thao tác với 2 ngón tay
      const touchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2
      };
      
      // Hiển thị chỉ báo ở vị trí gần điểm trung tâm của 2 ngón tay
      const indicator = document.getElementById('zoom-indicator') || document.createElement('div');
      if (!indicator.id) {
        indicator.id = 'zoom-indicator';
        document.body.appendChild(indicator);
      }
      
      indicator.innerHTML = `<i class="fas fa-search-plus"></i> ${Math.round(scale * 100)}% <i class="fas fa-arrows-alt" style="margin-left: 8px;"></i>`;
      indicator.style.bottom = 'auto';
      indicator.style.left = 'auto';
      indicator.style.top = `${touchCenter.y + 40}px`;
      indicator.style.transform = 'translateX(-50%)';
      indicator.style.right = '50%';
      indicator.classList.add('active');
      
      // Clear any existing timeout
      if (window.zoomTimeout) {
        clearTimeout(window.zoomTimeout);
      }
    }
  });
  
  canvasContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1) {
      if (isDrawing) {
        // Đã đang vẽ, tiếp tục vẽ
        e.preventDefault();
        draw(e);
      } else if (!e.target.closest('.toolbar-group, .modal, .side-panel')) {
        e.preventDefault();
        const touch = e.touches[0];
        
        // Tính khoảng cách di chuyển so với điểm bắt đầu touch
        const moveX = Math.abs(touch.clientX - touchStartX);
        const moveY = Math.abs(touch.clientY - touchStartY);
        const totalMovement = Math.sqrt(moveX * moveX + moveY * moveY);
        
        // Nếu chưa bắt đầu vẽ và người dùng đã di chuyển đủ xa để xác định là muốn vẽ
        if (!touchStarted && !isPanning && 
            currentTool !== 'pan' && 
            totalMovement >= minMovementToStartDrawing && 
            Date.now() - touchStartTime < 300) { // Chỉ xem xét cử chỉ vẽ nếu trong vòng 300ms
          
          touchStarted = true;
          startDrawing(e);
        } 
        // Nếu không đủ điều kiện vẽ thì xem xét thao tác pan
        else if (!touchStarted && !isDrawing && 
                (totalMovement >= minMovementToStartDrawing || Date.now() - touchStartTime >= 300)) {
          
          if (!isPanning) {
            isPanning = true;
            panStartX = touch.clientX - translateX;
            panStartY = touch.clientY - translateY;
          } else {
            translateX = touch.clientX - panStartX;
            translateY = touch.clientY - panStartY;
            redrawCanvas();
          }
        }
      }
    } else if (e.touches.length === 2 && lastTouches) {
      e.preventDefault();
      
      // Xử lý kết hợp pinch zoom và pan đồng thời
      const currentTouchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2
      };
      
      const previousTouchCenter = {
        x: (lastTouches[0].clientX + lastTouches[1].clientX) / 2,
        y: (lastTouches[0].clientY + lastTouches[1].clientY) / 2
      };
      
      // Tính toán lượng di chuyển của điểm trung tâm hai ngón tay
      const deltaX = currentTouchCenter.x - previousTouchCenter.x;
      const deltaY = currentTouchCenter.y - previousTouchCenter.y;
      
      // Xử lý pinch zoom
      const currentDistance = getPinchDistance(e.touches);
      const previousDistance = getPinchDistance(lastTouches);
      
      // Chỉ áp dụng zoom khi thay đổi đủ lớn
      if (Math.abs(currentDistance / previousDistance - 1) > 0.01) {
        const rect = canvas.getBoundingClientRect();
        const pinchRatio = currentDistance / previousDistance;
        
        // Giới hạn scale trong khoảng phù hợp
        const prevScale = scale;
        const newScale = Math.max(0.1, Math.min(8, prevScale * pinchRatio));
        
        // Tính toán tọa độ trước khi zoom
        const x1 = (currentTouchCenter.x - rect.left - translateX) / prevScale;
        const y1 = (currentTouchCenter.y - rect.top - translateY) / prevScale;
        
        // Điều chỉnh translation để zoom quanh điểm trung tâm
        translateX = currentTouchCenter.x - x1 * newScale;
        translateY = currentTouchCenter.y - y1 * newScale;
        
        // Cập nhật scale
        scale = newScale;
        
        // Hiển thị chỉ báo zoom
        showZoomPanIndicator();
      }
      
      // Áp dụng pan theo sự di chuyển của điểm trung tâm
      translateX += deltaX;
      translateY += deltaY;
      
      // Cập nhật canvas
      redrawCanvas();
      
      // Lưu trạng thái hiện tại cho lần xử lý tiếp theo
      lastTouches = Array.from(e.touches);
      pinchDistance = currentDistance;
    }
  });
  
  canvasContainer.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      // Reset all states when all fingers are lifted
      stopDrawing();
      endPan();
      lastTouches = null;
      pinchDistance = 0;
      
      // Ẩn chỉ báo zoom sau một khoảng thời gian ngắn
      const indicator = document.getElementById('zoom-indicator');
      if (indicator) {
        // Đặt lại vị trí mặc định
        indicator.style.bottom = '25px';
        indicator.style.left = '50%';
        indicator.style.top = 'auto';
        indicator.style.right = 'auto';
        
        // Tự động ẩn sau 1.5 giây
        window.zoomTimeout = setTimeout(() => {
          indicator.classList.remove('active');
        }, 1500);
      }
    } else if (e.touches.length === 1) {
      // Reset pinch data when going from 2 to 1 fingers
      lastTouches = null;
      pinchDistance = 0;
      
      // Tương tự, ẩn chỉ báo zoom khi chuyển từ 2 ngón tay về 1
      const indicator = document.getElementById('zoom-indicator');
      if (indicator) {
        // Đặt lại vị trí mặc định
        indicator.style.bottom = '25px';
        indicator.style.left = '50%';
        indicator.style.top = 'auto';
        indicator.style.right = 'auto';
        
        // Tự động ẩn sau 1.5 giây
        window.zoomTimeout = setTimeout(() => {
          indicator.classList.remove('active');
        }, 1500);
      }
    }
  });
  
  canvasContainer.addEventListener('touchcancel', () => {
    stopDrawing();
    endPan();
    lastTouches = null;
    pinchDistance = 0;
  });
  
  // Helper function to calculate distance between two touch points
  function getPinchDistance(touches) {
    return Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY
    );
  }
  
  // Zoom
  canvasContainer.addEventListener('wheel', handleZoom);
  
  // Prevent context menu on right-click
  canvasContainer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });
}

// Initialization
function init() {
  initCanvas();
  setupUIEvents();
  setupDrawingEvents();
  initSocket();
}

// Hiển thị thông báo cập nhật khi vẽ hoặc xóa
function showUpdateNotification() {
  if (isUpdating) return; // Nếu đang hiển thị rồi thì bỏ qua
  
  const notification = document.getElementById('status-notification');
  notification.classList.remove('hidden');
  isUpdating = true;
  
  // Đặt timeout để ẩn thông báo sau một khoảng thời gian
  if (updateTimeout) {
    clearTimeout(updateTimeout);
  }
  
  updateTimeout = setTimeout(() => {
    notification.classList.add('hidden');
    isUpdating = false;
    updateTimeout = null;
  }, 2000);
}

// Ẩn thông báo cập nhật ngay lập tức
function hideUpdateNotification() {
  const notification = document.getElementById('status-notification');
  notification.classList.add('hidden');
  isUpdating = false;
  
  if (updateTimeout) {
    clearTimeout(updateTimeout);
    updateTimeout = null;
  }
}

// Start the application
document.addEventListener('DOMContentLoaded', init);