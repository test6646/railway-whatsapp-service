
# WhatsApp Bulk Messaging Service

A Node.js service built with whatsapp-web.js for sending bulk WhatsApp messages. Deploy this to Railway and integrate with your Supabase application.

## Features

- 📱 WhatsApp Web integration using whatsapp-web.js
- 🔄 QR code authentication
- 📨 Bulk message sending
- ⏳ Message queue system with rate limiting
- 🎯 Event and task-specific notifications
- 📊 Status monitoring and health checks
- 🔒 CORS and security middleware
- 🚫 Rate limiting protection

## API Endpoints

### Health & Status
- `GET /health` - Service health check
- `GET /api/status` - WhatsApp connection status
- `GET /api/qr` - Get QR code for authentication

### Messaging
- `POST /api/send-bulk-messages` - Send bulk messages
- `POST /api/send-event-messages` - Send event notifications
- `POST /api/send-task-messages` - Send task notifications

### Queue Management
- `GET /api/queue` - Get queue status
- `POST /api/clear-queue` - Clear message queue

## Deployment to Railway

1. Create a new project on Railway
2. Connect your GitHub repository or upload these files
3. Railway will automatically detect the Node.js project
4. Set environment variables if needed
5. Deploy and get your service URL

## Authentication Process

1. Deploy the service to Railway
2. Access `/api/qr` endpoint to get QR code
3. Scan QR code with WhatsApp on your phone
4. Service will authenticate and be ready for messaging

## Environment Variables

- `PORT` - Server port (Railway sets this automatically)

## Usage Examples

### Send Bulk Messages

```bash
POST /api/send-bulk-messages
Content-Type: application/json

{
  "messages": [
    {
      "number": "919876543210",
      "message": "Hello from bulk service!"
    },
    {
      "number": "919876543211", 
      "message": "Another message"
    }
  ]
}
```

### Send Event Notifications

```bash
POST /api/send-event-messages
Content-Type: application/json

{
  "event": {
    "id": "event-id",
    "title": "Wedding Shoot",
    "event_type": "Wedding",
    "event_date": "2024-01-15",
    "venue": "Grand Hotel",
    "client_name": "John & Jane",
    "total_days": 2,
    "description": "Pre-wedding and wedding photography"
  },
  "staff_list": [
    {
      "id": "staff-1",
      "full_name": "John Photographer",
      "mobile_number": "919876543210",
      "role": "Photographer"
    }
  ]
}
```

### Send Task Notifications

```bash
POST /api/send-task-messages
Content-Type: application/json

{
  "task": {
    "id": "task-id",
    "title": "Photo Editing",
    "task_type": "Photo Editing",
    "priority": "High",
    "due_date": "2024-01-20",
    "event_title": "Wedding Shoot",
    "amount": 5000,
    "description": "Edit 200 wedding photos"
  },
  "staff_list": [
    {
      "id": "staff-2",
      "full_name": "Jane Editor",
      "mobile_number": "919876543211",
      "role": "Editor"
    }
  ]
}
```

## Message Queue System

- Messages are automatically queued to prevent spam
- 2-second delay between messages
- Automatic retry mechanism
- Queue processing every 30 seconds
- Status tracking for each message

## Security Features

- Rate limiting (100 requests per 15 minutes)
- CORS protection
- Helmet security headers
- Input validation
- Error handling

## Monitoring

- Health check endpoint for uptime monitoring
- Queue status monitoring
- Connection status tracking
- Message delivery status

## Notes

- WhatsApp session persists across restarts
- Automatic reconnection on disconnection
- Supports international phone number formats
- Message formatting optimized for business use
