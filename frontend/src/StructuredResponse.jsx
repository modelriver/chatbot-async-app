/**
 * StructuredResponse Component
 * 
 * Displays AI-generated structured responses in a user-friendly format
 * with sentiment indicators, confidence scores, topics, and action items.
 */

import React from 'react';
import './StructuredResponse.css';
import {
    CheckCircle2,
    AlertTriangle,
    Info,
    HelpCircle,
    TrendingUp,
    List,
    MessageSquare,
    FileText,
    Tag,
    Check
} from 'lucide-react';

const CONFIDENCE_LEVELS = {
    high: { score: 0.9, label: 'High confidence' },
    medium: { score: 0.65, label: 'Medium confidence' },
    moderate: { score: 0.65, label: 'Moderate confidence' },
    low: { score: 0.35, label: 'Low confidence' }
};

function normalizeConfidence(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const score = Math.min(1, Math.max(0, value > 1 ? value / 100 : value));
        return { score, label: `${Math.round(score * 100)}% confidence` };
    }

    if (typeof value !== 'string') return null;

    const normalized = value.trim().toLowerCase();
    if (CONFIDENCE_LEVELS[normalized]) return CONFIDENCE_LEVELS[normalized];

    const numericValue = Number(normalized.replace('%', ''));
    if (!Number.isFinite(numericValue)) return { score: null, label: value };

    const score = Math.min(1, Math.max(0, numericValue > 1 ? numericValue / 100 : numericValue));
    return { score, label: `${Math.round(score * 100)}% confidence` };
}

const StructuredResponse = ({ data }) => {
    let parsedData = data;
    if (typeof data === 'string') {
        try {
            parsedData = JSON.parse(data);
        } catch {
            return <div className="response-reply"><p>{data}</p></div>;
        }
    }

    // Extract the actual data object (it might be nested in response.data)
    const responseData = parsedData?.data || parsedData || {};

    const {
        summary,
        sentiment,
        confidence,
        topics = [],
        action_items = [],
        message, // The actual message content from the AI
        reply // The AI's reply/answer to the user's question
    } = responseData;
    const confidenceDisplay = normalizeConfidence(confidence);

    // Sentiment icon mapping
    const getSentimentIcon = (sentiment) => {
        const sentimentMap = {
            'positive': <CheckCircle2 size={24} className="text-emerald-400" />,
            'neutral': <Info size={24} className="text-blue-400" />,
            'negative': <AlertTriangle size={24} className="text-rose-400" />,
            'mixed': <HelpCircle size={24} className="text-amber-400" />
        };
        return sentimentMap[sentiment?.toLowerCase()] || <MessageSquare size={24} />;
    };

    // Confidence color mapping
    const getConfidenceColor = (score) => {
        if (score >= 0.8) return '#10b981'; // Emerald 500
        if (score >= 0.6) return '#f59e0b'; // Amber 500
        return '#ef4444'; // Red 500
    };

    return (
        <div className="structured-response">
            {/* Header with Sentiment and Confidence */}
            <div className="response-header">
                <div className="sentiment-indicator">
                    {getSentimentIcon(sentiment)}
                    <span className="sentiment-label">{sentiment || 'neutral'}</span>
                </div>
                {confidenceDisplay && (
                    <div className="confidence-indicator">
                        {confidenceDisplay.score !== null && (
                            <div className="confidence-bar-container" aria-hidden="true">
                                <div
                                    className="confidence-bar"
                                    style={{
                                        width: `${confidenceDisplay.score * 100}%`,
                                        backgroundColor: getConfidenceColor(confidenceDisplay.score)
                                    }}
                                />
                            </div>
                        )}
                        <span className="confidence-label">
                            <TrendingUp size={14} />
                            {confidenceDisplay.label}
                        </span>
                    </div>
                )}
            </div>

            {/* Reply - Main AI Response */}
            {reply && (
                <div className="response-reply">
                    <p>{reply}</p>
                </div>
            )}

            {/* Message Content */}
            {message && (
                <div className="response-message">
                    <h4><MessageSquare size={16} /> Status</h4>
                    <p>{message}</p>
                </div>
            )}

            {/* Summary */}
            {summary && (
                <div className="response-summary">
                    <h4><FileText size={16} /> Summary</h4>
                    <p>{summary}</p>
                </div>
            )}

            {/* Topics */}
            {topics.length > 0 && (
                <div className="response-topics">
                    <h4><Tag size={16} /> Topics</h4>
                    <div className="topics-list">
                        {topics.map((topic, index) => (
                            <span key={index} className="topic-tag">
                                {topic}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* Action Items */}
            {action_items.length > 0 && (
                <div className="response-actions">
                    <h4><List size={16} /> Action Items</h4>
                    <ul className="actions-list">
                        {action_items.map((item, index) => (
                            <li key={index} className={`action-item priority-${item.priority?.toLowerCase()}`}>
                                <div className="action-checkbox">
                                    <Check size={14} />
                                </div>
                                <span className="action-text">{item.task}</span>
                                <span className={`priority-badge ${item.priority?.toLowerCase()}`}>
                                    {item.priority}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};

export default StructuredResponse;
