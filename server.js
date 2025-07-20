
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Global variables
let client;
let qrCodeData = null;
let isClientReady = false;
let connectionStatus = 'initializing';
let messageQueue = [];
let isProcessingQueue = false;

// Message queue processing
const processMessageQueue = async () => {
  if (isProcessingQueue || messageQueue.length === 0 || !isClientReady) {
    return;
  }

  isProcessingQueue = true;
  console.log(`Processing ${messageQueue.length} messages in queue`);

  while (messageQueue.length > 0 && isClientReady) {
    const messageData = messageQueue.shift();
    try {
      const formattedNumber = formatPhoneNumber(messageData.number);
      const chatId = formattedNumber + '@c.us';
      
      await client.sendMessage(chatId, messageData.message);
      console.log(`✅ Message sent to ${formattedNumber}`);
      
      // Update status if callback provided
      if (messageData.statusCallback) {
        messageData.statusCallback('sent');
      }
      
      // Delay between messages to avoid spam detection
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error(`❌ Failed to send message to ${messageData.number}:`, error.message);
      
      // Update status if callback provided
      if (messageData.statusCallback) {
        messageData.statusCallback('failed', error.message);
      }
    }
  }

  isProcessingQueue = false;
  console.log('✅ Queue processing completed');
};

// Format phone number to international format
const formatPhoneNumber = (phone) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) return digits;
  if (digits.length === 10) return '91' + digits;
  if (digits.length >= 10) return '91' + digits.slice(-10);
  return digits;
};

// Initialize WhatsApp client
const initializeClient = () => {
  console.log('🚀 Initializing WhatsApp client...');
  
  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: './whatsapp-session'
    }),
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

  client.on('qr', (qr) => {
    console.log('📱 QR Code received, generating image...');
    connectionStatus = 'qr_ready';
    QRCode.toDataURL(qr, { 
      errorCorrectionLevel: 'M',
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 256
    }, (err, url) => {
      if (!err) {
        qrCodeData = url;
        console.log('✅ QR Code generated successfully');
      } else {
        console.error('❌ QR Code generation failed:', err);
      }
    });
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
    isClientReady = true;
    connectionStatus = 'ready';
    qrCodeData = null;
  });

  client.on('authenticated', () => {
    console.log('✅ WhatsApp client authenticated');
    connectionStatus = 'authenticated';
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    connectionStatus = 'auth_failed';
  });

  client.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp client disconnected:', reason);
    isClientReady = false;
    connectionStatus = 'disconnected';
    
    // Try to reconnect after 5 seconds
    setTimeout(() => {
      console.log('🔄 Attempting to reconnect...');
      initializeClient();
    }, 5000);
  });

  client.initialize();
};

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    whatsapp_status: connectionStatus,
    client_ready: isClientReady,
    queue_length: messageQueue.length
  });
});

// Get connection status
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    ready: isClientReady,
    qr_available: !!qrCodeData,
    queue_length: messageQueue.length,
    timestamp: new Date().toISOString()
  });
});

// Get QR code for authentication
app.get('/api/qr', (req, res) => {
  if (qrCodeData) {
    res.json({
      success: true,
      qr_code: qrCodeData,
      message: 'Scan this QR code with WhatsApp'
    });
  } else {
    res.json({
      success: false,
      message: 'QR code not available. Status: ' + connectionStatus
    });
  }
});

// Reset WhatsApp session
app.post('/api/reset', (req, res) => {
  console.log('🔄 Resetting WhatsApp session...');
  
  // Clear current state
  qrCodeData = null;
  isClientReady = false;
  connectionStatus = 'resetting';
  
  // Destroy client if exists
  if (client) {
    try {
      client.destroy();
    } catch (error) {
      console.error('Error destroying client:', error);
    }
  }
  
  // Reinitialize after a short delay
  setTimeout(() => {
    initializeClient();
  }, 2000);
  
  res.json({
    success: true,
    message: 'WhatsApp session reset initiated. Get a new QR code in a few seconds.'
  });
});

// Send bulk messages
app.post('/api/send-bulk-messages', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Messages array is required and cannot be empty'
    });
  }

  if (!isClientReady) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp client is not ready. Current status: ' + connectionStatus
    });
  }

  const results = [];
  
  // Add messages to queue
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
    messageQueue.push({
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

  // Start processing queue
  processMessageQueue();

  res.json({
    success: true,
    message: `${results.filter(r => r.success).length} messages queued successfully`,
    results,
    queue_length: messageQueue.length
  });
});

// Send event notifications
app.post('/api/send-event-messages', async (req, res) => {
  const { event, staff_list, staff_assignments } = req.body;

  if (!event || !Array.isArray(staff_list) || staff_list.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Event data and staff list are required'
    });
  }

  if (!isClientReady) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp client is not ready. Current status: ' + connectionStatus
    });
  }

  // Group staff assignments by staff and day, then sort by day number
  const staffDayAssignments = {};
  
  if (staff_assignments && Array.isArray(staff_assignments)) {
    staff_assignments.forEach(assignment => {
      if (!staffDayAssignments[assignment.staff_id]) {
        staffDayAssignments[assignment.staff_id] = [];
      }
      staffDayAssignments[assignment.staff_id].push({
        day_number: assignment.day_number,
        day_date: assignment.day_date,
        role: assignment.role
      });
    });
    
    // Sort assignments for each staff by day number
    Object.keys(staffDayAssignments).forEach(staffId => {
      staffDayAssignments[staffId].sort((a, b) => a.day_number - b.day_number);
    });
  }

  // Generate messages for each staff member and each day (for multi-day events)
  const messages = [];
  
  staff_list.forEach(staff => {
    const assignments = staffDayAssignments[staff.id] || [];
    
    if (assignments.length > 0) {
      // For multi-day events, send one message per day (ordered by day)
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
      // Fallback for single events or when no assignments data
      const message = formatEventMessage(event, staff, null);
      messages.push({
        number: staff.mobile_number,
        message: message,
        staff_id: staff.id,
        day_number: 1
      });
    }
  });

  // Sort messages by day number to ensure earliest days are sent first
  messages.sort((a, b) => a.day_number - b.day_number);

  // Use existing bulk message endpoint logic
  const results = [];
  
  messages.forEach((msg, index) => {
    const messageId = uuidv4();
    messageQueue.push({
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

  processMessageQueue();

  res.json({
    success: true,
    message: `Event notifications queued for ${staff_list.length} staff members`,
    event_title: event.title,
    results,
    queue_length: messageQueue.length
  });
});

// Send task notifications
app.post('/api/send-task-messages', async (req, res) => {
  const { task, staff_list } = req.body;

  if (!task || !Array.isArray(staff_list) || staff_list.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Task data and staff list are required'
    });
  }

  if (!isClientReady) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp client is not ready. Current status: ' + connectionStatus
    });
  }

  const messages = staff_list.map(staff => {
    const message = formatTaskMessage(task, staff);
    return {
      number: staff.mobile_number,
      message: message
    };
  });

  const results = [];
  
  messages.forEach((msg, index) => {
    const messageId = uuidv4();
    messageQueue.push({
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

  processMessageQueue();

  res.json({
    success: true,
    message: `Task notifications queued for ${staff_list.length} staff members`,
    task_title: task.title,
    results,
    queue_length: messageQueue.length
  });
});

// Clear message queue
app.post('/api/clear-queue', (req, res) => {
  const queueLength = messageQueue.length;
  messageQueue = [];
  
  res.json({
    success: true,
    message: `Cleared ${queueLength} messages from queue`
  });
});

// Get queue status
app.get('/api/queue', (req, res) => {
  res.json({
    success: true,
    queue_length: messageQueue.length,
    is_processing: isProcessingQueue,
    messages: messageQueue.slice(0, 10) // Show first 10 messages
  });
});

// Message formatting functions
const formatEventMessage = (event, staff, assignment) => {
  const formatDate = (dateString) => {
    if (!dateString || dateString === 'undefined' || dateString === 'null') {
      return 'Date not specified';
    }
    
    try {
      let date;
      
      // If it's in YYYY-MM-DD format, add time to avoid timezone issues
      if (typeof dateString === 'string' && dateString.match(/^\d{4}-\d{2}-\d{2}$/)) {
        date = new Date(dateString + 'T00:00:00');
      } else {
        date = new Date(dateString);
      }
      
      if (isNaN(date.getTime())) {
        console.warn('Invalid date string:', dateString);
        return 'Invalid date';
      }
      
      return date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch (error) {
      console.error('Error formatting date:', dateString, error);
      return 'Date formatting error';
    }
  };

  const getOrdinalNumber = (num) => {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const v = num % 100;
    return num + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
  };

  let message = `**EVENT ASSIGNMENT**\n\n`;
  message += `Hello ${staff.full_name},\n\n`;

  // Enhanced role assignment
  if (assignment) {
    const dayText = getOrdinalNumber(assignment.day_number);
    message += `You are assigned as ${assignment.role.toUpperCase()} on DAY ${dayText} for:\n\n`;
    message += `Title: ${event.title || 'Not specified'}\n`;
    message += `Type: ${event.eventType || event.event_type || 'Not specified'}\n`;
    message += `Date: ${formatDate(assignment.day_date)}\n`;
  } else {
    message += `You are assigned as ${(event.role || staff.role || 'STAFF').toUpperCase()} for:\n\n`;
    message += `Title: ${event.title || 'Not specified'}\n`;
    message += `Type: ${event.eventType || event.event_type || 'Not specified'}\n`;
    
    // Format date range for multi-day events
    if ((event.totalDays || event.total_days) && (event.totalDays > 1 || event.total_days > 1)) {
      const startDate = new Date((event.eventDate || event.event_date) + 'T00:00:00');
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + (event.totalDays || event.total_days) - 1);
      
      const startFormatted = startDate.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
      const endFormatted = endDate.toLocaleDateString('en-IN', {
        day: 'numeric', 
        month: 'long',
        year: 'numeric'
      });
      
      message += `Date: ${startFormatted} - ${endFormatted}\n`;
    } else {
      message += `Date: ${formatDate(event.eventDate || event.event_date)}\n`;
    }
  }

  if (event.clientName || event.client_name) {
    message += `Client: ${event.clientName || event.client_name}\n`;
  }

  if (event.venue && event.venue.trim() !== '') {
    message += `Venue: ${event.venue}\n`;
  }

  message += `Contact: ${staff.mobile_number}\n`;

  if (event.description && event.description.trim() !== '') {
    message += `\n${event.description}\n`;
  }

  message += `\nThank you for being part of **Prit Photo**`;

  return message;
};

const formatTaskMessage = (task, staff) => {
  const formatDate = (dateString) => {
    if (!dateString || dateString === 'undefined' || dateString === 'null') {
      return 'Date not specified';
    }
    
    try {
      let date;
      
      // If it's in YYYY-MM-DD format, add time to avoid timezone issues
      if (typeof dateString === 'string' && dateString.match(/^\d{4}-\d{2}-\d{2}$/)) {
        date = new Date(dateString + 'T00:00:00');
      } else {
        date = new Date(dateString);
      }
      
      if (isNaN(date.getTime())) {
        console.warn('Invalid date string:', dateString);
        return 'Invalid date';
      }
      
      return date.toLocaleDateString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch (error) {
      console.error('Error formatting date:', dateString, error);
      return 'Date formatting error';
    }
  };

  let message = `**TASK ASSIGNMENT**\n\n`;
  message += `Hello **${staff.full_name}**,\n\n`;
  message += `You have been assigned a new task:\n\n`;
  message += `**TITLE:** ${task.title || 'Not specified'}\n`;
  message += `**TYPE:** ${task.taskType || task.task_type || 'General'}\n`;
  message += `**PRIORITY:** ${task.priority || 'Medium'}\n`;

  if (task.dueDate || task.due_date) {
    message += `**DUE:** ${formatDate(task.dueDate || task.due_date)}\n`;
  }

  if (task.eventTitle || task.event_title) {
    message += `**EVENT:** ${task.eventTitle || task.event_title}\n`;
  }

  if (task.amount && task.amount > 0) {
    message += `**AMOUNT:** ₹${task.amount.toLocaleString()}\n`;
  }

  if (task.description && task.description.trim() !== '') {
    message += `\n**DETAILS:**\n_${task.description}_\n`;
  }

  message += `\nThank you for your professionalism.`;

  return message;
};

// Process queue every 30 seconds
cron.schedule('*/30 * * * * *', () => {
  if (messageQueue.length > 0 && isClientReady && !isProcessingQueue) {
    console.log('⏰ Cron: Processing message queue...');
    processMessageQueue();
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
  
  // Initialize WhatsApp client
  initializeClient();
});
