const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Session-based storage
const sessions = new Map(); // sessionId -> { client, qrCode, isReady, status, messageQueue }
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

// Session management
const getSession = (sessionId) => {
  if (!sessionId) return null;
  
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      client: null,
      qrCode: null,
      isReady: false,
      status: 'initializing',
      messageQueue: [],
      isProcessingQueue: false,
      createdAt: Date.now()
    });
  }
  
  return sessions.get(sessionId);
};

// Session-specific message queue processing
const processMessageQueue = async (sessionId) => {
  const session = getSession(sessionId);
  if (!session || session.isProcessingQueue || session.messageQueue.length === 0 || !session.isReady) return;
  
  session.isProcessingQueue = true;
  console.log(`Processing ${session.messageQueue.length} messages for session ${sessionId}`);
  
  while (session.messageQueue.length > 0 && session.isReady) {
    const messageData = session.messageQueue.shift();
    try {
      const formattedNumber = formatPhoneNumber(messageData.number);
      const chatId = formattedNumber + '@c.us';
      await session.client.sendMessage(chatId, messageData.message);
      console.log(`✅ Message sent to ${formattedNumber} (session: ${sessionId})`);
      if (messageData.statusCallback) messageData.statusCallback('sent');
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Failed to send message to ${messageData.number}:`, error.message);
      if (messageData.statusCallback) messageData.statusCallback('failed', error.message);
    }
  }
  session.isProcessingQueue = false;
  console.log(`✅ Queue processing completed for session ${sessionId}`);
};

// Format phone number to international format
const formatPhoneNumber = (phone) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) return digits;
  if (digits.length === 10) return '91' + digits;
  if (digits.length >= 10) return '91' + digits.slice(-10);
  return digits;
};

// Initialize WhatsApp client for specific session
const initializeClient = (sessionId) => {
  console.log(`🚀 Initializing WhatsApp client for session: ${sessionId}`);
  const session = getSession(sessionId);
  if (!session) return;

  session.client = new Client({
    authStrategy: new LocalAuth({ dataPath: `./whatsapp-session-${sessionId}` }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  session.client.on('qr', (qr) => {
    console.log(`📱 QR Code received for session: ${sessionId}`);
    session.status = 'qr_ready';
    QRCode.toDataURL(qr, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: { dark: '#000000', light: '#FFFFFF' },
      width: 256
    }, (err, url) => {
      if (!err) {
        session.qrCode = url;
        console.log(`✅ QR Code generated for session: ${sessionId}`);
      } else {
        console.error(`❌ QR Code generation failed for session ${sessionId}:`, err);
      }
    });
  });

  session.client.on('ready', () => {
    console.log(`✅ WhatsApp client ready for session: ${sessionId}`);
    session.isReady = true;
    session.status = 'ready';
    session.qrCode = null;
  });

  session.client.on('authenticated', () => {
    console.log(`✅ WhatsApp client authenticated for session: ${sessionId}`);
    session.status = 'authenticated';
  });

  session.client.on('auth_failure', (msg) => {
    console.error(`❌ Authentication failed for session ${sessionId}:`, msg);
    session.status = 'auth_failed';
  });

  session.client.on('disconnected', (reason) => {
    console.log(`⚠️ WhatsApp client disconnected for session ${sessionId}:`, reason);
    session.isReady = false;
    session.status = 'disconnected';
    // Only auto-reconnect for network issues, not manual disconnections
    if (reason !== 'NAVIGATION' && reason !== 'LOGOUT') {
      setTimeout(() => {
        console.log(`🔄 Attempting to reconnect session: ${sessionId} (reason: ${reason})`);
        if (sessions.has(sessionId) && sessions.get(sessionId).status !== 'manually_disconnected') {
          initializeClient(sessionId);
        }
      }, 10000); // Increased delay to 10 seconds
    }
  });

  session.client.initialize();
};

// Clean up old sessions
const cleanupOldSessions = () => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT) {
      console.log(`🧹 Cleaning up old session: ${sessionId}`);
      if (session.client) {
        try { session.client.destroy(); } catch (e) { console.error('Error destroying client:', e); }
      }
      sessions.delete(sessionId);
    }
  }
};

// Routes

// Health check
app.get('/health', (req, res) => {
  const activeSessions = Array.from(sessions.entries()).map(([id, session]) => ({
    id: id.substring(0, 20) + '...',
    status: session.status,
    ready: session.isReady,
    queue_length: session.messageQueue.length
  }));

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.length,
    sessions: activeSessions
  });
});

// Get connection status for specific session
app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.json({
      status: 'not_found',
      ready: false,
      qr_available: false,
      queue_length: 0,
      timestamp: new Date().toISOString()
    });
  }

  res.json({
    status: session.status,
    ready: session.isReady,
    qr_available: !!session.qrCode,
    queue_length: session.messageQueue.length,
    timestamp: new Date().toISOString()
  });
});

// Get QR code for specific session
app.post('/api/qr/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  console.log(`🔍 QR request for session: ${sessionId}`);
  
  const session = getSession(sessionId);
  if (!session) {
    return res.json({
      success: false,
      message: 'Invalid session ID'
    });
  }

  // Initialize client if not already done
  if (!session.client) {
    initializeClient(sessionId);
    return res.json({
      success: true,
      message: 'Client initialization started. QR code will be available shortly.',
      qr_code: null
    });
  }

  if (session.qrCode) {
    res.json({
      success: true,
      qr_code: session.qrCode,
      message: 'Scan this QR code with WhatsApp'
    });
  } else if (session.isReady) {
    res.json({
      success: false,
      message: 'WhatsApp is already connected for this session'
    });
  } else {
    res.json({
      success: false,
      message: `QR code not available. Status: ${session.status}`
    });
  }
});

// Reset specific session
app.post('/api/reset/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  console.log(`🔄 Resetting session: ${sessionId}`);
  
  const session = getSession(sessionId);
  if (!session) {
    return res.json({
      success: false,
      message: 'Session not found'
    });
  }

  session.qrCode = null;
  session.isReady = false;
  session.status = 'resetting';
  session.messageQueue = [];
  
  if (session.client) {
    try { 
      session.client.destroy();
      session.client = null;
    } catch (error) { 
      console.error('Error destroying client:', error); 
    }
  }
  
  setTimeout(() => { initializeClient(sessionId); }, 2000);
  
  res.json({
    success: true,
    message: 'Session reset initiated. Get a new QR code in a few seconds.'
  });
});

// Disconnect specific session (manual disconnection)
app.post('/api/disconnect/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  console.log(`🔌 Manually disconnecting session: ${sessionId}`);
  
  const session = getSession(sessionId);
  if (!session) {
    return res.json({
      success: false,
      message: 'Session not found'
    });
  }

  session.qrCode = null;
  session.isReady = false;
  session.status = 'manually_disconnected'; // Prevent auto-reconnection
  session.messageQueue = [];
  
  if (session.client) {
    try { 
      session.client.logout(); // Proper logout to unlink device
      session.client.destroy();
      session.client = null;
    } catch (error) { 
      console.error('Error disconnecting client:', error); 
    }
  }
  
  res.json({
    success: true,
    message: 'Session disconnected and device unlinked successfully.'
  });
});

// Send bulk messages for specific session
app.post('/api/send-bulk-messages', async (req, res) => {
  const { messages } = req.body;
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'Session ID is required in X-Session-ID header'
    });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Messages array is required and cannot be empty'
    });
  }

  const session = getSession(sessionId);
  if (!session || !session.isReady) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp client is not ready for this session. Current status: ' + (session?.status || 'not_found')
    });
  }

  const results = [];
  messages.forEach((msg, index) => {
    if (!msg.number || !msg.message) {
      results.push({
        index,
        success: false,
        error: 'Number and message are required'
      });
      return;
    }
    
    const messageId = uuidv4();
    session.messageQueue.push({
      id: messageId,
      number: msg.number,
      message: msg.message,
      timestamp: new Date().toISOString()
    });
    
    results.push({
      index,
      success: true,
      message_id: messageId,
      status: 'queued'
    });
  });

  processMessageQueue(sessionId);
  
  res.json({
    success: true,
    message: `${results.filter(r => r.success).length} messages queued successfully`,
    results,
    queue_length: session.messageQueue.length
  });
});

// Send event notifications for specific session
app.post('/api/send-event-messages', async (req, res) => {
  const { event, staff_list, staff_assignments } = req.body;
  const sessionId = req.headers['x-session-id'];

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'Session ID is required in X-Session-ID header'
    });
  }

  if (!event || !Array.isArray(staff_list) || staff_list.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Event data and staff list are required'
    });
  }

  const session = getSession(sessionId);
  if (!session || !session.isReady) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp client is not ready for this session. Current status: ' + (session?.status || 'not_found')
    });
  }

  const staffDayAssignments = {};
  if (staff_assignments && Array.isArray(staff_assignments)) {
    staff_assignments.forEach(assignment => {
      if (!staffDayAssignments[assignment.staff_id]) staffDayAssignments[assignment.staff_id] = [];
      staffDayAssignments[assignment.staff_id].push({
        day_number: assignment.day_number,
        day_date: assignment.day_date,
        role: assignment.role
      });
    });
    Object.keys(staffDayAssignments).forEach(staffId => {
      staffDayAssignments[staffId].sort((a, b) => a.day_number - b.day_number);
    });
  }

  const messages = [];
  staff_list.forEach(staff => {
    const assignments = staffDayAssignments[staff.id] || [];
    if (assignments.length > 0) {
      assignments.forEach(assignment => {
        const message = formatEventMessage(event, staff, assignment);
        messages.push({
          number: staff.mobile_number,
          message: message,
          staff_id: staff.id,
          day_number: assignment.day_number
        });
      });
    } else {
      const message = formatEventMessage(event, staff, null);
      messages.push({
        number: staff.mobile_number,
        message: message,
        staff_id: staff.id,
        day_number: 1
      });
    }
  });

  messages.sort((a, b) => a.day_number - b.day_number);
  const results = [];

  messages.forEach((msg, index) => {
    const messageId = uuidv4();
    session.messageQueue.push({
      id: messageId,
      number: msg.number,
      message: msg.message,
      timestamp: new Date().toISOString(),
      type: 'event',
      event_id: event.id,
      staff_id: msg.staff_id,
      day_number: msg.day_number
    });
    results.push({
      index,
      staff_id: msg.staff_id,
      day_number: msg.day_number,
      success: true,
      message_id: messageId,
      status: 'queued'
    });
  });

  processMessageQueue(sessionId);
  
  res.json({
    success: true,
    message: `Event notifications queued for ${staff_list.length} staff members`,
    event_title: event.title,
    results,
    queue_length: session.messageQueue.length
  });
});

// Send task notifications for specific session
app.post('/api/send-task-messages', async (req, res) => {
  const { task, staff_list } = req.body;
  const sessionId = req.headers['x-session-id'];

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'Session ID is required in X-Session-ID header'
    });
  }

  if (!task || !Array.isArray(staff_list) || staff_list.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Task data and staff list are required'
    });
  }

  const session = getSession(sessionId);
  if (!session || !session.isReady) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp client is not ready for this session. Current status: ' + (session?.status || 'not_found')
    });
  }

  const messages = staff_list.map(staff => {
    const message = formatTaskMessage(task, staff);
    return { number: staff.mobile_number, message: message };
  });

  const results = [];
  messages.forEach((msg, index) => {
    const messageId = uuidv4();
    session.messageQueue.push({
      id: messageId,
      number: msg.number,
      message: msg.message,
      timestamp: new Date().toISOString(),
      type: 'task',
      task_id: task.id
    });
    results.push({
      index,
      staff_id: staff_list[index].id,
      success: true,
      message_id: messageId,
      status: 'queued'
    });
  });

  processMessageQueue(sessionId);

  res.json({
    success: true,
    message: `Task notifications queued for ${staff_list.length} staff members`,
    task_title: task.title,
    results,
    queue_length: session.messageQueue.length
  });
});

// Clear message queue for specific session
app.post('/api/clear-queue/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.json({
      success: false,
      message: 'Session not found'
    });
  }

  const queueLength = session.messageQueue.length;
  session.messageQueue = [];
  
  res.json({
    success: true,
    message: `Cleared ${queueLength} messages from queue for session ${sessionId}`
  });
});

// Get queue status for specific session
app.get('/api/queue/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.json({
      success: false,
      queue_length: 0,
      is_processing: false,
      messages: [],
      error: 'Session not found'
    });
  }

  res.json({
    success: true,
    queue_length: session.messageQueue.length,
    is_processing: session.isProcessingQueue,
    messages: session.messageQueue.slice(0, 10)
  });
});

// Message formatting functions with single-asterisk WhatsApp bold
const formatEventMessage = (event, staff, assignment) => {
  const formatDate = (dateString) => {
    if (!dateString || dateString === 'undefined' || dateString === 'null') return 'Date not specified';
    try {
      let date;
      if (typeof dateString === 'string' && dateString.match(/^\d{4}-\d{2}-\d{2}$/)) {
        date = new Date(dateString + 'T00:00:00');
      } else {
        date = new Date(dateString);
      }
      if (isNaN(date.getTime())) return 'Invalid date';
      return date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch {
      return 'Date formatting error';
    }
  };

  const getOrdinalNumber = (num) => {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const v = num % 100;
    return num + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
  };

  let message = `*EVENT ASSIGNMENT*\n\n`;
  message += `Hello *${staff.full_name}*,\n\n`;
  if (assignment) {
    const dayText = getOrdinalNumber(assignment.day_number);
    message += `You are assigned as *${assignment.role.toUpperCase()}* on *DAY ${dayText}* for the following event:\n\n`;
    message += `*Title*: ${event.title || 'Not specified'}\n`;
    message += `*Type*: ${event.eventType || event.event_type || 'Not specified'}\n`;
    
    // For multi-day events, show full date range
    if ((event.totalDays || event.total_days) && (event.totalDays > 1 || event.total_days > 1)) {
      const startDate = new Date((event.eventDate || event.event_date) + 'T00:00:00');
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + (event.totalDays || event.total_days) - 1);
      const startFormatted = startDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      const endFormatted = endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      message += `*Date*: ${startFormatted} - ${endFormatted}\n`;
    } else {
      message += `*Date*: ${formatDate(assignment.day_date)}\n`;
    }
  } else {
    message += `You are assigned as *${(event.role || staff.role || 'STAFF').toUpperCase()}* for the following event:\n\n`;
    message += `*Title*: ${event.title || 'Not specified'}\n`;
    message += `*Type*: ${event.eventType || event.event_type || 'Not specified'}\n`;
    if ((event.totalDays || event.total_days) && (event.totalDays > 1 || event.total_days > 1)) {
      const startDate = new Date((event.eventDate || event.event_date) + 'T00:00:00');
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + (event.totalDays || event.total_days) - 1);
      const startFormatted = startDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      const endFormatted = endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      message += `*Date*: ${startFormatted} - ${endFormatted}\n`;
    } else {
      message += `*Date*: ${formatDate(event.eventDate || event.event_date)}\n`;
    }
  }
  if (event.clientName || event.client_name) {
    message += `*Client*: ${event.clientName || event.client_name}\n`;
  }
  if (event.venue && event.venue.trim() !== '') {
    message += `*Venue*: ${event.venue}\n`;
  }
  message += `*Contact*: ${staff.mobile_number}\n`;
  if (event.description && event.description.trim() !== '') {
    message += `\n_${event.description}_\n`;
  }
  message += `\nThank you for being part of *Prit Photo*`;
  return message;
};

const formatTaskMessage = (task, staff) => {
  const formatDate = (dateString) => {
    if (!dateString || dateString === 'undefined' || dateString === 'null') return 'Date not specified';
    try {
      let date;
      if (typeof dateString === 'string' && dateString.match(/^\d{4}-\d{2}-\d{2}$/)) {
        date = new Date(dateString + 'T00:00:00');
      } else {
        date = new Date(dateString);
      }
      if (isNaN(date.getTime())) return 'Invalid date';
      return date.toLocaleDateString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return 'Date formatting error';
    }
  };

  let message = `*TASK ASSIGNMENT*\n\n`;
  message += `Hello *${staff.full_name}*,\n\n`;
  message += `You have been assigned a new task:\n\n`;
  message += `*Title*: ${task.title || 'Not specified'}\n`;
  message += `*Type*: ${task.taskType || task.task_type || 'General'}\n`;
  message += `*Priority*: ${task.priority || 'Medium'}\n`;
  if (task.dueDate || task.due_date) {
    message += `*Due*: ${formatDate(task.dueDate || task.due_date)}\n`;
  }
  if (task.eventTitle || task.event_title) {
    message += `*Event*: ${task.eventTitle || task.event_title}\n`;
  }
  if (task.amount && task.amount > 0) {
    message += `*Amount*: ₹${task.amount.toLocaleString()}\n`;
  }
  if (task.description && task.description.trim() !== '') {
    message += `\n*Details:*\n_${task.description}_\n`;
  }
  message += `\nThank you for being part of *Prit Photo*`;
  return message;
};

// Process queue every 30 seconds + cleanup old sessions
cron.schedule('*/30 * * * * *', () => {
  // Process message queues for all active sessions
  for (const [sessionId, session] of sessions.entries()) {
    if (session.messageQueue.length > 0 && session.isReady && !session.isProcessingQueue) {
      console.log(`⏰ Cron: Processing message queue for session ${sessionId}...`);
      processMessageQueue(sessionId);
    }
  }
  
  // Cleanup old sessions every 5 minutes
  if (Date.now() % 300000 < 30000) { // Every ~5 minutes
    cleanupOldSessions();
  }
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Bulk Service running on port ${PORT}`);
  console.log(`📱 Health check: http://localhost:${PORT}/health`);
  console.log(`💡 Multi-session support enabled`);
  // Don't initialize a global client anymore - clients are initialized per session
});
