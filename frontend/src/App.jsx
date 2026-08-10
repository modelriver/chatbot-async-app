/**
 * Chatbot Async App - Main React Component
 * 
 * This component provides a chat interface that:
 * 1. Sends messages to the backend (/chat endpoint)
 * 2. Receives WebSocket connection details
 * 3. Connects to the ModelRiver Phoenix channel for the final AI response
 * 
 * Data Flow:
 * User Message → Backend → ModelRiver → WebSocket → This Component
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Socket } from 'phoenix'
import './App.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import StructuredResponse from './StructuredResponse'
import {
    Send,
    Bot,
    User,
    AlertCircle,
    Loader2,
    Clock,
    Database,
    Hash,
    MessageSquarePlus
} from 'lucide-react'

SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('shell', bash)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('html', markup)
SyntaxHighlighter.registerLanguage('css', css)


// Backend API URL
const BACKEND_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

// ModelRiver's local Phoenix endpoint listens on IPv4 by default. Browsers on
// macOS may resolve `localhost` to IPv6 first, which prevents the WebSocket
// from connecting even though the HTTP request succeeded. Keep external URLs
// unchanged and only normalize local socket URLs.
function resolveWebSocketUrl(url) {
    if (typeof url !== 'string') return url

    return url.replace(/^ws:\/\/localhost(?=[:/]|$)/, 'ws://127.0.0.1')
}

function App() {
    // ============================================
    // State
    // ============================================

    const [messages, setMessages] = useState([])
    const [inputValue, setInputValue] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState(null)
    const [devMode, setDevMode] = useState(false)
    const [sessionId, setSessionId] = useState(null)
    const [response, setResponse] = useState(null)
    const [modelRiverError, setModelRiverError] = useState(null)
    const [connectionState, setConnectionState] = useState('disconnected')
    const [steps, setSteps] = useState([])

    // Refs
    const messagesEndRef = useRef(null)
    const isConnectingRef = useRef(false) // Guard to prevent multiple simultaneous connection attempts
    const processedChannelsRef = useRef(new Set()) // Track processed channel IDs to prevent duplicate messages
    const socketRef = useRef(null)

    // ============================================
    // ModelRiver WebSocket client
    // ============================================

    const isConnected = connectionState === 'connected'
    const isConnecting = connectionState === 'connecting'

    const disconnect = useCallback(() => {
        const connection = socketRef.current
        socketRef.current = null

        if (connection) {
            connection.channel.leave()
            connection.socket.disconnect()
        }

        setConnectionState('disconnected')
    }, [])

    const reset = useCallback(() => {
        disconnect()
        setResponse(null)
        setModelRiverError(null)
        setSteps([])
    }, [disconnect])

    const connect = useCallback(({ wsToken, websocketUrl, websocketChannel }) => {
        disconnect()
        setResponse(null)
        setModelRiverError(null)
        setConnectionState('connecting')
        setSteps([
            { id: 'queue', name: 'Connecting to ModelRiver', status: 'pending' },
            { id: 'process', name: 'Processing AI request', status: 'pending' },
            { id: 'backend', name: 'Waiting for backend callback', status: 'pending' }
        ])

        const socket = new Socket(websocketUrl, {
            params: { token: wsToken },
            // A WebSocket token is single-use. Never reconnect with it.
            reconnectAfterMs: () => 60_000
        })
        const channel = socket.channel(websocketChannel)
        socketRef.current = { socket, channel }

        socket.onOpen(() => {
            setConnectionState('connected')
            channel.join()
                .receive('ok', () => {
                    setSteps(previous => previous.map(step =>
                        step.id === 'queue' ? { ...step, status: 'success' } : step
                    ))
                })
                .receive('error', () => {
                    setModelRiverError('Failed to join the ModelRiver response channel')
                    disconnect()
                })
        })

        socket.onError(() => {
            if (socketRef.current?.socket === socket) {
                setModelRiverError('WebSocket connection error')
                disconnect()
            }
        })

        channel.on('response', (payload) => {
            const status = payload.meta?.status || payload.status

            setResponse(payload)
            if (status === 'ai_generated') {
                setSteps(previous => previous.map(step =>
                    step.id === 'process' ? { ...step, status: 'success' } : step
                ))
            }

            if (status === 'completed' || status === 'success') {
                // Close deliberately after receiving the final payload so the
                // Phoenix client cannot retry with the consumed one-time token.
                disconnect()
            }
        })

        socket.connect()
    }, [disconnect])

    // ============================================
    // Auto-scroll to bottom when new messages arrive
    // ============================================

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages])

    // Handle ModelRiver response
    useEffect(() => {
        if (response) {
            // Extract metadata and status
            const meta = {
                ...(response.callback_metadata || {}),
                ...(response.metadata || {}),
                ...(response.meta || {})
            };
            const status = meta.status || response.status || 'pending';
            const isStructured = meta.structured_output === true;

            console.log('📥 WebSocket response received:', { status, hasData: !!response.data, isStructured, time: new Date().toISOString() });

            // Check if data might be in meta.data or meta.ai_response
            if (response.meta?.data) {
                console.log('📦 Found data in meta.data:', response.meta.data);
            }
            if (response.meta?.ai_response) {
                console.log('📦 Found ai_response in meta:', response.meta.ai_response);
            }


            // Only process and display messages when:
            // 1. status is "success" or "completed" OR
            // 2. we have valid ai_response.data with structured fields (before callback completes)
            const hasAiResponseData = response.ai_response?.data &&
                (response.ai_response.data.reply || response.ai_response.data.summary || response.ai_response.data.sentiment);

            if (status === 'success' || status === 'completed' || hasAiResponseData) {
                // Extract AI response content from various possible locations
                // After callback, ModelRiver sends the data in different places:
                // 1. response.reply, response.summary etc. (direct from callback payload)
                // 2. response.ai_response.data (before callback)
                // 3. response.data (standard webhook)

                // Check if response itself has the structured fields directly
                const hasDirectFields = response.reply || response.summary || response.sentiment;

                let responseData;
                // Priority 1: Check ai_response.data first (this is where data comes before callback)
                if (response.ai_response?.data &&
                    (response.ai_response.data.reply || response.ai_response.data.summary || response.ai_response.data.sentiment)) {
                    responseData = response.ai_response.data;
                    console.log('📍 Using response.ai_response.data');
                }
                // Priority 2: Check meta.ai_response.data (might be in meta)
                else if (response.meta?.ai_response?.data &&
                    (response.meta.ai_response.data.reply || response.meta.ai_response.data.summary || response.meta.ai_response.data.sentiment)) {
                    responseData = response.meta.ai_response.data;
                    console.log('📍 Using response.meta.ai_response.data');
                }
                // Priority 3: Check meta.data 
                else if (response.meta?.data &&
                    (response.meta.data.reply || response.meta.data.summary || response.meta.data.sentiment)) {
                    responseData = response.meta.data;
                    console.log('📍 Using response.meta.data');
                }
                // Priority 4: Check if structured fields are directly on response (after callback)
                else if (hasDirectFields) {
                    responseData = response;
                    console.log('📍 Using response directly (callback payload)');
                }
                // Priority 5: Check response.data
                else if (response.data?.reply || response.data?.summary || response.data?.sentiment) {
                    responseData = response.data;
                    console.log('📍 Using response.data');
                }
                // Priority 6: Check message if it's an object with data
                else if (response.message && typeof response.message === 'object' &&
                    (response.message.reply || response.message.summary || response.message.sentiment)) {
                    responseData = response.message;
                    console.log('📍 Using response.message');
                }
                // Fallback
                else {
                    responseData = response.data;
                    console.log('📍 Using response.data as fallback');
                }

                console.log('📦 Extracted responseData:', responseData);

                // Skip if responseData is empty or invalid
                const hasValidData = responseData && Object.keys(responseData).length > 0 &&
                    (responseData.reply || responseData.summary || responseData.sentiment || responseData.choices);

                if (!hasValidData) {
                    console.log('⚠️ Skipping empty responseData');
                    return;
                }

                // Deduplicate: Skip if we already processed this channel_id
                const channelId = response.channel_id;
                if (channelId && processedChannelsRef.current.has(channelId)) {
                    console.log('⚠️ Skipping duplicate response for channel:', channelId);
                    return;
                }

                // Mark this channel as processed
                if (channelId) {
                    processedChannelsRef.current.add(channelId);
                    console.log('✅ Marking channel as processed:', channelId);
                }

                let aiContent;
                if (isStructured || (responseData && typeof responseData === 'object' && !responseData.choices && !Array.isArray(responseData))) {
                    // Structured output - format as JSON
                    aiContent = JSON.stringify(responseData, null, 2);
                } else {
                    // Unstructured output - extract from reply or choices
                    aiContent = responseData?.reply ||
                        responseData?.choices?.[0]?.message?.content ||
                        response.content ||
                        JSON.stringify(responseData);
                }

                // Extract usage and model info
                const usage = meta.usage || {};
                const model = meta.used_model || meta.model || null;

                // Add assistant message to chat only when status is success
                setMessages(prev => [...prev, {
                    id: Date.now(),
                    role: 'assistant',
                    content: aiContent,
                    timestamp: new Date().toISOString(),
                    meta: {
                        ...meta,
                        ...usage,
                        model,
                        channelId: response.channel_id,
                        isStructured: isStructured || (typeof responseData === 'object' && !responseData.choices && !Array.isArray(responseData))
                    },
                    steps: steps || []
                }]);

                setIsLoading(false);

                // If status is "completed" or "success", explicitly disconnect to prevent reconnection attempts
                // Both statuses indicate workflow completion
                if (status === 'completed' || status === 'success') {
                    console.log(`✅ Workflow completed (status: ${status}) - explicitly disconnecting to prevent reconnection`);
                    disconnect();
                    // Clear the connection guard
                    isConnectingRef.current = false;
                }
            } else if (status === 'error') {
                // Handle error status
                const errorMessage = response.error?.message || response.message || 'An error occurred';
                setError(errorMessage);
                setMessages(prev => [...prev, {
                    id: Date.now(),
                    role: 'assistant',
                    content: `❌ Error: ${errorMessage}`,
                    timestamp: new Date().toISOString(),
                    isError: true
                }]);
                setIsLoading(false);
                // Don't call disconnect() here - the client will handle connection cleanup
            } else if (status === 'pending') {
                // Keep loading state for pending status - typing indicator will show
                console.log('⏳ Response status is pending - showing typing indicator');
                // Don't set isLoading to false, keep it true to show typing indicator
            } else {
                // Unknown status - log and keep loading
                console.log('⚠️ Unknown response status:', status);
            }
        }
    }, [response]); // Removed disconnect from dependencies to prevent unnecessary re-renders

    // Handle ModelRiver errors
    useEffect(() => {
        if (modelRiverError) {
            setError(modelRiverError);
            setMessages(prev => [...prev, {
                id: Date.now(),
                role: 'assistant',
                content: `❌ Error: ${modelRiverError}`,
                timestamp: new Date().toISOString(),
                isError: true
            }]);
            setIsLoading(false);
        }
    }, [modelRiverError]);

    // Cleanup on unmount - use ref to avoid dependency issues
    const disconnectRef = useRef(disconnect);
    useEffect(() => {
        disconnectRef.current = disconnect;
    }, [disconnect]);

    useEffect(() => {
        return () => {
            // Only disconnect on actual unmount, not on every render
            disconnectRef.current();
        };
    }, []); // Empty dependency array - only run on unmount


    // ============================================
    // Send Message Handler
    // ============================================

    const sendMessage = async () => {
        if (!inputValue.trim() || isLoading) return

        const userMessage = inputValue.trim()
        setInputValue('')
        setError(null)
        setIsLoading(true)

        // Add user message to chat immediately
        setMessages(prev => [...prev, {
            id: Date.now(),
            role: 'user',
            content: userMessage,
            timestamp: new Date().toISOString()
        }])

        try {
            // Prevent multiple simultaneous connection attempts
            if (isConnectingRef.current) {
                console.log('⚠️ Connection already in progress, skipping...');
                return;
            }

            // Step 1: Send message to backend
            console.log('📤 Sending message to backend...')

            const backendResponse = await fetch(`${BACKEND_URL}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: userMessage,
                    ...(sessionId ? { session_id: sessionId } : {})
                })
            })

            if (!backendResponse.ok) {
                const errorData = await backendResponse.json()
                throw new Error(errorData.error || `HTTP ${backendResponse.status}`)
            }

            const data = await backendResponse.json()
            console.log('✅ Backend response:', data)

            if (sessionId && data.session_id && data.session_id !== sessionId) {
                throw new Error('ModelRiver returned a different session_id for this conversation')
            }

            if (data.session_id) {
                setSessionId(data.session_id)
            }

            // Step 2: Connect to the request's ModelRiver response channel
            const { channel_id, ws_token, websocket_url, websocket_channel } = data
            const resolvedWebSocketUrl = resolveWebSocketUrl(websocket_url)

            if (!channel_id || !ws_token || !websocket_url || !websocket_channel) {
                throw new Error('Missing WebSocket connection details from backend')
            }

            // Check if we have a completed response from a previous request
            // If so, reset the hook state before connecting to a new channel
            if (response && (response.status === 'completed' || response.meta?.status === 'completed')) {
                console.log('⚠️ Previous response is completed, resetting hook state before new connection');
                reset(); // Reset hook state to clear completed response
                // Small delay to ensure reset completes
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Disconnect any existing connection before connecting to a new one
            // This prevents multiple connections from accumulating
            // Only disconnect if we're currently connected or connecting
            if (isConnected || isConnecting) {
                console.log('🔌 Disconnecting existing connection before new connection');
                disconnect();
                // Small delay to ensure disconnect completes
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Set connection guard
            isConnectingRef.current = true;

            // Connect to the one-time response channel
            console.log('🔌 Connecting to new channel:', channel_id);
            connect({
                channelId: channel_id,
                wsToken: ws_token,
                websocketUrl: resolvedWebSocketUrl,
                websocketChannel: websocket_channel
            });

            // Reset connection guard after a short delay (connection should be initiated)
            setTimeout(() => {
                isConnectingRef.current = false;
            }, 500);

        } catch (err) {
            console.error('❌ Error sending message:', err)
            setError(err.message)
            setIsLoading(false)
        }
    }

    // ============================================
    // Handle Enter Key
    // ============================================

    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            sendMessage()
        }
    }

    const startNewConversation = () => {
        if (isLoading || isConnecting) return

        disconnect()
        reset()
        setMessages([])
        setInputValue('')
        setError(null)
        setSessionId(null)
        processedChannelsRef.current.clear()
        isConnectingRef.current = false
    }

    // ============================================
    // Render
    // ============================================

    return (
        <div className="chat-container">
            {/* Header */}
            <header className="chat-header">
                <div className="header-left">
                    <div className="brand-mark">
                        <Bot size={21} strokeWidth={2.3} />
                    </div>
                    <div className="brand-copy">
                        <h1>ModelRiver Assistant</h1>
                        <span>Session-aware AI chat</span>
                    </div>
                    <div className={`connection-status ${connectionState}`}>
                        <span className="status-dot"></span>
                        <span className="status-text">
                            {isConnecting ? 'Connecting...' :
                                isConnected ? 'Connected' :
                                    connectionState === 'error' ? 'Needs attention' : 'Ready'}
                        </span>
                    </div>
                </div>
                <div className="header-right">
                    {sessionId && (
                        <div className="session-badge session-active" title={devMode ? sessionId : 'Conversation memory is active'}>
                            <Database size={13} />
                            {devMode ? `Session ${sessionId.slice(0, 8)}…` : 'Memory active'}
                        </div>
                    )}
                    <button
                        type="button"
                        className="new-conversation-button"
                        onClick={startNewConversation}
                        disabled={isLoading || isConnecting || messages.length === 0}
                        title="Start a new conversation and session"
                    >
                        <MessageSquarePlus size={15} />
                        New conversation
                    </button>
                    <div className="dev-mode-control">
                        <span className="dev-mode-label">Dev Mode</span>
                        <label className="switch">
                            <input
                                type="checkbox"
                                checked={devMode}
                                onChange={(e) => setDevMode(e.target.checked)}
                            />
                            <span className="slider round"></span>
                        </label>
                    </div>
                </div>
            </header>

            {/* Messages */}
            <div className="messages-container">
                {messages.length === 0 ? (
                    <div className="empty-state">
                        <Bot size={44} strokeWidth={1.5} color="var(--text-muted)" />
                        <h3>Welcome to ModelRiver Chat</h3>
                        <p>Build real-time AI apps with a developer-first API interface that handles failover at scale.</p>
                    </div>
                ) : (
                    messages.map((message) => (
                        <div
                            key={message.id}
                            className={`message ${message.role}${message.isError ? ' error' : ''}`}
                        >
                            <div className="avatar">
                                {message.role === 'user' ? <User size={20} /> : message.isError ? <AlertCircle size={20} /> : <Bot size={20} />}
                            </div>
                            <div className="message-content">
                                <div className="message-meta">
                                    <span className="sender-name">{message.role === 'user' ? 'You' : 'ModelRiver'}</span>
                                    <span className="timestamp">{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                </div>

                                <div className="message-bubble">
                                    {message.role === 'assistant' && !message.isError ? (
                                        message.meta?.isStructured ? (
                                            // Structured output - show with StructuredResponse component
                                            <StructuredResponse data={message.content} />
                                        ) : (
                                            // Unstructured output - render as markdown
                                            <ReactMarkdown
                                                remarkPlugins={[remarkGfm]}
                                                components={{
                                                    code({ node, inline, className, children, ...props }) {
                                                        const match = /language-(\w+)/.exec(className || '')
                                                        return !inline && match ? (
                                                            <SyntaxHighlighter
                                                                style={vscDarkPlus}
                                                                language={match[1]}
                                                                PreTag="div"
                                                                {...props}
                                                            >
                                                                {String(children).replace(/\n$/, '')}
                                                            </SyntaxHighlighter>
                                                        ) : (
                                                            <code className={className} {...props}>
                                                                {children}
                                                            </code>
                                                        )
                                                    }
                                                }}
                                            >
                                                {message.content}
                                            </ReactMarkdown>
                                        )
                                    ) : (
                                        message.content
                                    )}
                                </div>

                                {devMode && (
                                    <div className="message-dev-info">
                                        <div className="message-metadata">
                                            <div className="metadata-badge">
                                                <Hash size={12} /> {(message.meta?.channelId || message.meta?.channel_id || "").slice(0, 8)}...
                                            </div>
                                            {message.meta?.model && (
                                                <div className="metadata-badge">
                                                    <Bot size={12} /> {message.meta.model}
                                                </div>
                                            )}
                                            {message.meta?.duration_ms && (
                                                <div className="metadata-badge">
                                                    <Clock size={12} /> {message.meta.duration_ms}ms
                                                </div>
                                            )}
                                            {message.meta?.isStructured && (
                                                <div className="metadata-badge">
                                                    <Database size={12} /> Structured Output
                                                </div>
                                            )}
                                        </div>

                                        {message.steps && message.steps.length > 0 && (
                                            <div className="workflow-steps">
                                                {message.steps.map((step, idx) => (
                                                    <div key={idx} className={`step-badge step-${step.status}`}>
                                                        {step.name}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))
                )}

                {/* Loading indicator - show when loading or when response status is pending */}
                {(isLoading || (response && (response.meta?.status === 'pending' || response.status === 'pending'))) && (
                    <div className="message assistant loading">
                        <div className="avatar">
                            <Loader2 size={18} className="animate-spin" />
                        </div>
                        <div className="message-content">
                            <div className="message-meta">
                                <span className="sender-name">ModelRiver</span>
                                <span className="timestamp">Thinking...</span>
                            </div>
                            <div className="message-bubble">
                                <div className="typing-indicator">
                                    <span className="dot"></span>
                                    <span className="dot"></span>
                                    <span className="dot"></span>
                                </div>

                                {/* Streaming Workflow Process */}
                                {steps && steps.length > 0 && (
                                    <div className="workflow-steps loading-steps">
                                        {steps.map((step, idx) => (
                                            <div key={idx} className={`step-badge step-${step.status}`}>
                                                {step.status === 'pending' && <Loader2 size={8} className="animate-spin inline-block mr-1" />}
                                                {step.name}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Error Display */}
            {error && (
                <div className="error-banner">
                    <div className="flex items-center gap-2">
                        <AlertCircle size={16} />
                        <span>{error}</span>
                    </div>
                    <button onClick={() => setError(null)}>✕</button>
                </div>
            )}

            {/* Input Area */}
            <div className="input-container">
                <div className="input-wrapper">
                    <textarea
                        className="chat-input"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder="Type your message..."
                        disabled={isLoading}
                        rows={Math.min(5, Math.max(1, inputValue.split('\n').length))}
                        autoComplete="off"
                        spellCheck="true"
                    />
                    <button
                        onClick={sendMessage}
                        disabled={isLoading || !inputValue.trim()}
                        className="send-button"
                    >
                        {isLoading ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
                    </button>
                </div>
                <div className="input-footer">
                    <span>Enter to send · Shift + Enter for a new line</span>
                    <span className={sessionId ? 'memory-state active' : 'memory-state'}>
                        <span className="memory-dot" />
                        {sessionId ? 'Conversation memory on' : 'A session starts with your first message'}
                    </span>
                </div>
            </div>
        </div>
    )
}

export default App
