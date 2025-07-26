const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Lightweight middleware setup
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['authorization', 'x-client-info', 'apikey', 'content-type', 'x-session-id']
}));
app.use(express.json({ limit: '5mb' }));

// Persistent session storage configuration
const SESSIONS_FILE = path.join(__dirname, 'persistent-sessions.json');
const sessions = new Map(); // firmId -> { client, qrCode, isReady, status, messageQueue, lastActivity }
const SESSION_TIMEOUT = 30 * 24 * 60 * 60 * 1000; // 30 days for permanent linking
const HEARTBEAT_INTERVAL = 60000; // 1 minute heartbeat

// Persistent session storage functions
const loadPersistedSessions = async () => {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf8');
    const persistedSessions = JSON.parse(data);
    
    for (const [firmId, sessionData] of Object.entries(persistedSessions)) {
      if (sessionData.isPersistent && sessionData.lastLinked) {
        console.log(`🔄 Restoring persistent session for firm: ${firmId}`);
        const sessionKey = `firm_${firmId}`;
        
        sessions.set(sessionKey, {
          firmId,
          client: null,
          qrCode: null,
          isReady: false,
          status: 'restoring',
          messageQueue: [],
          isProcessingQueue: false,
          lastActivity: Date.now(),
          createdAt: sessionData.createdAt || Date.now(),
          reconnectAttempts: 0,
          maxReconnectAttempts: 5,
          isPersistent: true,
          lastLinked: sessionData.lastLinked
        });
        
        // Initialize client for restored session
        setTimeout(() => initializeClient(sessionKey), 2000);
      }
    }
    
    console.log(`✅ Restored ${Object.keys(persistedSessions).length} persistent sessions`);
  } catch (error) {
    console.log('📝 No existing persistent sessions file found, starting fresh');
  }
};

const savePersistedSessions = async () => {
  try {
    const persistedData = {};
    
    for (const [sessionKey, session] of sessions.entries()) {
      if (session.isPersistent && session.lastLinked) {
        persistedData[session.firmId] = {
          firmId: session.firmId,
          isPersistent: true,
          lastLinked: session.lastLinked,
          createdAt: session.createdAt,
          status: session.status
        };
      }
    }
    
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(persistedData, null, 2));
    console.log(`💾 Saved ${Object.keys(persistedData).length} persistent sessions`);
  } catch (error) {
    console.error('❌ Error saving persistent sessions:', error);
  }
};

// Optimized session management with firm-based isolation and persistence
const getOrCreateSession = (firmId) => {
  if (!firmId) return null;
  
  const sessionKey = `firm_${firmId}`;
  
  if (!sessions.has(sessionKey)) {
    sessions.set(sessionKey, {
      firmId,
      client: null,
      qrCode: null,
      isReady: false,
      status: 'disconnected',
      messageQueue: [],
      isProcessingQueue: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      reconnectAttempts: 0,
      maxReconnectAttempts: 5,
      isPersistent: false,
      lastLinked: null
    });
  }
  
  // Update last activity
  const session = sessions.get(sessionKey);
  session.lastActivity = Date.now();
  return session;
};

const getSession = (sessionId) => {
  // Extract firm ID from session ID format: firm_<firmId>_<timestamp>_<random>
  const firmMatch = sessionId?.match(/^firm_([^_]+)_/);
  if (!firmMatch) return null;
  
  return getOrCreateSession(firmMatch[1]);
};

// Optimized message queue processing with better error handling
const processMessageQueue = async (sessionKey) => {
  const session = sessions.get(sessionKey);
  if (!session || session.isProcessingQueue || session.messageQueue.length === 0 || !session.isReady) return;
  
  session.isProcessingQueue = true;
  const batchSize = Math.min(5, session.messageQueue.length); // Process in smaller batches
  console.log(`📤 Processing ${batchSize} messages for firm ${session.firmId}`);
  
  for (let i = 0; i < batchSize && session.isReady; i++) {
    const messageData = session.messageQueue.shift();
    try {
      const formattedNumber = formatPhoneNumber(messageData.number);
      const chatId = formattedNumber + '@c.us';
      
      await session.client.sendMessage(chatId, messageData.message);
      console.log(`✅ Message sent to ${formattedNumber}`);
      
      // Longer delay to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (error) {
      console.error(`❌ Failed to send message to ${messageData.number}:`, error.message);
      
      // If rate limited, re-queue the message
      if (error.message.includes('rate') || error.message.includes('limit')) {
        session.messageQueue.unshift(messageData);
        console.log('🔄 Message re-queued due to rate limit');
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
        break;
      }
    }
  }
  
  session.isProcessingQueue = false;
  console.log(`✅ Batch processing completed for firm ${session.firmId}`);
};

// Format phone number to international format
const formatPhoneNumber = (phone) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) return digits;
  if (digits.length === 10) return '91' + digits;
  if (digits.length >= 10) return '91' + digits.slice(-10);
  return digits;
};

// Optimized WhatsApp client initialization with better resource management
const initializeClient = (sessionKey) => {
  const session = sessions.get(sessionKey);
  if (!session || session.client) return;

  console.log(`🚀 Initializing WhatsApp client for firm: ${session.firmId}`);
  session.status = 'initializing';
  session.reconnectAttempts++;

  // Prevent too many reconnection attempts
  if (session.reconnectAttempts > session.maxReconnectAttempts) {
    console.log(`⚠️ Max reconnection attempts reached for firm ${session.firmId}`);
    session.status = 'max_attempts_reached';
    return;
  }

  session.client = new Client({
    authStrategy: new LocalAuth({ dataPath: `./whatsapp-session-firm-${session.firmId}` }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ],
      timeout: 60000 // 1 minute timeout
    }
  });

  // QR event handler
  session.client.on('qr', (qr) => {
    console.log(`📱 QR Code received for firm: ${session.firmId}`);
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
        console.log(`✅ QR Code generated for firm: ${session.firmId}`);
      } else {
        console.error(`❌ QR Code generation failed for firm ${session.firmId}:`, err);
        session.status = 'qr_failed';
      }
    });
  });

  // Ready event handler - Mark as persistent when successfully connected
  session.client.on('ready', () => {
    console.log(`✅ WhatsApp client ready for firm: ${session.firmId}`);
    session.isReady = true;
    session.status = 'ready';
    session.qrCode = null;
    session.reconnectAttempts = 0; // Reset reconnection attempts on successful connection
    
    // Mark session as persistent and save to disk
    session.isPersistent = true;
    session.lastLinked = new Date().toISOString();
    savePersistedSessions();
    
    console.log(`🔗 Session permanently linked for firm: ${session.firmId}`);
  });

  // Authentication event handler
  session.client.on('authenticated', () => {
    console.log(`✅ WhatsApp client authenticated for firm: ${session.firmId}`);
    session.status = 'authenticated';
  });

  // Auth failure event handler
  session.client.on('auth_failure', (msg) => {
    console.error(`❌ Authentication failed for firm ${session.firmId}:`, msg);
    session.status = 'auth_failed';
    session.qrCode = null;
  });

  // Disconnection event handler with smart reconnection for persistent sessions
  session.client.on('disconnected', (reason) => {
    console.log(`⚠️ WhatsApp client disconnected for firm ${session.firmId}:`, reason);
    session.isReady = false;
    session.status = 'disconnected';
    session.qrCode = null;
    
    // For persistent sessions, always try to reconnect unless manually disconnected
    if (session.isPersistent && session.status !== 'manually_disconnected') {
      const reconnectDelay = Math.min(60000, 10000 * session.reconnectAttempts); // Longer delays for persistent sessions
      console.log(`🔄 Auto-reconnecting persistent session for firm ${session.firmId} in ${reconnectDelay}ms`);
      
      setTimeout(() => {
        if (sessions.has(sessionKey) && session.status !== 'manually_disconnected') {
          console.log(`🔗 Restoring persistent link for firm ${session.firmId}`);
          initializeClient(sessionKey);
        }
      }, reconnectDelay);
    } else if (!session.isPersistent && reason !== 'NAVIGATION' && reason !== 'LOGOUT') {
      // Normal reconnection logic for non-persistent sessions
      const reconnectDelay = Math.min(30000, 5000 * session.reconnectAttempts);
      setTimeout(() => {
        if (sessions.has(sessionKey) && session.status !== 'manually_disconnected') {
          initializeClient(sessionKey);
        }
      }, reconnectDelay);
    }
  });

  session.client.initialize();
};

// Optimized session cleanup - preserve persistent sessions
const cleanupOldSessions = () => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [sessionKey, session] of sessions.entries()) {
    const isOld = (now - session.lastActivity) > SESSION_TIMEOUT;
    const isVeryStale = (now - session.createdAt) > (SESSION_TIMEOUT * 3);
    
    // Never cleanup persistent sessions unless they're very stale AND not ready
    if (session.isPersistent) {
      if (isVeryStale && !session.isReady && session.status === 'disconnected') {
        console.log(`🧹 Cleaning up stale persistent session for firm: ${session.firmId}`);
        if (session.client) {
          try { session.client.destroy(); } catch (e) { console.error('Error destroying client:', e); }
        }
        sessions.delete(sessionKey);
        cleanedCount++;
      }
    } else {
      // Regular cleanup for non-persistent sessions
      if (isOld || isVeryStale) {
        console.log(`🧹 Cleaning up temporary session for firm: ${session.firmId}`);
        if (session.client) {
          try { session.client.destroy(); } catch (e) { console.error('Error destroying client:', e); }
        }
        sessions.delete(sessionKey);
        cleanedCount++;
      }
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} sessions. Active sessions: ${sessions.size}`);
    savePersistedSessions(); // Save after cleanup
  }
};

// Session heartbeat to keep active sessions alive
const sessionHeartbeat = () => {
  for (const [sessionKey, session] of sessions.entries()) {
    if (session.isReady && session.client) {
      // Simple heartbeat - just update last activity
      session.lastActivity = Date.now();
    }
  }
};

// Routes

// Optimized health check with better session info
app.get('/health', (req, res) => {
  const sessionSummary = Array.from(sessions.entries()).map(([sessionKey, session]) => ({
    firm_id: session.firmId,
    status: session.status,
    ready: session.isReady,
    persistent: session.isPersistent,
    last_linked: session.lastLinked,
    queue_length: session.messageQueue.length,
    last_activity: Math.round((Date.now() - session.lastActivity) / 1000) + 's ago',
    reconnect_attempts: session.reconnectAttempts
  }));

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory_usage: process.memoryUsage(),
    active_sessions: sessions.size,
    sessions: sessionSummary
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
    persistent: session.isPersistent,
    last_linked: session.lastLinked,
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
    const sessionKey = `firm_${session.firmId}`;
    initializeClient(sessionKey);
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
  
  const sessionKey = `firm_${session.firmId}`;
  setTimeout(() => { initializeClient(sessionKey); }, 2000);
  
  res.json({
    success: true,
    message: 'Session reset initiated. Get a new QR code in a few seconds.'
  });
});

// Enhanced disconnect endpoint for permanent unlinking
app.post('/api/disconnect/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  console.log(`🔌 Permanently unlinking session: ${sessionId}`);
  
  const session = getSession(sessionId);
  if (!session) {
    return res.json({
      success: false,
      message: 'Session not found'
    });
  }

  // Clear all session data and mark as manually disconnected
  session.qrCode = null;
  session.isReady = false;
  session.status = 'manually_disconnected';
  session.messageQueue = [];
  session.isPersistent = false; // Remove persistence
  session.lastLinked = null;
  
  if (session.client) {
    try { 
      session.client.logout(); // Proper logout to unlink device
      session.client.destroy();
      session.client = null;
    } catch (error) { 
      console.error('Error disconnecting client:', error); 
    }
  }
  
  // Save updated persistent sessions (this session will be excluded)
  savePersistedSessions();
  
  res.json({
    success: true,
    message: 'Session permanently unlinked and device disconnected successfully.'
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

  const sessionKey = `firm_${session.firmId}`;
  processMessageQueue(sessionKey);
  
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

  const sessionKey = `firm_${session.firmId}`;
  processMessageQueue(sessionKey);
  
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

  const sessionKey = `firm_${session.firmId}`;
  processMessageQueue(sessionKey);

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

// Optimized background tasks with better timing and persistence saving
setInterval(() => {
  // Process message queues for active sessions (every 45 seconds)
  for (const [sessionKey, session] of sessions.entries()) {
    if (session.messageQueue.length > 0 && session.isReady && !session.isProcessingQueue) {
      console.log(`⏰ Processing queue for firm ${session.firmId} (${session.messageQueue.length} messages)`);
      processMessageQueue(sessionKey);
    }
  }
}, 45000);

// Session heartbeat (every minute)
setInterval(sessionHeartbeat, HEARTBEAT_INTERVAL);

// Cleanup old sessions (every 10 minutes)
setInterval(cleanupOldSessions, 10 * 60 * 1000);

// Save persistent sessions periodically (every 5 minutes)
setInterval(savePersistedSessions, 5 * 60 * 1000);

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

// Start optimized server with persistent session support
app.listen(PORT, async () => {
  console.log(`🚀 Ultra-Lightweight WhatsApp Service with Persistent Sessions running on port ${PORT}`);
  console.log(`📱 Health check: http://localhost:${PORT}/health`);
  console.log(`🏢 Firm-based session isolation enabled`);
  console.log(`🔗 Permanent session linking enabled`);
  console.log(`⚡ Optimized for minimal resource usage and better performance`);
  
  // Load persistent sessions on startup
  await loadPersistedSessions();
  
  // Start cleanup after startup
  setTimeout(cleanupOldSessions, 30000);
});
