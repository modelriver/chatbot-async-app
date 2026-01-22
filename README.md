# Chatbot Async App

A full-stack chatbot application using React (frontend) and Node.js/Express (backend), integrated with ModelRiver for AI responses.

## Features

- 💬 Real-time chat interface with modern dark theme
- 🚀 Async AI processing via ModelRiver
- 🔌 WebSocket-based response delivery using `@modelriver/client` SDK
- 📥 Webhook endpoint for ModelRiver callbacks
- 🔐 Webhook signature verification (HMAC-SHA256)
- 📋 Structured output support for workflows with custom schemas
- 🆔 Custom ID generation for conversations and messages
- 🔄 Event-based callbacks with ID injection
- 💾 In-memory message storage (simulates database)

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   React     │────▶│   Backend   │────▶│ ModelRiver  │
│  Frontend   │     │  (Express)  │     │    API      │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       │  POST /chat        │  POST /v1/ai/async │
       │                   │                   │
       │                   │                   ▼
       │                   │          ┌─────────────────┐
       │                   │          │  AI Processing  │
       │                   │          │   (Background)   │
       │                   │          └─────────────────┘
       │                   │                   │
       │                   │                   │
       │                   │                   ▼
       │                   │          ┌─────────────────┐
       │                   │          │  Webhook Event   │
       │                   │          │  POST /webhook/ │
       │                   │          │  modelriver     │
       │                   │          └─────────────────┘
       │                   │                   │
       │                   │                   │
       │                   ▼                   │
       │          ┌─────────────────┐          │
       │          │  Backend        │◀─────────┘
       │          │  Processes      │
       │          │  & Injects IDs  │
       │          └─────────────────┘
       │                   │
       │                   │
       │                   ▼
       │          ┌─────────────────┐
       │          │  Callback URL   │
       │          │  POST /v1/     │
       │          │  callback/      │
       │          │  {channel_id}   │
       │          └─────────────────┘
       │                   │
       │                   │
       │                   ▼
       │          ┌─────────────────┐
       │          │  ModelRiver API │
       │          │  Receives       │
       │          │  Callback Data  │
       │          │  with IDs       │
       │          └─────────────────┘
       │                   │
       │                   │
       │                   ▼
       │          ┌─────────────────┐
       │          │  ModelRiver     │
       │          │  Updates        │
       │          │  WebSocket      │
       │          │  Channel with   │
       │          │  Final Response │
       │          └─────────────────┘
       │                   │
       │                   │
       └───────────────────┘
              (WebSocket)
              Final Response
```

## Current Data Flow

### Standard Flow (Without Events)

1. **User** types message in React app
2. **React** sends `POST /chat` to backend with message (and optional `events`, `workflow`, `conversationId`)
3. **Backend** generates custom conversation ID and message ID (UUIDs)
4. **Backend** builds payload:
   - Sets `delivery_method: 'websocket'`
   - Sets `webhook_url` to backend's `/webhook/modelriver` endpoint
   - Includes `events: ['webhook_received']` (or custom events)
   - Includes `metadata` with custom IDs
   - **Note:** Structured output is configured in the workflow in ModelRiver, not sent in the request
5. **Backend** sends `POST /v1/ai/async` to ModelRiver API
6. **ModelRiver** returns WebSocket connection details (`channel_id`, `ws_token`, `websocket_url`, `websocket_channel`)
7. **Backend** stores pending request with custom IDs in memory
8. **Backend** returns WebSocket details to React
9. **React** uses `@modelriver/client` SDK to connect to ModelRiver WebSocket
10. **ModelRiver** processes AI request in background
11. **ModelRiver** sends webhook `POST /webhook/modelriver` to backend with AI response
12. **Backend** receives webhook:
    - Extracts AI response (handles structured/unstructured)
    - Retrieves custom IDs from pending request
    - Creates enriched record with custom IDs
    - If `callback_url` present in webhook payload:
      - Injects custom IDs into response data
      - Sends enriched data back to ModelRiver callback URL
13. **ModelRiver** sends final response via WebSocket to frontend
14. **React** receives response via `@modelriver/client` hook
15. **React** displays AI response:
    - Structured output: Formatted JSON
    - Unstructured output: Markdown-rendered text

### Event-Driven Flow (With Events)

When `events: ['webhook_received']` is included:

1. Steps 1-10 same as above
2. **ModelRiver** sends event-driven webhook with format:
   ```json
   {
     "type": "task.ai_generated",
     "event": "webhook_received",
     "channel_id": "...",
     "ai_response": { "data": {...} },
     "callback_url": "https://api.modelriver.com/v1/callback/{channel_id}",
     "callback_required": true
   }
   ```
3. **Backend** processes webhook and injects custom IDs
4. **Backend** sends enriched data to `callback_url` from webhook payload
5. **ModelRiver** receives callback and sends response via WebSocket
6. **React** displays response

## Quick Start

### Prerequisites

- Node.js 16+
- ModelRiver API Key

### 1. Install Backend Dependencies

```bash
cd backend
npm install
```

### 2. Install Frontend Dependencies

```bash
cd frontend
npm install
```

### 3. Set Environment Variables

Create a `.env` file in the `backend` directory:

```bash
cd backend
cp .env.example .env
# Edit .env and add your ModelRiver API key
```

Required variables:
- `MODELRIVER_API_KEY` - Your ModelRiver API key (required)

Optional variables:
- `PORT` - Backend server port (default: 4000)
- `MODELRIVER_API_URL` - ModelRiver API URL (default: https://api.modelriver.com)
- `BACKEND_PUBLIC_URL` - Public URL for webhook callbacks (default: http://localhost:4000)

For the frontend, create a `.env` file in the `frontend` directory:

```bash
cd frontend
cp .env.example .env
# Edit .env if needed (defaults work for local development)
```

Frontend variables (all optional):
- `VITE_API_URL` - Backend API URL (default: http://localhost:4000)

### 4. Start Backend Server

```bash
cd backend
npm start
```

Backend will run on `http://localhost:4000`

### 5. Start Frontend Dev Server

```bash
cd frontend
npm run dev
```

Frontend will run on `http://localhost:3006`

### 6. Open Browser

Navigate to `http://localhost:3006` and start chatting!

## API Endpoints

### Backend

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/chat` | POST | Send a chat message, returns WebSocket details |
| `/webhook/modelriver` | POST | Receives webhooks from ModelRiver |
| `/conversations/:id` | GET | Get conversation history |
| `/health` | GET | Health check |

### Request Example

```bash
curl -X POST http://localhost:4000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, how are you?"}'
```

### Advanced Request Options

The `/chat` endpoint supports additional parameters:

```bash
curl -X POST http://localhost:4000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello",
    "workflow": "custom-workflow-name",
    "conversationId": "optional-existing-conversation-id",
    "events": ["webhook_received"]
  }'
```

**Parameters:**
- `message` (required): The user's message
- `workflow` (optional): Workflow name (default: `mr_chatbot_workflow`)
- `conversationId` (optional): Existing conversation ID (generates new one if not provided)
- `events` (optional): Array of events to enable callback functionality (default: `["webhook_received"]`)

**Note:** Structured output is configured in the workflow settings in ModelRiver Console, not sent as a parameter in the request. If your workflow has structured output configured, the response will automatically be in structured format.

### Structured Output

If your workflow has structured output configured, you can request structured responses:

```bash
curl -X POST http://localhost:4000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze this text",
    "structured_output": true
  }'
```

The response will be in the structured format defined by your workflow schema, and will be displayed as formatted JSON in the chat interface.

## Configuring Structured Output in ModelRiver

To use structured output, you need to create a **Structured Output Schema** in your ModelRiver project and associate it with your workflow.

### Step 1: Create Structured Output Schema

1. Go to your ModelRiver Console (https://console.modelriver.com)
2. Navigate to **Structured Outputs** section
3. Click **Create Structure**
4. Fill in:
   - **Name**: Lowercase with underscores (e.g., `chatbot_response`, `analysis_result`)
   - **Description**: Optional description of what this structure represents
   - **JSON Schema**: Valid JSON Schema object (see example below)

### Step 2: Example JSON Schema

Here's an example schema for a chatbot that extracts structured information:

```json
{
  "reply": "The AI's direct response or answer to the user's question",
  "summary": "A brief summary of the conversation or response",
  "sentiment": "The sentiment of the user's message (e.g., positive, negative, neutral, mixed)",
  "topics": ["List of topics discussed in the conversation"],
  "action_items": [
    {
      "task": "The action item description",
      "priority": "Priority level (high, medium, low)"
    }
  ],
  "confidence": "Confidence score between 0 and 1"
}
```

### Step 3: Associate Schema with Workflow

1. Go to **Workflows** in your ModelRiver Console
2. Edit your workflow (or create a new one, e.g., `mr_chatbot_workflow`)
3. In the workflow settings, select your **Structured Output** schema from the dropdown
4. Save the workflow

### Step 4: Use in Chatbot

Once configured, simply use the workflow - structured output will be automatically applied:

```bash
curl -X POST http://localhost:4000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "I need help with my project. It's urgent!",
    "workflow": "mr_chatbot_workflow"
  }'
```

**Note:** No need to send `structured_output: true` in the request. If your workflow has structured output configured, the response will automatically be in structured format.

**Response format:**
```json
{
  "reply": "I'd be happy to help you with your project! To provide the best assistance, could you please share more details about what specific aspect you need help with?",
  "summary": "User needs urgent help with their project",
  "sentiment": "neutral",
  "topics": ["project", "help", "urgent"],
  "action_items": [
    {
      "task": "Provide help with project",
      "priority": "high"
    }
  ],
  "confidence": 0.95
}
```

The frontend will automatically detect structured output and display it in a user-friendly format with:
- **Reply**: The AI's main response to the user's question (displayed prominently)
- **Sentiment**: Visual indicator with emoji (😊 positive, 😐 neutral, 😟 negative, 🤔 mixed)
- **Confidence**: Color-coded progress bar
- **Summary**: Detailed summary of the analysis
- **Topics**: Interactive tag pills
- **Action Items**: Prioritized list with color-coded indicators

## Environment Variables

Environment variables are loaded from `.env` files. Copy `.env.example` to `.env` in each directory and configure as needed.

### Backend

Create `backend/.env` file with the following variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend server port | `4000` |
| `MODELRIVER_API_KEY` | Your ModelRiver API key | Required |
| `MODELRIVER_API_URL` | ModelRiver API URL | `https://api.modelriver.com` |
| `BACKEND_PUBLIC_URL` | Public URL for webhook callbacks | `http://localhost:4000` |
| `WEBHOOK_SECRET` | Secret for webhook signature verification | Optional (see below) |

### Frontend

Create `frontend/.env` file with the following variables (all optional):

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_API_URL` | Backend API URL | `http://localhost:4000` |

**Note**: Vite requires the `VITE_` prefix for environment variables to be exposed to the frontend code.

## Project Structure

```
/Chatbot-async-app
├── /backend
│   ├── server.js        # Express server with /chat and /webhook endpoints
│   └── package.json
├── /frontend
│   ├── /src
│   │   ├── App.jsx                # Main chat component (uses @modelriver/client)
│   │   ├── App.css                # Chat UI styles
│   │   ├── StructuredResponse.jsx # Component for displaying structured AI responses
│   │   ├── StructuredResponse.css # Styles for structured response display
│   │   ├── index.css              # Global styles
│   │   └── main.jsx               # React entry point
│   ├── index.html
│   ├── vite.config.js
│   └── package.json     # Includes @modelriver/client dependency
└── README.md
```

## Webhook Signature Verification

The backend verifies webhook authenticity using HMAC-SHA256 signature verification to ensure webhooks are from ModelRiver and haven't been tampered with.

### How It Works

1. **ModelRiver** sends webhooks with two security headers:
   - `X-ModelRiver-Signature`: HMAC-SHA256 signature (lowercase hex)
   - `X-ModelRiver-Timestamp`: Unix timestamp when the webhook was sent

2. **Backend** verifies the signature by:
   - Constructing payload: `${timestamp}.${raw_body}`
   - Computing expected signature: `HMAC-SHA256(webhook_secret, payload)`
   - Comparing signatures using constant-time comparison (prevents timing attacks)

### Configuration

1. Create a webhook in ModelRiver Console and copy the webhook secret (shown once)
2. Add the secret to your `.env` file:
   ```
   WEBHOOK_SECRET=your_webhook_secret_here
   ```

### Behavior

| Scenario | Response |
|----------|----------|
| Valid signature | 200 OK - webhook processed |
| Invalid signature | 401 Unauthorized |
| Missing signature header | 401 Unauthorized |
| Missing timestamp header | 401 Unauthorized |
| `WEBHOOK_SECRET` not set (development) | Warning logged, request allowed |
| `WEBHOOK_SECRET` not set (production) | 500 error |

## Webhook Flow (Detailed)

When ModelRiver completes an AI request, it sends a webhook to `/webhook/modelriver`:

### Standard Webhook Format

```json
{
  "channel_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "success",
  "data": {
    "choices": [
      {
        "message": {
          "content": "AI response text"
        }
      }
    ]
  },
  "meta": {
    "workflow": "mr_chatbot_workflow",
    "used_model": "gpt-4o",
    "usage": { /* token usage */ }
  },
  "callback_url": "https://api.modelriver.com/v1/callback/{channel_id}"
}
```

### Event-Driven Webhook Format

When `events` are included in the request:

```json
{
  "type": "task.ai_generated",
  "event": "webhook_received",
  "channel_id": "550e8400-e29b-41d4-a716-446655440000",
  "ai_response": {
    "data": {
      /* Structured or unstructured response */
    }
  },
  "callback_url": "https://api.modelriver.com/v1/callback/{channel_id}",
  "callback_required": true,
  "meta": { /* metadata */ },
  "customer_data": { /* cached customer data */ }
}
```

### Backend Processing

1. **Backend** receives webhook at `/webhook/modelriver`
2. **Backend** extracts:
   - `channel_id` to look up pending request
   - AI response from `data` (standard) or `ai_response.data` (event-driven)
   - `callback_url` from payload (not header)
3. **Backend** retrieves custom IDs from `pendingRequests` map:
   - `conversationId`: Custom conversation UUID
   - `messageId`: Custom message UUID
4. **Backend** creates enriched record:
   ```json
   {
     "id": "custom-message-uuid",
     "prompt": "user input",
     "response": "AI output (structured or unstructured)",
     "created_at": "2026-01-10T12:34:56.789Z",
     "channel_id": "550e8400-e29b-41d4-a716-446655440000",
     "conversation_id": "custom-conversation-uuid",
     "usage": { /* token usage */ }
   }
   ```
5. **Backend** stores record in memory (simulates database)
6. **If `callback_url` is present**:
   - Backend injects custom IDs into response data
   - Backend sends enriched data to `callback_url`:
     ```json
     {
       "id": "custom-message-uuid",
       "conversation_id": "custom-conversation-uuid",
       /* ... rest of AI response data ... */
     }
     ```
   - ModelRiver receives callback and sends final response via WebSocket

## Custom ID Generation

The backend generates custom IDs for conversations and messages **before** sending the request to ModelRiver. This ensures:

- **Consistent IDs**: The same ID is used throughout the request lifecycle
- **ID Injection**: Custom IDs are injected into the callback data sent back to ModelRiver
- **Tracking**: You can track messages by their custom IDs from the moment they're created

## Events and Callbacks

When `events` parameter is included in the request (default: `["webhook_received"]`):

1. **ModelRiver** processes the AI request and generates response
2. **ModelRiver** sends event-driven webhook to `/webhook/modelriver` with format:
   ```json
   {
     "type": "task.ai_generated",
     "event": "webhook_received",
     "channel_id": "550e8400-e29b-41d4-a716-446655440000",
     "ai_response": {
       "data": { /* AI response data */ }
     },
     "callback_url": "https://api.modelriver.com/v1/callback/{channel_id}",
     "callback_required": true,
     "meta": { /* metadata */ },
     "customer_data": { /* cached customer data */ }
   }
   ```
3. **Backend** receives webhook:
   - Extracts AI response from `ai_response.data`
   - Retrieves custom IDs (conversation_id, message_id) from pending request
   - Creates enriched record with custom IDs
4. **Backend** sends enriched data to `callback_url` from webhook payload:
   ```json
   {
     "id": "custom-message-uuid",
     "conversation_id": "custom-conversation-uuid",
     /* ... rest of AI response data with injected IDs ... */
   }
   ```
5. **ModelRiver** receives callback and sends final response via WebSocket to frontend
6. **Frontend** displays the response

This enables event-driven workflows where you can:
- Track messages by their custom IDs throughout the lifecycle
- Process and enrich responses before they reach the frontend
- Implement approval gates or validation steps
- Store responses in your database with consistent IDs

## License

MIT
