/**
 * Chatbot Async App - Main React Component
 * 
 * This component provides a chat interface that:
 * 1. Sends messages to the backend (/chat endpoint)
 * 2. Receives WebSocket connection details
 * 3. Connects to ModelRiver WebSocket to receive AI responses using @modelriver/client
 * 
 * Data Flow:
 * User Message → Backend → ModelRiver → WebSocket → This Component
 */

import { useState, useRef, useEffect } from 'react'
import { useModelRiver } from '@modelriver/client/react'
import './App.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

// Backend API URL
const BACKEND_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

function App() {
    // ============================================
    // State
    // ============================================

    const [messages, setMessages] = useState([])
    const [inputValue, setInputValue] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState(null)
    const [devMode, setDevMode] = useState(false)

    // Refs
    const messagesEndRef = useRef(null)

    // ============================================
    // ModelRiver Client Hook
    // ============================================

    const {
        connect,
        disconnect,
        response,
        error: modelRiverError,
        isConnected,
        isConnecting,
        steps,
        connectionState
    } = useModelRiver({
        baseUrl: 'wss://api.modelriver.com/socket',
        persist: true,
        debug: false
    })

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
            const meta = response.meta || {};
            const status = meta.status || response.status || 'pending';
            const isStructured = meta.structured_output === true;
            
            console.log('📥 WebSocket response received:', { status, hasData: !!response.data });

            // Only process and display messages when status is "success" or "completed"
            // "completed" is used for event-driven workflows after callback
            // "success" is used for standard workflows
            if (status === 'success' || status === 'completed') {
                // Extract AI response content (handle both structured and unstructured output)
                let aiContent;
                if (isStructured || (response.data && typeof response.data === 'object' && !response.data.choices && !Array.isArray(response.data))) {
                    // Structured output - format as JSON
                    aiContent = JSON.stringify(response.data, null, 2);
                } else {
                    // Unstructured output - extract from choices
                    aiContent = response.data?.choices?.[0]?.message?.content ||
                        response.content ||
                        JSON.stringify(response.data);
                }

                // Extract usage and model info
                const usage = meta.usage || {};
                const model = meta.used_model || meta.model || 'unknown';

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
                        isStructured: isStructured || (typeof response.data === 'object' && !response.data.choices && !Array.isArray(response.data))
                    }
                }]);

                setIsLoading(false);
                // Don't call disconnect() here - the client will handle connection cleanup
                // Calling disconnect() here can cause issues with event-driven workflows
                // where the client needs to manage the connection lifecycle
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
    }, [response, disconnect]);

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

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            disconnect();
        }
    }, [disconnect])


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
            // Step 1: Send message to backend
            console.log('📤 Sending message to backend...')

            const response = await fetch(`${BACKEND_URL}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: userMessage
                })
            })

            if (!response.ok) {
                const errorData = await response.json()
                throw new Error(errorData.error || `HTTP ${response.status}`)
            }

            const data = await response.json()
            console.log('✅ Backend response:', data)

            // Step 2: Connect to ModelRiver WebSocket using the client SDK
            const { channel_id, ws_token, websocket_url, websocket_channel } = data

            if (!channel_id || !ws_token || !websocket_url || !websocket_channel) {
                throw new Error('Missing WebSocket connection details from backend')
            }

            // Connect using ModelRiver client
            connect({
                channelId: channel_id,
                wsToken: ws_token,
                websocketUrl: websocket_url,
                websocketChannel: websocket_channel
            })

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

    // ============================================
    // Render
    // ============================================

    return (
        <div className="chat-container">
            {/* Header */}
            <header className="chat-header">
                <div className="header-left">
                    <h1>💬 Chatbot Async App</h1>
                    <div className={`connection-status ${connectionState}`}>
                        <span className="status-dot"></span>
                        <span className="status-text">
                            {isConnecting ? 'Connecting...' :
                                isConnected ? 'Connected' :
                                    connectionState === 'error' ? 'Error' : 'Disconnected'}
                        </span>
                    </div>
                </div>
                <div className="header-right">
                    <label className="dev-mode-toggle">
                        <input
                            type="checkbox"
                            checked={devMode}
                            onChange={(e) => setDevMode(e.target.checked)}
                        />
                        <span className="slider"></span>
                        <span className="label-text">Dev Mode</span>
                    </label>
                </div>
            </header>

            {/* Messages */}
            <div className="messages-container">
                {messages.length === 0 ? (
                    <div className="empty-state">
                        <p>👋 Send a message to start chatting!</p>
                        <p className="hint">Your messages are processed through ModelRiver's async API</p>
                    </div>
                ) : (
                    messages.map((message) => (
                        <div
                            key={message.id}
                            className={`message ${message.role}${message.isError ? ' error' : ''}`}
                        >
                            <div className="message-avatar">
                                {message.role === 'user' ? '👤' : message.isError ? '⚠️' : '🤖'}
                            </div>
                            <div className="message-content">
                                <div className="message-text">
                                    {message.role === 'assistant' && !message.isError ? (
                                        message.meta?.isStructured ? (
                                            // Structured output - show as formatted JSON
                                            <pre className="structured-output">
                                                <code>{message.content}</code>
                                            </pre>
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
                                {devMode && message.meta && (
                                    <div className="message-metadata">
                                        <div className="meta-item">🆔 {message.meta.channelId?.slice(0, 8)}...</div>
                                        <div className="meta-item">🤖 {message.meta.model}</div>
                                        {message.meta.duration_ms && (
                                            <div className="meta-item">⏱️ {message.meta.duration_ms}ms</div>
                                        )}
                                        {message.meta.isStructured && (
                                            <div className="meta-item">📋 Structured Output</div>
                                        )}
                                    </div>
                                )}
                                {devMode && steps.length > 0 && (
                                    <div className="workflow-steps">
                                        {steps.map((step) => (
                                            <div key={step.id} className={`step step-${step.status}`}>
                                                {step.name} - {step.status}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div className="message-time">
                                    {new Date(message.timestamp).toLocaleTimeString()}
                                </div>
                            </div>
                        </div>
                    ))
                )}

                {/* Loading indicator - show when loading or when response status is pending */}
                {(isLoading || (response && (response.meta?.status === 'pending' || response.status === 'pending'))) && (
                    <div className="message assistant loading">
                        <div className="message-avatar">🤖</div>
                        <div className="message-content">
                            <div className="typing-indicator">
                                <span></span>
                                <span></span>
                                <span></span>
                            </div>
                            <div className="message-time">
                                {new Date().toLocaleTimeString()}
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Error Display */}
            {error && (
                <div className="error-banner">
                    ⚠️ {error}
                    <button onClick={() => setError(null)}>✕</button>
                </div>
            )}

            {/* Input Area */}
            <div className="input-container">
                <textarea
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder="Type your message..."
                    disabled={isLoading}
                    rows={Math.min(5, Math.max(1, inputValue.split('\n').length))}
                />
                <button
                    onClick={sendMessage}
                    disabled={isLoading || !inputValue.trim()}
                    className="send-button"
                >
                    {isLoading ? '⏳' : '📤'}
                </button>
            </div>
        </div>
    )
}

export default App
